import { useRef, useState } from 'react';
import { createSHA256 } from 'hash-wasm';
import { ApiError, json, messageOf, request } from './api';
import type { Track, Upload } from './types';
import { identity } from './utils';

type Phase = 'waiting' | 'hashing' | 'uploading' | 'done' | 'duplicate' | 'error' | 'paused';
export type UploadItem = { key: string; file: File; path: string; phase: Phase; progress: number; fingerprint?: string; uploadId?: string; track?: Track; trackId?: string; error?: string; replaceTrackId?: string; lyrics?: File; cover?: File };
const audioPattern = /\.(mp3|m4a|aac|flac|wav|ogg|opus|aif|aiff|wma|webm)$/i;
const pathOf = (file: File) => file.webkitRelativePath || file.name;
const stem = (path: string) => path.replace(/\.[^.]+$/, '').toLocaleLowerCase();

export function useUploads(refresh: () => Promise<void>, notify: (text: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [retained, setRetained] = useState<Upload[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const activeAbort = useRef<AbortController | null>(null);

  function add(files: File[]): void {
    const audio = files.filter(file => audioPattern.test(file.name));
    const covers = files.filter(file => /\.(png|jpe?g|webp)$/i.test(file.name));
    const lyrics = files.filter(file => /\.(lrc|txt)$/i.test(file.name));
    setItems(old => [...old, ...audio.filter(file => !old.some(item => item.path === pathOf(file) && item.file.size === file.size && item.file.lastModified === file.lastModified)).map(file => {
      const path = pathOf(file), directory = path.slice(0, path.lastIndexOf('/') + 1);
      return {
        key: identity(), file, path, phase: 'waiting' as const, progress: 0,
        lyrics: lyrics.find(sidecar => stem(pathOf(sidecar)) === stem(path)),
        cover: covers.find(sidecar => stem(pathOf(sidecar)) === stem(path)) || covers.find(sidecar => pathOf(sidecar).slice(0, pathOf(sidecar).lastIndexOf('/') + 1) === directory && /^(cover|folder|front)\./i.test(sidecar.name)),
      };
    })]);
    if (!audio.length) notify('请选择音频文件，或包含音频的文件夹。');
  }
  const update = (key: string, data: Partial<UploadItem>) => setItems(old => old.map(item => item.key === key ? { ...item, ...data } : item));
  async function inspect(): Promise<void> { try { setRetained((await request<{ uploads: Upload[] }>('/uploads')).uploads || []); } catch (error) { notify(messageOf(error)); } }
  function pause(): void { stop.current = true; activeAbort.current?.abort(); }
  async function start(): Promise<void> {
    if (running) return;
    if (items.some(item => item.replaceTrackId && !['done', 'duplicate'].includes(item.phase)) && !window.confirm('替换会更换所选曲目的音频原文件，保留收藏、歌单和听歌记录。继续上传？')) return;
    stop.current = false; setRunning(true);
    try {
      for (const item of items.filter(item => !['done', 'duplicate'].includes(item.phase))) {
        if (stop.current) break;
        const abort = new AbortController(); activeAbort.current = abort;
        try {
          let fingerprint = item.fingerprint;
          if (!fingerprint) {
            update(item.key, { phase: 'hashing', error: undefined, progress: 0 });
            const hash = await createSHA256(); hash.init();
            for (let offset = 0; offset < item.file.size; offset += 4 * 1024 * 1024) {
              if (stop.current) throw new DOMException('Paused', 'AbortError');
              hash.update(new Uint8Array(await item.file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()));
              update(item.key, { progress: Math.min(1, (offset + 4 * 1024 * 1024) / item.file.size) });
            }
            fingerprint = hash.digest(); update(item.key, { fingerprint });
          }
          const { upload } = await json<{ upload: Upload }>('/uploads', 'POST', { filename: item.file.name, relativePath: item.path, size: item.file.size, fingerprint });
          if (upload.duplicate && !item.replaceTrackId) {
            const existing = upload.trackId ? await request<{ track: Track }>(`/tracks/${encodeURIComponent(upload.trackId)}`).then(result => result.track) : undefined;
            update(item.key, { phase: 'duplicate', progress: 1, trackId: upload.trackId, track: existing }); continue;
          }
          update(item.key, { phase: 'uploading', uploadId: upload.id, progress: upload.offset / item.file.size });
          let offset = upload.offset;
          let conflicts = 0;
          while (offset < item.file.size) {
            if (stop.current) throw new DOMException('Paused', 'AbortError');
            const end = Math.min(item.file.size, offset + 8 * 1024 * 1024);
            try {
              const result = await request<{ upload: Upload }>(`/uploads/${encodeURIComponent(upload.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) }, body: item.file.slice(offset, end), signal: abort.signal });
              if (result.upload.offset <= offset) throw new Error('上传进度未更新，请重试。');
              offset = result.upload.offset; conflicts = 0;
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 409 || ++conflicts > 3) throw error;
              const authoritative = Number(error.data.offset ?? (error.data.upload as Upload | undefined)?.offset);
              if (!Number.isFinite(authoritative) || authoritative < 0 || authoritative > item.file.size) throw error;
              offset = authoritative;
            }
            update(item.key, { progress: offset / item.file.size });
          }
          const result = await json<{ track: Track; duplicate: boolean }>(`/uploads/${encodeURIComponent(upload.id)}/complete`, 'POST', item.replaceTrackId ? { replaceTrackId: item.replaceTrackId } : {});
          if (item.lyrics) await json(`/tracks/${encodeURIComponent(result.track.id)}`, 'PATCH', { lyricsText: await item.lyrics.text() });
          if (item.cover) { const form = new FormData(); form.append('file', item.cover); await request(`/tracks/${encodeURIComponent(result.track.id)}/cover`, { method: 'POST', body: form }); }
          update(item.key, { phase: result.duplicate ? 'duplicate' : 'done', progress: 1, track: result.track, trackId: result.track.id });
        } catch (error) {
          update(item.key, { phase: stop.current || (error instanceof DOMException && error.name === 'AbortError') ? 'paused' : 'error', error: stop.current ? undefined : messageOf(error) });
          if (stop.current) break;
        }
      }
      await refresh(); await inspect();
    } finally { activeAbort.current = null; setRunning(false); }
  }
  async function cancelRetained(id: string): Promise<void> {
    await request(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setRetained(old => old.filter(item => item.id !== id));
    notify('已取消未完成上传');
  }
  return {
    items, retained, running, add, start, pause, inspect, cancelRetained,
    replace: (key: string, id: string) => update(key, { replaceTrackId: id || undefined }),
    remove: (key: string) => { if (!running) setItems(old => old.filter(item => item.key !== key)); },
    clearDone: () => setItems(old => old.filter(item => !['done', 'duplicate'].includes(item.phase))),
  };
}
export type Uploader = ReturnType<typeof useUploads>;
