import { useEffect, useEffectEvent, useState } from 'react';
import { streamURL } from './api';
import type { Track } from './types';

const FILE_LIMIT = 128 * 1024 * 1024;
const PCM_LIMIT = 96 * 1024 * 1024;
const SAMPLE_RATE = 12000;
const PEAK_CACHE_LIMIT = 12;
const peakCache = new Map<string, number[]>();
type AudioState = { phase: 'loading' | 'ready' | 'fallback' | 'error'; progress: number; wave: 'pending' | 'ready' | 'fallback'; peaks?: number[]; message?: string };

function peakKey(track: Track): string {
  return track.audioVersion ? `${track.id}:${track.audioVersion}` : '';
}

function readCachedPeaks(track: Track): number[] | undefined {
  const key = peakKey(track);
  if (!key) return undefined;
  const hit = peakCache.get(key);
  if (!hit) return undefined;
  peakCache.delete(key);
  peakCache.set(key, hit);
  return hit;
}

export function cacheWaveformPeaks(track: Track, peaks: number[]): void {
  const key = peakKey(track);
  if (!key || !peaks.length) return;
  peakCache.delete(key);
  peakCache.set(key, peaks);
  while (peakCache.size > PEAK_CACHE_LIMIT) {
    const oldest = peakCache.keys().next().value;
    if (oldest !== undefined) peakCache.delete(oldest);
  }
}

function editorReady(worker: ServiceWorker, url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ready: boolean) => { clearTimeout(timer); channel.port1.close(); signal.removeEventListener('abort', cancel); resolve(ready); };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(false), 1500);
    channel.port1.onmessage = event => finish(event.data?.ready === true);
    signal.addEventListener('abort', cancel, { once: true });
    worker.postMessage({ type: 'lilt-audio-editor', url }, [channel.port2]);
  });
}

export function useWorkbenchAudio(track: Track, onSource: (track: Track, url?: string) => void) {
  const [state, setState] = useState<AudioState>(() => {
    const cached = readCachedPeaks(track);
    return { phase: 'loading', progress: 0, wave: cached ? 'ready' : 'pending', peaks: cached };
  });
  const [retry, setRetry] = useState(0);
  const publish = useEffectEvent(onSource);
  useEffect(() => {
    const abort = new AbortController();
    let source: string | undefined, peaksWorker: Worker | undefined, worker: ServiceWorker | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
    const cachedPeaks = readCachedPeaks(track);
    const pulse = () => worker?.postMessage({ type: 'lilt-audio-editor', url: streamURL(track, true) });
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(new DOMException('Audio download stalled', 'TimeoutError')), 45000); };
    setState({ phase: 'loading', progress: 0, wave: cachedPeaks ? 'ready' : 'pending', peaks: cachedPeaks });
    async function load() {
      if (!track.audioVersion || track.size > FILE_LIMIT) {
        setState({ phase: 'fallback', progress: 0, wave: cachedPeaks ? 'ready' : 'fallback', peaks: cachedPeaks, message: '大文件使用流式试听' });
        return;
      }
      try {
        worker = navigator.serviceWorker?.controller || undefined;
        const shared = worker && await editorReady(worker, streamURL(track, true), abort.signal);
        abort.signal.throwIfAborted();
        if (shared) {
          heartbeat = setInterval(pulse, 2000);
          document.addEventListener('visibilitychange', pulse);
          if (retry) worker?.postMessage({ type: 'lilt-audio-reset', url: streamURL(track, true) });
        } else worker = undefined;
        resetIdle();
        const response = await fetch(streamURL(track, !!shared), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(response.status === 401 ? '设备授权已失效，请重新打开服务' : '预加载失败，可继续流式试听'); }
        const size = Number(response.headers.get('Content-Length'));
        if (response.headers.get('ETag') !== `"${track.audioVersion}-original"`) { await response.body?.cancel(); throw new Error('音频已变更，请重新打开工作台'); }
        if (!size || size > FILE_LIMIT) { await response.body?.cancel(); throw new Error('音频过大，请使用流式试听'); }
        const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0, reported = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > size) throw new Error('音频长度已变更，请重新打开工作台');
            chunks.push(value); resetIdle();
            if (Date.now() - reported >= 180) {
              setState(old => ({ ...old, phase: 'loading', progress: received / size }));
              reported = Date.now();
            }
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        clearTimeout(idle);
        abort.signal.throwIfAborted();
        if (received !== size) throw new Error('音频未加载完整，请重试');
        const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || track.mimeType });
        chunks.length = 0;
        source = URL.createObjectURL(blob); publish(track, source);
        if (cachedPeaks) {
          setState({ phase: 'ready', progress: 1, wave: 'ready', peaks: cachedPeaks });
          return;
        }
        setState({ phase: 'ready', progress: 1, wave: 'pending' });
        try {
          if (track.duration * SAMPLE_RATE * Math.max(1, track.channels) * 4 > PCM_LIMIT) throw new Error('Audio exceeds waveform decode budget');
          const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
          const audio = await context.decodeAudioData(await blob.arrayBuffer());
          abort.signal.throwIfAborted();
          if (audio.length * audio.numberOfChannels * 4 > PCM_LIMIT) throw new Error('Audio exceeds waveform decode budget');
          const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
          peaksWorker = new Worker(new URL('./lyric-peaks.worker.ts', import.meta.url), { type: 'module' });
          const peaks = await new Promise<number[]>((resolve, reject) => {
            const cancel = () => reject(abort.signal.reason);
            abort.signal.addEventListener('abort', cancel, { once: true });
            peaksWorker!.onmessage = event => { abort.signal.removeEventListener('abort', cancel); resolve(Array.from(event.data as Float32Array)); };
            peaksWorker!.onerror = () => { abort.signal.removeEventListener('abort', cancel); reject(new Error('Waveform calculation failed')); };
            peaksWorker!.postMessage({ channels }, channels.map(channel => channel.buffer));
          });
          cacheWaveformPeaks(track, peaks);
          if (!abort.signal.aborted) setState({ phase: 'ready', progress: 1, wave: 'ready', peaks });
        } catch { if (!abort.signal.aborted) setState({ phase: 'ready', progress: 1, wave: 'fallback' }); }
        finally { peaksWorker?.terminate(); }
      } catch (error) {
        if (abort.signal.aborted && abort.signal.reason?.name !== 'TimeoutError') return;
        setState(old => ({ ...old, phase: 'error', progress: 0, wave: old.peaks ? 'ready' : 'fallback', message: error instanceof Error && !(error instanceof TypeError) && !(error instanceof DOMException) ? error.message : '预加载中断，请重试或继续流式试听' }));
      } finally { clearTimeout(idle); }
    }
    void load();
    return () => {
      abort.abort(); clearTimeout(idle); clearInterval(heartbeat); peaksWorker?.terminate();
      document.removeEventListener('visibilitychange', pulse);
      worker?.postMessage({ type: 'lilt-audio-editor', url: '' });
      publish(track); if (source) URL.revokeObjectURL(source);
    };
  }, [track.id, track.audioVersion, retry]);
  return { ...state, retry: () => setRetry(value => value + 1) };
}
