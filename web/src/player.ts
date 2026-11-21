import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { isTransient, trackURL } from './api';
import { recordHistory } from './storage';
import type { PlayerState, Track } from './types';
import { identity, readLocal, writeLocal } from './utils';

type Session = { id: string; trackId: string; seconds: number; lastPosition: number };
type Lease = { tabId: string; updatedAt: number; playing: boolean };

function shuffledIds(ids: string[]): string[] {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index--) { const other = Math.floor(Math.random() * (index + 1)); [result[index], result[other]] = [result[other], result[index]]; }
  return result;
}
function initialState(): PlayerState {
  return readLocal<PlayerState>('lilt.player', {
    trackId: '', position: 0, queueIds: [], queueIndex: 0, shuffle: false, repeat: 'off', volume: 0.8, updatedAt: '',
  });
}

export function usePlayer(tracks: Track[], notify: (text: string) => void) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [snapshot, setSnapshot] = useState(initialState);
  const [position, setPosition] = useState(snapshot.position || 0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playRequested, setPlayRequested] = useState(false);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [failure, setFailure] = useState('');
  const [conflict, setConflict] = useState(false);
  const tabId = useRef(identity());
  const intent = useRef({ play: false, position: snapshot.position || 0 });
  const session = useRef<Session>({ id: identity(), trackId: '', seconds: 0, lastPosition: snapshot.position || 0 });
  const source = useRef({ trackId: '', url: '' });
  const initialSeekPending = useRef(false);
  const sourceAbort = useRef(new AbortController());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retries = useRef(0);
  const lastProgress = useRef(Date.now());
  const recoveryPosition = useRef(0);
  const pendingStart = useRef<{ ids: string[]; index: number; start: number } | null>(null);
  const trackId = snapshot.queueIds[snapshot.queueIndex] || '';
  const track = tracks.find(item => item.id === trackId);
  const queue = snapshot.queueIds.map(id => tracks.find(item => item.id === id)).filter((item): item is Track => !!item);

  function playbackError(): string {
    if (!navigator.onLine) return '当前无法连接，请联网后重试播放。';
    return '原件无法播放，请重试或使用支持该格式的浏览器。';
  }

  function cancelRecovery(reset = true): void {
    clearTimeout(retryTimer.current); retryTimer.current = undefined;
    sourceAbort.current.abort(); sourceAbort.current = new AbortController();
    if (reset) retries.current = 0;
  }

  function failPlayback(message: string): void {
    intent.current.play = false; setPlayRequested(false);
    cancelRecovery(); audioRef.current?.pause(); releaseLease();
    setLoading(false); setPlaying(false); setFailure(message); notify(message);
  }

  function tryPlay(): void {
    const audio = audioRef.current;
    if (!audio) return;
    const signal = sourceAbort.current.signal;
    void audio.play().catch(error => {
      if (signal.aborted || !intent.current.play || error.name === 'AbortError' || error.name === 'NotSupportedError') return;
      failPlayback(error.name === 'NotAllowedError' ? '点击播放以继续。' : playbackError());
    });
  }

  function prepareSource(nextTrack: Track, start: number, autoplay: boolean, recovering = false): void {
    const audio = audioRef.current;
    if (!audio) return;
    const url = trackURL(nextTrack.id, 'stream?quality=original');
    cancelRecovery(!recovering);
    source.current = { trackId: nextTrack.id, url };
    if (session.current.trackId !== nextTrack.id) session.current = { id: identity(), trackId: nextTrack.id, seconds: 0, lastPosition: start };
    intent.current = { play: autoplay, position: start };
    setPlayRequested(autoplay); setFailure(''); setBufferedEnd(0);
    initialSeekPending.current = true;
    lastProgress.current = Date.now(); recoveryPosition.current = start;
    setLoading(true);
    audio.volume = snapshot.volume;
    audio.preload = autoplay ? 'auto' : 'metadata';
    audio.src = url;
    audio.load();
    if (autoplay) tryPlay();
  }

  function retryPlayback(immediate = false): void {
    const audio = audioRef.current;
    if (!audio || !track || !intent.current.play || retryTimer.current !== undefined) return;
    setLoading(true);
    if (!navigator.onLine) return;
    if (retries.current >= 3) { failPlayback('播放未恢复，请点击播放重试。'); return; }
    const attempt = retries.current++;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      if (!intent.current.play || source.current.trackId !== track.id) return;
      const start = initialSeekPending.current ? intent.current.position : audio.currentTime;
      prepareSource(track, start, true, true);
    }, immediate ? 0 : 1000 * 2 ** attempt);
  }

  function claim(takeover = false): boolean {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (!takeover && lease && lease.tabId !== tabId.current && lease.playing && Date.now() - lease.updatedAt < 9000) { setConflict(true); return false; }
    writeLocal('lilt.playback-lease', { tabId: tabId.current, updatedAt: Date.now(), playing: true });
    setConflict(false);
    return true;
  }

  function releaseLease(): void {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.tabId === tabId.current) writeLocal('lilt.playback-lease', { ...lease, playing: false, updatedAt: Date.now() });
  }

  const persist = useEffectEvent(() => {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.playing && lease.tabId !== tabId.current && Date.now() - lease.updatedAt < 9000) return;
    const state: PlayerState = { ...snapshot, trackId, position: initialSeekPending.current ? intent.current.position : audioRef.current?.currentTime ?? position, updatedAt: new Date().toISOString() };
    writeLocal('lilt.player', state);
  });
  const finish = useEffectEvent((completed = false) => {
    const current = session.current;
    if (current.trackId && current.seconds > 0) recordHistory({ trackId: current.trackId, sessionId: current.id, seconds: Math.floor(current.seconds), completed });
  });

  function begin(ids: string[], index = 0, start = 0, autoplay = true, takeover = false): void {
    if (!ids.length) return;
    if (autoplay && !claim(takeover)) { pendingStart.current = { ids, index, start }; return; }
    pendingStart.current = null;
    finish();
    let nextIndex = Math.max(0, Math.min(index, ids.length - 1));
    let queueIds = [...ids];
    if (snapshot.shuffle) { queueIds = [ids[nextIndex], ...shuffledIds(ids.filter((_, i) => i !== nextIndex))]; nextIndex = 0; }
    intent.current = { play: autoplay, position: Math.max(0, start) };
    setPlayRequested(autoplay); cancelRecovery(); setFailure('');
    setSnapshot(old => ({ ...old, queueIds, queueIndex: nextIndex, position: start, trackId: queueIds[nextIndex] }));
    setPosition(start);
    session.current = { id: identity(), trackId: queueIds[nextIndex], seconds: 0, lastPosition: start };
    if (trackId === queueIds[nextIndex] && audioRef.current?.src && !audioRef.current.error) {
      audioRef.current.currentTime = start;
      if (autoplay) tryPlay();
      else audioRef.current.pause();
    } else { const nextTrack = tracks.find(item => item.id === queueIds[nextIndex]); if (nextTrack) prepareSource(nextTrack, start, autoplay); }
  }

  function play(takeover = false): void {
    if (takeover && pendingStart.current) { const pending = pendingStart.current; begin(pending.ids, pending.index, pending.start, true, true); return; }
    if (!trackId || !audioRef.current?.src) { if (tracks.length) begin(tracks.map(item => item.id), 0, 0, true, takeover); return; }
    if (!claim(takeover)) return;
    cancelRecovery(); setFailure(''); setPlayRequested(true);
    if (audioRef.current.error || failure) {
      if (track) prepareSource(track, initialSeekPending.current ? intent.current.position : audioRef.current.currentTime, true);
      return;
    }
    if (audioRef.current.ended) { session.current = { id: identity(), trackId, seconds: 0, lastPosition: 0 }; seek(0); }
    intent.current.play = true;
    audioRef.current.preload = 'auto'; lastProgress.current = Date.now();
    setLoading(audioRef.current.readyState < 3); tryPlay();
  }
  function pause(): void { intent.current.play = false; setPlayRequested(false); setLoading(false); cancelRecovery(); audioRef.current?.pause(); releaseLease(); persist(); }
  function seek(value: number): void {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(value, Number.isFinite(audio.duration) ? audio.duration : track?.duration || value));
    intent.current.position = next;
    lastProgress.current = Date.now();
    session.current.lastPosition = next;
    audio.currentTime = next;
    setPosition(next);
    persist();
  }
  const next = useEffectEvent((automatic = false) => {
    if (!snapshot.queueIds.length) return;
    if (automatic && snapshot.repeat === 'one') { session.current = { id: identity(), trackId, seconds: 0, lastPosition: 0 }; seek(0); play(); return; }
    if (!claim()) return;
    let index = snapshot.queueIndex + 1;
    let queueIds = snapshot.queueIds;
    if (index >= snapshot.queueIds.length) {
      if (snapshot.repeat !== 'all') { pause(); return; }
      if (snapshot.shuffle) queueIds = shuffledIds(snapshot.queueIds);
      index = 0;
    }
    finish(automatic);
    intent.current = { play: true, position: 0 };
    setPlayRequested(true);
    setPosition(0);
    session.current = { id: identity(), trackId: queueIds[index], seconds: 0, lastPosition: 0 };
    setSnapshot(old => ({ ...old, queueIds, queueIndex: index, position: 0 }));
    if (queueIds[index] === trackId) { seek(0); play(); }
    else { const nextTrack = tracks.find(item => item.id === queueIds[index]); if (nextTrack) prepareSource(nextTrack, 0, true); }
  });
  function previous(): void {
    if (position > 3) { seek(0); return; }
    if (!claim()) return;
    const index = Math.max(0, snapshot.queueIndex - 1);
    finish(); session.current = { id: identity(), trackId: snapshot.queueIds[index], seconds: 0, lastPosition: 0 };
    setSnapshot(old => ({ ...old, queueIndex: index, position: 0 })); setPosition(0);
    const previousTrack = tracks.find(item => item.id === snapshot.queueIds[index]); if (previousTrack) prepareSource(previousTrack, 0, true);
  }
  function enqueue(ids: string[], nextUp = false): void {
    if (!snapshot.queueIds.length) { begin(ids, 0, 0, false); return; }
    setSnapshot(old => {
      const nextIds = [...old.queueIds];
      nextIds.splice(nextUp ? old.queueIndex + 1 : nextIds.length, 0, ...ids);
      return { ...old, queueIds: nextIds };
    });
    notify(nextUp ? '已设为下一首' : '已加入播放队列');
  }
  function reorder(from: number, to: number): void {
    setSnapshot(old => {
      const entries = old.queueIds.map((id, index) => ({ id, current: index === old.queueIndex }));
      const [entry] = entries.splice(from, 1);
      entries.splice(to, 0, entry);
      return { ...old, queueIds: entries.map(item => item.id), queueIndex: entries.findIndex(item => item.current) };
    });
  }
  function remove(index: number): void {
    if (index === snapshot.queueIndex) {
      const ids = snapshot.queueIds.filter((_, i) => i !== index);
      if (!ids.length) { pause(); setSnapshot(old => ({ ...old, queueIds: [], queueIndex: 0, trackId: '', position: 0 })); }
      else begin(ids, Math.min(index, ids.length - 1), 0, playing);
    } else setSnapshot(old => ({ ...old, queueIds: old.queueIds.filter((_, i) => i !== index), queueIndex: index < old.queueIndex ? old.queueIndex - 1 : old.queueIndex }));
  }
  function setVolume(volume: number): void { setSnapshot(old => ({ ...old, volume })); if (audioRef.current) audioRef.current.volume = volume; }

  const onCanPlay = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio || audio.readyState < 1) return;
    if (initialSeekPending.current) {
      const start = Math.min(intent.current.position, Number.isFinite(audio.duration) ? audio.duration : intent.current.position);
      if (Math.abs(audio.currentTime - start) > 0.2) audio.currentTime = start;
      session.current.lastPosition = start; initialSeekPending.current = false;
    }
    setLoading(intent.current.play && audio.readyState < 3);
    if (intent.current.play && audio.readyState >= 3 && audio.paused && claim()) tryPlay();
  });
  const onProgress = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio) return;
    lastProgress.current = Date.now();
    let end = audio.currentTime;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= audio.currentTime + 0.1 && audio.buffered.end(i) >= audio.currentTime) end = audio.buffered.end(i);
    }
    setBufferedEnd(end);
  });
  const onWaiting = useEffectEvent(() => { if (intent.current.play) setLoading(true); });
  const onPlaying = useEffectEvent(() => { lastProgress.current = Date.now(); setLoading(false); setFailure(''); });
  const onTime = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio || initialSeekPending.current) return;
    const delta = audio.currentTime - session.current.lastPosition;
    if (!audio.paused && !audio.seeking && delta > 0) {
      session.current.seconds += delta; lastProgress.current = Date.now();
      if (audio.currentTime - recoveryPosition.current >= 5) retries.current = 0;
    }
    session.current.lastPosition = audio.currentTime;
    setPosition(audio.currentTime);
    if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch { /* Some browsers expose only partial Media Session support. */ }
    }
  });
  const onPlay = useEffectEvent(() => { if (!intent.current.play) { audioRef.current?.pause(); return; } setPlaying(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  const onPause = useEffectEvent(() => {
    const audio = audioRef.current;
    if (intent.current.play && !initialSeekPending.current && !audio?.error && !audio?.ended && retryTimer.current === undefined) {
      intent.current.play = false; setPlayRequested(false); setLoading(false); cancelRecovery();
    }
    setPlaying(false); finish(); persist();
    if (!intent.current.play) releaseLease();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  const onEnded = useEffectEvent(() => { finish(true); next(true); });
  const onError = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio || !audio.error || audio.error.code === 1) return;
    setPlaying(false);
    if (!intent.current.play) { setLoading(false); setFailure(playbackError()); return; }
    if (audio.error.code === 3) { failPlayback(playbackError()); return; }
    const code = audio.error.code;
    setLoading(true);
    const signal = sourceAbort.current.signal;
    void (async () => {
      try {
        const response = await fetch(source.current.url, { method: 'HEAD', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        if (signal.aborted || !intent.current.play) return;
        if (response.status === 401) { failPlayback('设备授权已失效，请重新打开服务。'); return; }
        if (response.status === 404) { failPlayback('曲目已不可用，请选择其他曲目。'); return; }
        const mime = response.headers.get('Content-Type')?.split(';')[0];
        if (response.ok && code === 4 && mime && !audio.canPlayType(mime)) { failPlayback(playbackError()); return; }
        if (!response.ok && ![408, 429, 500, 502, 503, 504].includes(response.status)) { failPlayback(playbackError()); return; }
        retryPlayback();
      } catch (error) {
        if (signal.aborted || !intent.current.play) return;
        if (isTransient(error)) retryPlayback(); else failPlayback(playbackError());
      }
    })();
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlers = { loadedmetadata: onCanPlay, canplay: onCanPlay, seeked: onCanPlay, progress: onProgress, playing: onPlaying, waiting: onWaiting, seeking: onWaiting, timeupdate: onTime, play: onPlay, pause: onPause, ended: onEnded, error: onError };
    for (const [event, handler] of Object.entries(handlers)) audio.addEventListener(event, handler);
    return () => { for (const [event, handler] of Object.entries(handlers)) audio.removeEventListener(event, handler); };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !trackId || !track) { pause(); if (audio) { audio.removeAttribute('src'); audio.load(); } source.current.trackId = ''; setBufferedEnd(0); return; }
    if (source.current.trackId !== trackId) prepareSource(track, intent.current.position, intent.current.play);
    return () => { cancelRecovery(); };
  }, [trackId, !!track]);

  const mediaPlay = useEffectEvent(() => play());
  const mediaPause = useEffectEvent(() => pause());
  const mediaPrevious = useEffectEvent(() => previous());
  const mediaNext = useEffectEvent(() => next());
  const mediaSeek = useEffectEvent((details: MediaSessionActionDetails) => seek(details.seekTime ?? position));
  const mediaBack = useEffectEvent((details: MediaSessionActionDetails) => seek(position - (details.seekOffset || 10)));
  const mediaForward = useEffectEvent((details: MediaSessionActionDetails) => seek(position + (details.seekOffset || 10)));
  const onPlaybackKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input:not([type="range"]), textarea, select, [role="textbox"]'))) return;
    if (event.shiftKey && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    switch (event.key) {
      case ' ':
        if (!queue.length) return;
        event.preventDefault();
        if (!event.repeat) { if (playing || intent.current.play) pause(); else play(); }
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!track) return;
        event.preventDefault();
        if (event.shiftKey) {
          if (!event.repeat) { if (event.key === 'ArrowLeft') previous(); else next(); }
        } else seek((audioRef.current?.currentTime ?? position) + (event.key === 'ArrowLeft' ? -5 : 5));
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        setVolume(Math.max(0, Math.min(1, snapshot.volume + (event.key === 'ArrowUp' ? 0.05 : -0.05))));
        break;
    }
  });
  useEffect(() => {
    // Capture before focused buttons and ranges perform their native key actions.
    document.addEventListener('keydown', onPlaybackKey, true);
    return () => document.removeEventListener('keydown', onPlaybackKey, true);
  }, []);
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = { play: mediaPlay, pause: mediaPause, previoustrack: mediaPrevious, nexttrack: mediaNext, seekto: mediaSeek, seekbackward: mediaBack, seekforward: mediaForward };
    for (const [action, handler] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler!); } catch { /* Unsupported actions remain ordinary player controls. */ } }
    return () => { for (const action of Object.keys(handlers)) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null); } catch {} } };
  }, []);

  const heartbeat = useEffectEvent(() => {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (intent.current.play && lease?.tabId === tabId.current) writeLocal('lilt.playback-lease', { ...lease, updatedAt: Date.now() });
    if (!lease?.playing || lease.tabId === tabId.current) persist();
    const audio = audioRef.current;
    if (intent.current.play && audio && audio.readyState < 3 && document.visibilityState === 'visible' && Date.now() - lastProgress.current > 45000) retryPlayback();
  });
  const historyHeartbeat = useEffectEvent(() => { if (playing) finish(); });
  const onStorage = useEffectEvent((event: StorageEvent) => {
    if (event.key !== 'lilt.playback-lease' || !intent.current.play) return;
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.playing && lease.tabId !== tabId.current) { pause(); notify('已在另一个标签页继续播放'); }
  });
  const leave = useEffectEvent(() => { finish(); pause(); });
  const reconnect = useEffectEvent(() => { if (intent.current.play && audioRef.current && (audioRef.current.error || audioRef.current.readyState < 3)) { retries.current = 0; retryPlayback(true); } });
  const visible = useEffectEvent(() => { lastProgress.current = Date.now(); });
  useEffect(() => {
    const tick = setInterval(heartbeat, 2000);
    const historyTick = setInterval(historyHeartbeat, 15000);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', leave);
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', visible);
    return () => { cancelRecovery(); clearInterval(tick); clearInterval(historyTick); window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', leave); window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => { persist(); }, [snapshot]);
  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: track.coverUrl ? [{ src: new URL(track.coverUrl, location.origin).href }] : [] });
  }, [track?.title, track?.artist, track?.album, track?.coverUrl]);

  return {
    audioRef, snapshot, track, trackId, queue, position, playing, loading, playRequested, bufferedEnd, failure,
    conflict, setConflict,
    begin, play, pause, seek, next, previous, enqueue, reorder, remove, setVolume,
    toggleShuffle: () => setSnapshot(old => {
      if (old.shuffle || !old.queueIds.length) return { ...old, shuffle: !old.shuffle };
      return { ...old, shuffle: true, queueIds: [old.queueIds[old.queueIndex], ...shuffledIds(old.queueIds.filter((_, index) => index !== old.queueIndex))], queueIndex: 0 };
    }),
    toggleRepeat: () => setSnapshot(old => ({ ...old, repeat: old.repeat === 'off' ? 'all' : old.repeat === 'all' ? 'one' : 'off' })),
    clear: () => { pause(); setSnapshot(old => ({ ...old, queueIds: [], queueIndex: 0, trackId: '', position: 0 })); },
  };
}
export type Player = ReturnType<typeof usePlayer>;
