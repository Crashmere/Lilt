import type { Track } from './types';

export function duration(value: number): string {
  const seconds = Math.max(0, Math.floor(value || 0));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function longDuration(value: number): string { return value >= 3600 ? `${(value / 3600).toFixed(1)} 小时` : `${Math.round(value / 60)} 分钟`; }
export function bytes(value: number): string { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`; }
export function date(value: string): string { return value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '未播放'; }
export function normalize(value: string): string { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(); }
export function matches(track: Track, query: string): boolean {
  const haystack = normalize([track.title, track.artist, track.album, track.version, track.genre, track.searchText, ...(track.tags || []), ...(track.aliases || [])].join(' '));
  return normalize(query).split(/\s+/).filter(Boolean).every(part => haystack.includes(part));
}
export function identity(): string { return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
export function readLocal<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
export function writeLocal(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable in private browsing. */ } }
export type LyricLine = { time: number; text: string };
const lyricOffsetPattern = /\[offset:([+-]?\d+)\]/i;

export function adjustLyricsOffset(text: string, seconds: number): string {
  const milliseconds = Number(text.match(lyricOffsetPattern)?.[1] || 0) + Math.round(seconds * 1000);
  const tag = `[offset:${milliseconds}]`;
  return lyricOffsetPattern.test(text)
    ? text.replace(/\[offset:[+-]?\d+\]/gi, tag)
    : `${tag}${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

export function parseLyrics(text: string): { lines: LyricLine[]; plain: string; offset: number } {
  const lines: LyricLine[] = [];
  const offset = Number(text.match(lyricOffsetPattern)?.[1] || 0) / 1000;
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d{2}(?:\.\d+)?)\]/g)];
    const body = raw.replace(/\[\d+:\d{2}(?:\.\d+)?\]/g, '').replace(/<\d+:\d{2}(?:\.\d+)?>/g, '').trim();
    for (const time of times) lines.push({ time: Number(time[1]) * 60 + Number(time[2]) + offset, text: body });
  }
  return { lines: lines.sort((a, b) => a.time - b.time), plain: text.replace(/^\[(ar|ti|al|by|offset):.*\]\s*$/gim, '').trim(), offset };
}
