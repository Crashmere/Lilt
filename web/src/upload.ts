import { useEffect, useRef, useState } from 'react';
import { API, ApiError, messageOf, request } from './api';
import type { Playlist, Track, Upload } from './types';
import { UploadRateMeter } from './upload-rate';
import { identity } from './utils';

type Phase = 'waiting' | 'hashing' | 'uploading' | 'verifying' | 'joining' | 'applying' | 'done' | 'duplicate' | 'error' | 'paused';
export type UploadPlaylist = Pick<Playlist, 'id' | 'name'>;
export type UploadItem = {
  key: string; file: File; path: string; phase: Phase; progress: number; uploadedBytes: number; bytesPerSecond: number;
  fingerprint?: string; expectedFingerprint?: string; uploadId?: string; track?: Track; trackId?: string; error?: string;
  replaceTrackId?: string; lyrics?: File; cover?: File; lyricsApplied?: boolean; coverApplied?: boolean; duplicate?: boolean; retrying?: boolean; awaitingAck?: boolean;
  playlist?: UploadPlaylist; playlistApplied?: boolean;
};
const CHUNK_SIZE = 32 * 1024 * 1024;
const audioPattern = /\.(mp3|m4a|aac|flac|wav|ogg|opus|aif|aiff|wma|webm|ape|wv|tta|dsf)$/i;
const pathOf = (file: File) => file.webkitRelativePath || file.name;
const stem = (path: string) => path.replace(/\.[^.]+$/, '').toLocaleLowerCase();
const finished = (item: UploadItem) => ['done', 'duplicate'].includes(item.phase);
const transferProgress = (bytes: number, size: number) => 0.05 + 0.9 * bytes / size;

function validateSidecars(item: UploadItem): void {
  if (item.lyrics && item.lyrics.size > 1024 ** 2) throw new Error('歌词不能超过 1 MiB，请移出此项后重新选择。');
}

function hashFile(file: File, signal: AbortSignal, progress: (value: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    const finish = (settle: () => void) => { worker.terminate(); signal.removeEventListener('abort', abort); settle(); };
    const abort = () => finish(() => reject(signal.reason));
    worker.onmessage = event => {
      if (event.data.hash) finish(() => resolve(event.data.hash));
      else if (event.data.error) finish(() => reject(new Error(event.data.error)));
      else progress(Number(event.data.progress));
    };
    worker.onerror = event => finish(() => reject(new Error(event.message)));
    signal.addEventListener('abort', abort, { once: true });
    worker.postMessage(file);
  });
}

function sendChunk(item: UploadItem, offset: number, signal: AbortSignal, update: (data: Partial<UploadItem>) => void): Promise<Upload> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const chunk = item.file.slice(offset, offset + CHUNK_SIZE);
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', `${API}/uploads/${encodeURIComponent(item.uploadId!)}`);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.timeout = 660000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Upload-Offset', String(offset));
    const meter = new UploadRateMeter(bytesPerSecond => update({ bytesPerSecond }));
    const abort = () => xhr.abort();
    const finish = (settle: () => void) => {
      meter.stop();
      signal.removeEventListener('abort', abort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = xhr.upload.onload = null;
      settle();
    };
    xhr.upload.onprogress = event => {
      if (signal.aborted) return;
      const sent = Math.min(chunk.size, event.loaded);
      meter.update(sent);
      // Sent bytes animate progress; only the response advances uploadedBytes.
      update({ progress: transferProgress(offset + sent, item.file.size) });
    };
    xhr.upload.onload = () => { meter.stop(); if (!signal.aborted) update({ awaitingAck: true, progress: transferProgress(offset + chunk.size, item.file.size) }); };
    xhr.onload = () => {
      const data = xhr.response || {};
      finish(() => xhr.status >= 200 && xhr.status < 300 ? resolve(data.upload) : reject(new ApiError(xhr.status, data, xhr.status === 401 ? '设备授权已失效，请重新打开服务。' : data.error || `上传失败（${xhr.status}）`)));
    };
    xhr.onerror = () => finish(() => reject(new TypeError('无法连接，请检查网络后重试。')));
    xhr.ontimeout = () => finish(() => reject(new DOMException('分片上传超时，请重试。', 'TimeoutError')));
    xhr.onabort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    try { xhr.send(chunk); }
    catch (error) { finish(() => reject(error)); }
  });
}

function validate(upload: Upload, item: UploadItem): void {
  if (!upload || !upload.id || upload.size !== item.file.size || upload.fingerprint !== item.fingerprint || !['uploading', 'complete'].includes(upload.status)
    || !Number.isInteger(upload.offset) || upload.offset < 0 || upload.offset > item.file.size) throw new Error('服务器返回了无效的续传信息。');
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(signal.reason); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function useUploads(refresh: () => Promise<void>, notify: (text: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const [retained, setRetained] = useState<Upload[]>([]);
  const [inspectError, setInspectError] = useState('');
  const [running, setRunning] = useState(false);
  const active = useRef(false);
  const stopped = useRef(false);
  const current = useRef<{ key: string; abort: AbortController } | null>(null);

  const publish = () => setItems([...queue.current]);
  function update(item: UploadItem, data: Partial<UploadItem>): void { Object.assign(item, data); publish(); }
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (active.current) event.preventDefault(); };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); stopped.current = true; current.current?.abort.abort(); };
  }, []);

  function add(files: File[], resume?: Upload, playlist?: UploadPlaylist): void {
    const audio = files.filter(file => audioPattern.test(file.name) || /^audio\//.test(file.type));
    if (resume && (audio.length !== 1 || audio[0].size !== resume.size)) { notify('请选择与未完成上传大小相同的原音频文件。'); return; }
    const covers = files.filter(file => /\.(png|jpe?g|webp)$/i.test(file.name));
    const lyrics = files.filter(file => /\.(lrc|txt)$/i.test(file.name));
    const seen = new Set(queue.current.map(item => JSON.stringify([item.path, item.file.size, item.file.lastModified, item.expectedFingerprint, item.playlist?.id])));
    let skipped = 0;
    for (const file of audio) {
      if (!file.size || file.size > 64 * 1024 ** 3) { skipped++; continue; }
      const path = pathOf(file);
      const key = JSON.stringify([path, file.size, file.lastModified, resume?.fingerprint, playlist?.id]);
      if (seen.has(key)) continue;
      queue.current.push({ key: identity(), file, path, phase: stopped.current ? 'paused' : 'waiting', progress: 0, uploadedBytes: 0, bytesPerSecond: 0, expectedFingerprint: resume?.fingerprint, playlist });
      seen.add(key);
    }
    for (const item of queue.current.filter(item => !finished(item) && !item.trackId && current.current?.key !== item.key)) {
      const directory = item.path.slice(0, item.path.lastIndexOf('/') + 1);
      item.lyrics = lyrics.find(file => stem(pathOf(file)) === stem(item.path)) || item.lyrics;
      item.cover = covers.find(file => stem(pathOf(file)) === stem(item.path)) || covers.find(file => pathOf(file).slice(0, pathOf(file).lastIndexOf('/') + 1) === directory && /^(cover|folder|front)\./i.test(file.name)) || item.cover;
    }
    publish();
    if (skipped) notify(`已跳过 ${skipped} 个空文件或超过 64 GiB 的音频。`);
    else if (!audio.length && !covers.length && !lyrics.length) notify('请选择音频文件，或包含音频的文件夹。');
  }
  async function inspect(): Promise<void> {
    try { setRetained((await request<{ uploads: Upload[] }>('/uploads')).uploads || []); setInspectError(''); }
    catch (error) { setInspectError(messageOf(error)); }
  }
  function pause(key?: string): void {
    if (!key) stopped.current = true;
    queue.current.filter(item => (!key || item.key === key) && ['waiting', 'hashing', 'uploading', 'verifying', 'joining', 'applying'].includes(item.phase)).forEach(item => { item.phase = 'paused'; item.bytesPerSecond = 0; item.retrying = false; item.awaitingAck = false; item.progress = item.fingerprint ? transferProgress(item.uploadedBytes, item.file.size) : 0; });
    if (!key || current.current?.key === key) current.current?.abort.abort();
    publish();
  }

  async function transfer(item: UploadItem, signal: AbortSignal): Promise<void> {
    const change = (data: Partial<UploadItem>) => update(item, data);
    const json = <T,>(path: string, method: string, data: unknown) => request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(660000)]) });
    if (!item.fingerprint) {
      change({ phase: 'hashing', progress: 0 });
      const fingerprint = await hashFile(item.file, signal, progress => change({ progress: progress * 0.05 }));
      signal.throwIfAborted();
      change({ fingerprint });
    }
    if (item.expectedFingerprint && item.expectedFingerprint !== item.fingerprint) throw new Error('所选文件与待续传音频不同，请移出此项后选择正确的原文件。');
    const prepare = async () => {
      const { upload } = await json<{ upload: Upload }>('/uploads', 'POST', { filename: item.file.name, relativePath: item.path, size: item.file.size, fingerprint: item.fingerprint, replaceTrackId: item.replaceTrackId });
      validate(upload, item);
      change({ uploadId: upload.id, uploadedBytes: upload.offset, progress: transferProgress(upload.offset, item.file.size) });
      return upload;
    };
    // Keep publication receipts so playlist or sidecar retries do not reupload audio.
    if (!item.trackId) {
      if (!item.uploadId || item.uploadedBytes < item.file.size) {
        let upload = await prepare();
        if (upload.duplicate && !item.replaceTrackId) {
          const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(upload.trackId!)}`, { signal });
          change({ trackId: upload.trackId, track: result.track, duplicate: true });
        } else {
          validateSidecars(item);
          change({ phase: 'uploading' });
          let offset = upload.offset;
          let failures = 0;
          while (offset < item.file.size) {
            signal.throwIfAborted();
            change({ awaitingAck: false, retrying: false });
            try {
              upload = await sendChunk(item, offset, signal, change);
              validate(upload, item);
              if (upload.offset <= offset) throw new Error('服务器未确认已接收的分片。');
              offset = upload.offset;
              failures = 0;
            } catch (error) {
              change({ bytesPerSecond: 0, awaitingAck: false, progress: transferProgress(offset, item.file.size) });
              signal.throwIfAborted();
              const conflict = error instanceof ApiError && error.status === 409;
              const transient = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' || error instanceof ApiError && [408, 429, 500, 502, 503, 504].includes(error.status);
              if ((!conflict && !transient) || ++failures > 3) throw error;
              change({ retrying: true });
              if (!conflict) await delay(1000 * 2 ** (failures - 1), signal);
              upload = await prepare();
              offset = upload.offset;
            }
            change({ uploadedBytes: offset, progress: transferProgress(offset, item.file.size) });
          }
        }
      }
      if (!item.trackId) {
        signal.throwIfAborted();
        change({ phase: 'verifying', progress: 0.95, awaitingAck: false, retrying: false });
        const result = await json<{ track: Track; duplicate: boolean }>(`/uploads/${encodeURIComponent(item.uploadId!)}/complete`, 'POST', item.replaceTrackId ? { replaceTrackId: item.replaceTrackId } : {});
        change({ track: result.track, trackId: result.track.id, duplicate: result.duplicate });
      }
    }
    if (item.playlist && !item.playlistApplied && !item.track?.deletedAt) {
      signal.throwIfAborted();
      change({ phase: 'joining', progress: 0.97 });
      await json(`/playlists/${encodeURIComponent(item.playlist.id)}`, 'PUT', { addTrackIds: [item.trackId] });
      change({ playlistApplied: true });
    }
    if (!item.duplicate || item.replaceTrackId) {
      validateSidecars(item);
      signal.throwIfAborted();
      change({ phase: 'applying', progress: 0.98 });
      const metadata = item.lyrics && !item.lyricsApplied ? { lyricsText: await item.lyrics.text() } : {};
      if (item.cover && !item.coverApplied) {
        const form = new FormData(); form.append('file', item.cover); form.append('metadata', JSON.stringify(metadata));
        const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(item.trackId!)}/cover`, { method: 'POST', body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(660000)]) });
        change({ track: result.track, coverApplied: true, lyricsApplied: true });
      } else if (item.lyrics && !item.lyricsApplied) {
        const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(item.trackId!)}`, 'PATCH', metadata);
        change({ track: result.track, lyricsApplied: true });
      }
    }
    change({ phase: item.duplicate ? 'duplicate' : 'done', progress: 1, bytesPerSecond: 0 });
  }

  async function run(): Promise<void> {
    if (active.current) return;
    active.current = true; setRunning(true);
    let changed = false;
    try {
      while (!stopped.current) {
        const item = queue.current.find(item => item.phase === 'waiting');
        if (!item) break;
        const abort = new AbortController(); current.current = { key: item.key, abort };
        update(item, { phase: item.trackId ? 'applying' : item.fingerprint ? 'uploading' : 'hashing', error: undefined, retrying: false });
        try { await transfer(item, abort.signal); }
        catch (error) {
          if (!['paused', 'waiting'].includes(item.phase)) update(item, { phase: abort.signal.aborted ? 'paused' : 'error', error: abort.signal.aborted ? undefined : item.trackId ? `音频已入库，${item.phase === 'joining' ? '加入歌单' : '歌词或封面'}未完成：${messageOf(error)}` : messageOf(error) });
        } finally {
          if (item.trackId) changed = true;
          update(item, { bytesPerSecond: 0, retrying: false, awaitingAck: false });
          current.current = null;
        }
      }
    } finally {
      active.current = false; setRunning(false);
      if (changed) await refresh();
      await inspect();
    }
  }

  function start(key?: string): void {
    const selected = queue.current.filter(item => (!key || item.key === key) && !finished(item) && (!active.current || ['paused', 'error', 'waiting'].includes(item.phase)));
    if (selected.some(item => item.replaceTrackId && !item.trackId) && !window.confirm('替换会更换所选曲目的音频原文件，保留收藏、歌单和听歌记录。继续上传？')) return;
    stopped.current = false;
    selected.forEach(item => { item.phase = 'waiting'; item.error = undefined; });
    publish();
    void run();
  }
  async function cancelRetained(id: string): Promise<boolean> {
    try {
      await request(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setRetained(old => old.filter(item => item.id !== id));
      notify('已丢弃未完成上传，已入库音乐不受影响');
      return true;
    } catch (error) { notify(messageOf(error)); await inspect(); return false; }
  }
  return {
    items, retained, inspectError, running, add, start, pause, inspect, cancelRetained,
    replace: (key: string, id: string) => { const item = queue.current.find(item => item.key === key); if (item && !active.current && !item.trackId) update(item, { replaceTrackId: id || undefined, uploadId: undefined }); },
    remove: (key: string) => { pause(key); queue.current = queue.current.filter(item => item.key !== key); publish(); },
    clearDone: () => { queue.current = queue.current.filter(item => !finished(item)); publish(); },
  };
}
export type Uploader = ReturnType<typeof useUploads>;
