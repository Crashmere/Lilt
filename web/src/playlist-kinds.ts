import type { PlaylistKind } from './types';

export const PLAYLIST_LABELS: Record<PlaylistKind, string> = {
  manual: '普通歌单',
  external: '外部歌单',
  game: '游戏原声',
  smart: '智能歌单',
};

export const PLAYLIST_KINDS = Object.keys(PLAYLIST_LABELS) as PlaylistKind[];
