import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ApiError, json, trackURL } from './api';
import { getCached, peekCached, recordHistory } from './storage';
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
  const deviceId = readLocal<string>('lilt.device-id', identity());
  writeLocal('lilt.device-id', deviceId);
  return readLocal<PlayerState>('lilt.player', {
    deviceId, label: /iPhone|Android/.test(navigator.userAgent) ? '手机浏览器' : '电脑浏览器',
    trackId: '', position: 0, queueIds: [], queueIndex: 0, shuffle: false, repeat: 'off', volume: 0.8, updatedAt: '',
  });
}

export function usePlayer(tracks: Track[], notify: (text: string) => void) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [snapshot, setSnapshot] = useState(initialState);
  const [position, setPosition] = useState(snapshot.position || 0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [actual, setActual] = useState({ bitrate: 0, cached: false });
  const [conflict, setConflict] = useState(false);
  const tabId = useRef(identity());
  const intent = useRef({ play: false, position: snapshot.position || 0 });
  const session = useRef<Session>({ id: identity(), trackId: '', seconds: 0, lastPosition: snapshot.position || 0 });
  const source = useRef({ trackId: '', url: '', objectURL: '' });
  const initialSeekPending = useRef(false);
  const pendingStart = useRef<{ ids: string[]; index: number; start: number } | null>(null);
  const trackId = snapshot.queueIds[snapshot.queueIndex] || '';
  const track = tracks.find(item => item.id === trackId);
  const queue = snapshot.queueIds.map(id => tracks.find(item => item.id === id)).filter((item): item is Track => !!item);

  function playbackError(id: string): string {
    if (!navigator.onLine) {
      const cached = peekCached(id);
      if (cached && cached.quality !== 'original') return '此曲目未保存原件，请联网后重新保存离线。';
      if (!cached) return '此歌曲尚未保存到离线列表。';
    }
    return '原件无法播放，请重试或使用支持该格式的浏览器。';
  }

  function prepareSource(nextTrack: Track, start: number, autoplay: boolean): void {
    const audio = audioRef.current;
    if (!audio) return;
    const entry = !navigator.onLine ? peekCached(nextTrack.id) : undefined;
    const cached = entry?.quality === 'original' ? entry : undefined;
    const url = cached ? URL.createObjectURL(cached.blob) : trackURL(nextTrack.id, 'stream?quality=original');
    if (source.current.objectURL) URL.revokeObjectURL(source.current.objectURL);
    source.current = { trackId: nextTrack.id, url, objectURL: cached ? url : '' };
    if (session.current.trackId !== nextTrack.id) session.current = { id: identity(), trackId: nextTrack.id, seconds: 0, lastPosition: start };
    intent.current = { play: autoplay, position: start };
    initialSeekPending.current = true;
    setActual({ bitrate: cached?.bitrate || nextTrack.bitrate, cached: !!cached });
    setLoading(true);
    setSourceVersion(value => value + 1);
    audio.volume = snapshot.volume;
    audio.src = url;
    audio.load();
    if (autoplay) void audio.play().catch(error => {
      if (error.name !== 'AbortError' && source.current.url === url) { intent.current.play = false; setLoading(false); notify(playbackError(nextTrack.id)); }
    });
  }

  function claim(takeover = false): boolean {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (!takeover && lease && lease.tabId !== tabId.current && lease.playing && Date.now() - lease.updatedAt < 9000) { setConflict(true); return false; }
    writeLocal('lilt.playback-lease', { tabId: tabId.current, updatedAt: Date.now(), playing: true });
    setConflict(false);
    return true;
  }

  function sourceModeChanged(id: string): boolean {
    return navigator.onLine ? !!source.current.objectURL : !source.current.objectURL && peekCached(id)?.quality === 'original';
  }

  function releaseLease(): void {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.tabId === tabId.current) writeLocal('lilt.playback-lease', { ...lease, playing: false, updatedAt: Date.now() });
  }

  const persist = useEffectEvent((remote = false) => {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.playing && lease.tabId !== tabId.current && Date.now() - lease.updatedAt < 9000) return;
    const state: PlayerState = { ...snapshot, trackId, position: audioRef.current?.currentTime || position, updatedAt: new Date().toISOString() };
    writeLocal('lilt.player', state);
    if (remote && navigator.onLine) void json(`/player-states/${encodeURIComponent(snapshot.deviceId)}`, 'PUT', state).catch(() => undefined);
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
    setSnapshot(old => ({ ...old, queueIds, queueIndex: nextIndex, position: start, trackId: queueIds[nextIndex] }));
    setPosition(start);
    session.current = { id: identity(), trackId: queueIds[nextIndex], seconds: 0, lastPosition: start };
    if (trackId === queueIds[nextIndex] && audioRef.current?.src && !sourceModeChanged(queueIds[nextIndex])) {
      audioRef.current.currentTime = start;
      if (autoplay) void audioRef.current.play().catch(() => notify('无法开始播放，请再次点击播放。'));
      else audioRef.current.pause();
    } else { const nextTrack = tracks.find(item => item.id === queueIds[nextIndex]); if (nextTrack) prepareSource(nextTrack, start, autoplay); }
  }

  function play(takeover = false): void {
    if (takeover && pendingStart.current) { const pending = pendingStart.current; begin(pending.ids, pending.index, pending.start, true, true); return; }
    if (!trackId || !audioRef.current?.src) { if (tracks.length) begin(tracks.map(item => item.id), 0, 0, true, takeover); return; }
    if (!claim(takeover)) return;
    if (audioRef.current.ended) { session.current = { id: identity(), trackId, seconds: 0, lastPosition: 0 }; seek(0); }
    if (track && sourceModeChanged(trackId)) {
      const start = Number.isFinite(audioRef.current.currentTime) ? audioRef.current.currentTime : position;
      prepareSource(track, start, true);
      return;
    }
    intent.current.play = true;
    void audioRef.current.play().catch(() => notify(playbackError(trackId)));
  }
  function pause(): void { intent.current.play = false; audioRef.current?.pause(); releaseLease(); persist(true); }
  function seek(value: number): void {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(value, Number.isFinite(audio.duration) ? audio.duration : track?.duration || value));
    intent.current.position = next;
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
  function setLabel(label: string): void { setSnapshot(old => ({ ...old, label: label.trim() || old.label })); }
  function continueFrom(state: PlayerState): void {
    const ids = state.queueIds.filter(id => tracks.some(item => item.id === id));
    const index = Math.max(0, ids.indexOf(state.trackId));
    begin(ids, index, state.position, true);
  }

  const onCanPlay = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (initialSeekPending.current) {
      const start = Math.min(intent.current.position, Number.isFinite(audio.duration) ? audio.duration : intent.current.position);
      if (Math.abs(audio.currentTime - start) > 0.2) audio.currentTime = start;
      session.current.lastPosition = start; initialSeekPending.current = false;
    }
    setLoading(false);
    if (intent.current.play && audio.paused && claim()) void audio.play().catch(() => { intent.current.play = false; notify('点击播放以继续。'); });
  });
  const onTime = useEffectEvent(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const delta = audio.currentTime - session.current.lastPosition;
    if (!audio.paused && !audio.seeking && delta > 0) session.current.seconds += delta;
    session.current.lastPosition = audio.currentTime;
    setPosition(audio.currentTime);
    if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch { /* Some browsers expose only partial Media Session support. */ }
    }
  });
  const onPlay = useEffectEvent(() => { setPlaying(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  const onPause = useEffectEvent(() => {
    setPlaying(false); finish(); persist(true);
    releaseLease();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  const onEnded = useEffectEvent(() => { finish(true); next(true); });
  const onError = useEffectEvent(() => {
    intent.current.play = false;
    audioRef.current?.pause();
    releaseLease();
    setLoading(false); setPlaying(false); notify(playbackError(trackId));
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlers = { loadedmetadata: onCanPlay, timeupdate: onTime, play: onPlay, pause: onPause, ended: onEnded, error: onError };
    for (const [event, handler] of Object.entries(handlers)) audio.addEventListener(event, handler);
    return () => { for (const [event, handler] of Object.entries(handlers)) audio.removeEventListener(event, handler); };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !trackId || !track) { if (audio) { audio.pause(); audio.removeAttribute('src'); } source.current.trackId = ''; return; }
    let cancelled = false;
    const abort = new AbortController();
    if (source.current.trackId !== trackId) prepareSource(track, intent.current.position, intent.current.play);
    void (async () => {
      const currentSource = source.current;
      if (currentSource.objectURL) return;
      const url = currentSource.url;
      try {
        if (!navigator.onLine) throw new TypeError('offline');
        const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) throw new ApiError(response.status, {}, response.status === 401 ? '设备授权已失效，请重新打开服务。' : '音频暂时无法加载。');
        if (!cancelled && source.current.url === url) setActual({ bitrate: Number(response.headers.get('X-Lilt-Bitrate')) || track.bitrate, cached: false });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) { audio.pause(); throw error; }
        const cached = await getCached(trackId).catch(() => undefined);
        if (cancelled) return;
        if (cached && cached.quality !== 'original') throw new Error('此曲目未保存原件，请联网后重新保存离线。');
        if (!cached) throw error;
        const objectURL = URL.createObjectURL(cached.blob);
        if (source.current.objectURL) URL.revokeObjectURL(source.current.objectURL);
        source.current = { ...currentSource, url: objectURL, objectURL };
        initialSeekPending.current = true;
        setActual({ bitrate: cached.bitrate, cached: true });
        audio.src = objectURL; audio.load();
        if (intent.current.play) void audio.play().catch(() => notify('点击播放以继续。'));
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: track.coverUrl ? [{ src: new URL(track.coverUrl, location.origin).href }] : [] });
      }
    })().catch(error => { if (!cancelled) { setLoading(false); notify(error instanceof Error && error.message !== 'offline' ? error.message : '此歌曲尚未保存到离线列表。'); } });
    return () => { cancelled = true; abort.abort(); };
  }, [trackId, !!track, sourceVersion]);

  const mediaPlay = useEffectEvent(() => play());
  const mediaPause = useEffectEvent(() => pause());
  const mediaPrevious = useEffectEvent(() => previous());
  const mediaNext = useEffectEvent(() => next());
  const mediaSeek = useEffectEvent((details: MediaSessionActionDetails) => seek(details.seekTime ?? position));
  const mediaBack = useEffectEvent((details: MediaSessionActionDetails) => seek(position - (details.seekOffset || 10)));
  const mediaForward = useEffectEvent((details: MediaSessionActionDetails) => seek(position + (details.seekOffset || 10)));
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = { play: mediaPlay, pause: mediaPause, previoustrack: mediaPrevious, nexttrack: mediaNext, seekto: mediaSeek, seekbackward: mediaBack, seekforward: mediaForward };
    for (const [action, handler] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler!); } catch { /* Unsupported actions remain ordinary player controls. */ } }
    return () => { for (const action of Object.keys(handlers)) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null); } catch {} } };
  }, []);

  const heartbeat = useEffectEvent(() => {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (playing && lease?.tabId === tabId.current) writeLocal('lilt.playback-lease', { ...lease, updatedAt: Date.now() });
    if (!lease?.playing || lease.tabId === tabId.current) persist();
  });
  const remoteHeartbeat = useEffectEvent(() => { if (playing) { persist(true); finish(); } });
  const onStorage = useEffectEvent((event: StorageEvent) => {
    if (event.key !== 'lilt.playback-lease' || !playing) return;
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.playing && lease.tabId !== tabId.current) { pause(); notify('已在另一个标签页继续播放'); }
  });
  const leave = useEffectEvent(() => { finish(); pause(); });
  useEffect(() => {
    const tick = setInterval(heartbeat, 2000);
    const remote = setInterval(remoteHeartbeat, 15000);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', leave);
    return () => { clearInterval(tick); clearInterval(remote); window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', leave); };
  }, []);
  useEffect(() => () => { if (source.current.objectURL) URL.revokeObjectURL(source.current.objectURL); }, []);
  useEffect(() => { persist(true); }, [snapshot]);
  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: track.coverUrl ? [{ src: new URL(track.coverUrl, location.origin).href }] : [] });
  }, [track?.title, track?.artist, track?.album, track?.coverUrl]);

  return {
    audioRef, snapshot, track, trackId, queue, position, playing, loading, actual,
    conflict, setConflict,
    begin, play, pause, seek, next, previous, enqueue, reorder, remove, setVolume, setLabel, continueFrom,
    toggleShuffle: () => setSnapshot(old => {
      if (old.shuffle || !old.queueIds.length) return { ...old, shuffle: !old.shuffle };
      return { ...old, shuffle: true, queueIds: [old.queueIds[old.queueIndex], ...shuffledIds(old.queueIds.filter((_, index) => index !== old.queueIndex))], queueIndex: 0 };
    }),
    toggleRepeat: () => setSnapshot(old => ({ ...old, repeat: old.repeat === 'off' ? 'all' : old.repeat === 'all' ? 'one' : 'off' })),
    clear: () => { pause(); setSnapshot(old => ({ ...old, queueIds: [], queueIndex: 0, trackId: '', position: 0 })); },
  };
}
export type Player = ReturnType<typeof usePlayer>;
