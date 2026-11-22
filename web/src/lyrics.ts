import { useEffect, useEffectEvent, useLayoutEffect, useState } from 'react';
import { messageOf, read } from './api';
import type { Track } from './types';
import type { LyricLine } from './utils';

export function useActiveLyric(lines: LyricLine[], position: number, getPosition: () => number, playing: boolean): number {
  function at(time: number): number {
    let index = lines.length - 1;
    while (index >= 0 && lines[index].time > time) index--;
    return index;
  }
  const [current, setCurrent] = useState(() => at(position));
  const synchronize = useEffectEvent(() => { setCurrent(at(getPosition())); });
  const timed = lines.length > 0;

  useLayoutEffect(() => { synchronize(); }, [lines, position]);
  useEffect(() => {
    let frame = 0;
    const sample = () => {
      frame = 0;
      synchronize();
      // Read the media clock, never elapsed wall time: buffering and suspension must not advance lyrics.
      if (timed && playing && document.visibilityState === 'visible') frame = requestAnimationFrame(sample);
    };
    const resume = () => { cancelAnimationFrame(frame); sample(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    resume();
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', resume); window.removeEventListener('pageshow', resume); };
  }, [playing, timed]);

  return current;
}

type LyricsContent = { trackId: string; version: string; text: string };
type LyricsState = LyricsContent & { loading: boolean; error: string };

const cached = new Map<string, LyricsContent>();
const pending = new Map<string, { promise: Promise<LyricsContent>; abort: AbortController; users: number }>();
let cachedBytes = 0;
const versionOf = (track: Track) => track.lyricsVersion || track.updatedAt;

function remember(content: LyricsContent): void {
  const previous = cached.get(content.trackId);
  if (previous) { cachedBytes -= previous.text.length * 2; cached.delete(content.trackId); }
  if (content.text.length * 2 > 2 * 1024 * 1024) return;
  cached.set(content.trackId, content); cachedBytes += content.text.length * 2;
  while (cached.size > 32 || cachedBytes > 2 * 1024 * 1024) {
    const first = cached.values().next().value!;
    cached.delete(first.trackId); cachedBytes -= first.text.length * 2;
  }
}

function knownText(track: Track | undefined): string | undefined {
  if (!track || !track.hasLyrics) return '';
  if (track.lyricsText !== undefined) return track.lyricsText;
  const content = cached.get(track.id);
  if (content?.version === versionOf(track)) {
    cached.delete(track.id); cached.set(track.id, content);
    return content.text;
  }
}

function acquire(track: Track) {
  const version = versionOf(track);
  const key = `${track.id}:${version}`;
  let attempt = pending.get(key);
  if (!attempt) {
    const abort = new AbortController();
    const promise = read<{ lyricsText: string; updatedAt: string; lyricsVersion?: string }>(`/tracks/${encodeURIComponent(track.id)}/lyrics`, abort.signal, 90000).then(result => {
      if (typeof result.lyricsText !== 'string' || typeof result.updatedAt !== 'string') throw new TypeError('歌词响应不完整，请重试。');
      const content = { trackId: track.id, version: track.lyricsVersion ? result.lyricsVersion || result.updatedAt : result.updatedAt, text: result.lyricsText };
      remember(content);
      return content;
    }).finally(() => { if (pending.get(key)?.abort === abort) pending.delete(key); });
    attempt = { promise, abort, users: 0 };
    pending.set(key, attempt);
  }
  const owned = attempt;
  owned.users++;
  return {
    promise: owned.promise,
    release: () => {
      if (--owned.users === 0 && pending.get(key) === owned) { pending.delete(key); owned.abort.abort(); }
    },
  };
}

export function useLyrics(track: Track | undefined) {
  const [state, setState] = useState<LyricsState>();
  const [retry, setRetry] = useState(0);
  const trackId = track?.id;
  const version = track ? versionOf(track) : undefined;

  useEffect(() => {
    if (!track) return;
    const known = knownText(track);
    const content = { trackId: track.id, version: versionOf(track), text: known || '' };
    if (known !== undefined) {
      setState({ ...content, loading: false, error: '' });
      return;
    }
    const attempt = acquire(track);
    let canceled = false;
    setState({ ...content, loading: true, error: '' });

    async function load() {
      try {
        const result = await attempt.promise;
        if (canceled) return;
        setState({ ...content, text: result.text, loading: false, error: '' });
      } catch (error) {
        if (canceled) return;
        setState({ ...content, loading: false, error: messageOf(error) });
      }
    }
    void load();
    return () => { canceled = true; attempt.release(); };
  }, [trackId, version, retry]);

  const current = state?.trackId === trackId && state?.version === version ? state : undefined;
  const known = knownText(track);
  return {
    text: known ?? current?.text ?? '',
    loading: known === undefined && (current?.loading ?? true),
    error: current?.error || '',
    reload: () => setRetry(value => value + 1),
  };
}
