import type { Track } from './types';
import { normalize } from './utils';

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

type TextKey = typeof TEXT_FILTERS[number]['key'];
type RangeKey = typeof RANGE_FILTERS[number]['from' | 'to'];
export type LibraryFilters = Record<TextKey | RangeKey | 'tag' | 'format' | 'sampleRate' | 'bitDepth' | 'channels' | 'favorite' | 'lyrics' | 'cover', string>;

export const EMPTY_FILTERS: LibraryFilters = {
  title: '', artist: '', album: '', albumArtist: '', genre: '', version: '', composer: '', lyricist: '', tag: '',
  yearFrom: '', yearTo: '', bpmFrom: '', bpmTo: '', durationFrom: '', durationTo: '',
  format: '', sampleRate: '', bitDepth: '', channels: '', favorite: '', lyrics: '', cover: '',
};

export function filterCount(filters: LibraryFilters): number {
  return TEXT_FILTERS.filter(({ key }) => filters[key].trim()).length
    + RANGE_FILTERS.filter(({ from, to }) => filters[from] || filters[to]).length
    + (['tag', 'format', 'sampleRate', 'bitDepth', 'channels', 'favorite', 'lyrics', 'cover'] as const).filter(key => filters[key]).length;
}

export function filterError(filters: LibraryFilters): string {
  for (const { label, from, to, step } of RANGE_FILTERS) {
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

export function matchesFilters(track: Track, filters: LibraryFilters): boolean {
  for (const { key } of TEXT_FILTERS) {
    if (!filters[key].trim()) continue;
    const value = normalize(track[key] || '');
    if (!normalize(filters[key]).trim().split(/\s+/).every(part => value.includes(part))) return false;
  }
  if (filters.tag && !track.tags?.includes(filters.tag)) return false;
  for (const { key, from, to, scale } of RANGE_FILTERS) {
    if (!filters[from] && !filters[to]) continue;
    const value = track[key] || 0;
    // Zero denotes unknown metadata, not a year or tempo that satisfies an upper bound.
    if (!(value > 0) || (filters[from] && value < Number(filters[from]) * scale) || (filters[to] && value > Number(filters[to]) * scale)) return false;
  }
  if (filters.format && normalize(track.format || '') !== filters.format) return false;
  for (const key of ['sampleRate', 'bitDepth', 'channels'] as const) {
    if (filters[key] && track[key] !== Number(filters[key])) return false;
  }
  for (const [key, present] of [['favorite', track.favorite], ['lyrics', track.hasLyrics], ['cover', !!track.coverUrl]] as const) {
    if (filters[key] && present !== (filters[key] === 'yes')) return false;
  }
  return true;
}
