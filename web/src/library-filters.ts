import type { Track } from './types';
import { duration, normalize } from './utils';

export const TEXT_FILTERS = [
  { key: 'title', label: '曲名' }, { key: 'artist', label: '艺术家' },
  { key: 'album', label: '专辑' }, { key: 'albumArtist', label: '专辑艺术家' },
  { key: 'genre', label: '流派' }, { key: 'version', label: '版本' },
  { key: 'composer', label: '作曲' }, { key: 'lyricist', label: '作词' },
] as const;

export const RANGE_FILTERS = [
  { key: 'year', label: '发行年份', from: 'yearFrom', to: 'yearTo', unit: '年', scale: 1, step: 1 },
  { key: 'bpm', label: '节奏', from: 'bpmFrom', to: 'bpmTo', unit: 'BPM', scale: 1, step: 1 },
  { key: 'duration', label: '时长', from: 'durationFrom', to: 'durationTo', unit: '分钟', scale: 60, step: 0.1 },
] as const;

export const PRESENCE_FILTERS = [
  { key: 'genre', state: 'genreState' }, { key: 'version', state: 'versionState' },
  { key: 'composer', state: 'composerState' }, { key: 'lyricist', state: 'lyricistState' },
  { key: 'tag', state: 'tagState' }, { key: 'year', state: 'yearState' },
  { key: 'bpm', state: 'bpmState' }, { key: 'bitDepth', state: 'bitDepthState' },
] as const;

export type PresenceKey = typeof PRESENCE_FILTERS[number]['key'];
type PresenceStateKey = typeof PRESENCE_FILTERS[number]['state'];
export function presenceState(key: string): PresenceStateKey | undefined { return PRESENCE_FILTERS.find(field => field.key === key)?.state; }

type TextKey = typeof TEXT_FILTERS[number]['key'];
type RangeKey = typeof RANGE_FILTERS[number]['from' | 'to'];
export type LibraryFilters = Record<TextKey | RangeKey | PresenceStateKey | 'tag' | 'format' | 'sampleRate' | 'bitDepth' | 'channels' | 'favorite' | 'lyrics' | 'cover' | 'playlists', string>;

type ColumnKey = TextKey | typeof RANGE_FILTERS[number]['key'] | 'tag' | 'format' | 'sampleRate' | 'bitDepth' | 'channels' | 'favorite' | 'lyrics' | 'cover' | 'playlists';
export type FilterColumn = { key: ColumnKey; label: string; value: (track: Track, playlistCount: number) => string };

const FILTER_COLUMNS: FilterColumn[] = [
  ...TEXT_FILTERS.map(({ key, label }) => ({ key, label, value: (track: Track) => track[key]?.trim() || '未填写' })),
  { key: 'tag', label: '标签', value: track => track.tags?.filter(tag => tag.trim()).join('、') || '无标签' },
  ...RANGE_FILTERS.map(({ key, label }) => ({ key, label, value: (track: Track) => key === 'duration' ? duration(track.duration) : track[key] ? `${track[key]}${key === 'bpm' ? ' BPM' : ''}` : '未填写' })),
  { key: 'format', label: '音频编码', value: track => track.format.toUpperCase() },
  { key: 'sampleRate', label: '采样率', value: track => `${track.sampleRate / 1000} kHz` },
  { key: 'bitDepth', label: '位深', value: track => track.bitDepth ? `${track.bitDepth} bit` : '未提供' },
  { key: 'channels', label: '声道', value: track => track.channels === 1 ? '单声道' : track.channels === 2 ? '立体声' : `${track.channels} 声道` },
  { key: 'favorite', label: '收藏', value: track => track.favorite ? '已收藏' : '未收藏' },
  { key: 'lyrics', label: '歌词', value: track => track.hasLyrics ? '有歌词' : '无歌词' },
  { key: 'cover', label: '封面', value: track => track.coverUrl ? '有封面' : '无封面' },
  { key: 'playlists', label: '歌单归属', value: (_track, count) => `${count} 个` },
];

export const EMPTY_FILTERS: LibraryFilters = {
  title: '', artist: '', album: '', albumArtist: '', genre: '', version: '', composer: '', lyricist: '', tag: '',
  yearFrom: '', yearTo: '', bpmFrom: '', bpmTo: '', durationFrom: '', durationTo: '',
  format: '', sampleRate: '', bitDepth: '', channels: '', favorite: '', lyrics: '', cover: '', playlists: '',
  genreState: '', versionState: '', composerState: '', lyricistState: '', tagState: '', yearState: '', bpmState: '', bitDepthState: '',
};

export function setPresence(filters: LibraryFilters, key: PresenceKey, state: string): LibraryFilters {
  const stateKey = presenceState(key)!;
  const range = RANGE_FILTERS.find(field => field.key === key);
  return range ? { ...filters, [stateKey]: state, [range.from]: '', [range.to]: '' } : { ...filters, [stateKey]: state, [key]: '' };
}

function hasPresence(filters: LibraryFilters, key: string): boolean {
  const stateKey = presenceState(key);
  return !!(stateKey && filters[stateKey]);
}

export function activeFilterColumns(filters: LibraryFilters): FilterColumn[] {
  return FILTER_COLUMNS.filter(({ key }) => {
    if (hasPresence(filters, key)) return true;
    if (key === 'year' || key === 'bpm' || key === 'duration') {
      const range = RANGE_FILTERS.find(field => field.key === key)!;
      return !!(filters[range.from] || filters[range.to]);
    }
    return !!filters[key].trim();
  });
}

export function filterCount(filters: LibraryFilters): number { return activeFilterColumns(filters).length; }

export function filterError(filters: LibraryFilters): string {
  for (const { key: field, label, from, to, step } of RANGE_FILTERS) {
    if (hasPresence(filters, field)) continue;
    for (const key of [from, to]) {
      if (!filters[key]) continue;
      const value = Number(filters[key]);
      if (!Number.isFinite(value) || value < 0 || (step === 1 && !Number.isInteger(value))) {
        return `${label}请填写非负${step === 1 ? '整数' : '数值'}`;
      }
    }
    if (filters[from] && filters[to] && Number(filters[from]) > Number(filters[to])) return `${label}的最小值不能大于最大值`;
  }
  return '';
}

export function matchesFilters(track: Track, filters: LibraryFilters, playlistCount: number): boolean {
  for (const { key, state } of PRESENCE_FILTERS) {
    if (!filters[state]) continue;
    const value = key === 'tag' ? track.tags?.some(tag => tag.trim()) : track[key];
    const present = typeof value === 'number' ? value > 0 : typeof value === 'string' ? !!value.trim() : !!value;
    if (present !== (filters[state] === 'present')) return false;
  }
  for (const { key } of TEXT_FILTERS) {
    if (hasPresence(filters, key) || !filters[key].trim()) continue;
    const value = normalize(track[key] || '');
    if (!normalize(filters[key]).trim().split(/\s+/).every(part => value.includes(part))) return false;
  }
  if (!hasPresence(filters, 'tag') && filters.tag && !track.tags?.includes(filters.tag)) return false;
  for (const { key, from, to, scale } of RANGE_FILTERS) {
    if (hasPresence(filters, key) || (!filters[from] && !filters[to])) continue;
    const value = track[key] || 0;
    // Zero denotes unknown metadata, not a year or tempo that satisfies an upper bound.
    if (!(value > 0) || (filters[from] && value < Number(filters[from]) * scale) || (filters[to] && value > Number(filters[to]) * scale)) return false;
  }
  if (filters.format && normalize(track.format || '') !== filters.format) return false;
  for (const key of ['sampleRate', 'bitDepth', 'channels'] as const) {
    if (!hasPresence(filters, key) && filters[key] && track[key] !== Number(filters[key])) return false;
  }
  for (const [key, present] of [['favorite', track.favorite], ['lyrics', track.hasLyrics], ['cover', !!track.coverUrl]] as const) {
    if (filters[key] && present !== (filters[key] === 'yes')) return false;
  }
  if ((filters.playlists === 'none' && playlistCount !== 0) || (filters.playlists === 'one' && playlistCount !== 1) || (filters.playlists === 'multiple' && playlistCount < 2)) return false;
  return true;
}
