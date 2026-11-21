import { useEffect, useState } from 'react';
import { ApiError, messageOf, request } from './api';
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ ...content, loading: true, error: '' });

    async function load(attempt: number) {
      try {
        const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(content.trackId)}`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
        });
        if (abort.signal.aborted) return;
        cached = { trackId: result.track.id, updatedAt: result.track.updatedAt, text: result.track.lyricsText || '' };
        setState({ ...content, text: cached.text, loading: false, error: '' });
      } catch (error) {
        if (abort.signal.aborted) return;
        const transient = error instanceof TypeError
          || error instanceof DOMException && error.name === 'TimeoutError'
          || error instanceof ApiError && [408, 429, 500, 502, 503, 504].includes(error.status);
        if (transient && attempt < 3) {
          timer = setTimeout(() => { void load(attempt + 1); }, 1000 * 2 ** attempt);
          return;
        }
        setState({ ...content, loading: false, error: messageOf(error) });
      }
    }
    void load(0);
    return () => { abort.abort(); clearTimeout(timer); };
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
