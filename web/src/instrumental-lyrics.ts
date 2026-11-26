import { ApiError, json, request } from './api';
import type { Track } from './types';

export async function writeInstrumentalLyrics(trackId: string): Promise<Track | undefined> {
  const path = `/tracks/${encodeURIComponent(trackId)}`;
  try {
    const { track } = await request<{ track: Track }>(path);
    if (track.deletedAt) throw new Error('曲目已移入回收站，请重新选择。');
    if (track.lyricsText?.trim()) return;
    const result = await json<{ track: Track }>(path, 'PATCH', {
      lyricsText: '[00:00.000]纯音乐，请欣赏', expectedLyricsVersion: track.lyricsVersion, expectedAudioVersion: track.audioVersion,
    });
    return result.track;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new Error('歌词或音频已更新，请查看最新内容后重试。');
    throw error;
  }
}
