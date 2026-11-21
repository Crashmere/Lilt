import { useEffect, useState } from 'react';
import { messageOf, read } from './api';
import type { Track } from './types';

type LyricsContent = { trackId: string; version: string; text: string };
type LyricsState = LyricsContent & { loading: boolean; error: string };

const cached = new Map<string, LyricsContent>();
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
    const abort = new AbortController();
    setState({ ...content, loading: true, error: '' });

    async function load() {
      try {
        const result = await read<{ lyricsText: string; updatedAt: string; lyricsVersion?: string }>(`/tracks/${encodeURIComponent(content.trackId)}/lyrics`, abort.signal, 90000);
        if (abort.signal.aborted) return;
        if (typeof result.lyricsText !== 'string' || typeof result.updatedAt !== 'string') throw new TypeError('歌词响应不完整，请重试。');
        remember({ trackId: content.trackId, version: track!.lyricsVersion ? result.lyricsVersion || result.updatedAt : result.updatedAt, text: result.lyricsText });
        setState({ ...content, text: result.lyricsText, loading: false, error: '' });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ ...content, loading: false, error: messageOf(error) });
      }
    }
    void load();
    return () => { abort.abort(); };
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
