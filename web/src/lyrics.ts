import { useEffect, useState } from 'react';
import { messageOf, read } from './api';
import type { Track } from './types';

type LyricsContent = { trackId: string; updatedAt: string; text: string };
type LyricsState = LyricsContent & { loading: boolean; error: string };

// Retain only the latest successful result across panel close/reopen.
let cached: LyricsContent | undefined;

function knownText(track: Track | undefined): string | undefined {
  if (!track || !track.hasLyrics) return '';
  if (track.lyricsText !== undefined) return track.lyricsText;
  if (cached?.trackId === track.id && cached.updatedAt === track.updatedAt) return cached.text;
}

export function useLyrics(track: Track | undefined) {
  const [state, setState] = useState<LyricsState>();
  const [retry, setRetry] = useState(0);
  const trackId = track?.id;
  const updatedAt = track?.updatedAt;

  useEffect(() => {
    if (!track) return;
    const known = knownText(track);
    const content = { trackId: track.id, updatedAt: track.updatedAt, text: known || '' };
    if (known !== undefined) {
      setState({ ...content, loading: false, error: '' });
      return;
    }
    const abort = new AbortController();
    setState({ ...content, loading: true, error: '' });

    async function load() {
      try {
        const result = await read<{ lyricsText: string; updatedAt: string }>(`/tracks/${encodeURIComponent(content.trackId)}/lyrics`, abort.signal, 90000);
        if (abort.signal.aborted) return;
        if (typeof result.lyricsText !== 'string' || typeof result.updatedAt !== 'string') throw new TypeError('歌词响应不完整，请重试。');
        cached = { trackId: content.trackId, updatedAt: result.updatedAt, text: result.lyricsText };
        setState({ ...content, text: cached.text, loading: false, error: '' });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ ...content, loading: false, error: messageOf(error) });
      }
    }
    void load();
    return () => { abort.abort(); };
  }, [trackId, updatedAt, retry]);

  const current = state?.trackId === trackId && state?.updatedAt === updatedAt ? state : undefined;
  const known = knownText(track);
  return {
    text: known ?? current?.text ?? '',
    loading: known === undefined && (current?.loading ?? true),
    error: current?.error || '',
    reload: () => setRetry(value => value + 1),
  };
}
