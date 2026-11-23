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
export type LyricLine = { time: number; text: string; secondary?: string[]; words?: { time: number; text: string }[] };
const lyricOffsetPattern = /\[offset:([+-]?\d+)\]/i;
const lyricTimestampPattern = /\[(\d+):(\d{2})(?:[.:](\d+))?\]/g;
const lyricMetadataPattern = /^\[(?:ar|ti|al|by|offset|length|re|ve):[^\]]*\]\s*$/i;

export function adjustLyricsOffset(text: string, seconds: number): string {
  const milliseconds = Number(text.match(lyricOffsetPattern)?.[1] || 0) + Math.round(seconds * 1000);
  const tag = `[offset:${milliseconds}]`;
  return lyricOffsetPattern.test(text)
    ? text.replace(/\[offset:[+-]?\d+\]/gi, tag)
    : `${tag}${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

function parseLyricCredit(value: string): { time?: number; text: string } | undefined {
  if (!value.startsWith('{')) return;
  try {
    const credit = JSON.parse(value);
    if (!credit || !Array.isArray(credit.c) || !credit.c.length
      || !credit.c.every((part: { tx?: unknown } | null) => typeof part?.tx === 'string')) return;
    if (credit.t != null && (typeof credit.t !== 'number' || !Number.isFinite(credit.t))) return;
    return { time: credit.t == null ? undefined : credit.t / 1000, text: credit.c.map((part: { tx: string }) => part.tx).join('').trim() };
  } catch { return; }
}

export function parseLyrics(text: string, partial = false): { lines: LyricLine[]; plain: string; offset: number; fullyTimed: boolean } {
  const lines: LyricLine[] = [];
  const plain: string[] = [];
  let fullyTimed = true;
  const offset = Number(text.match(lyricOffsetPattern)?.[1] || 0) / 1000;
  for (const raw of text.split(/\r?\n/)) {
    const value = raw.trim();
    if (lyricMetadataPattern.test(value)) continue;
    const credit = parseLyricCredit(value);
    if (credit) {
      plain.push(credit.text);
      if (credit.time === undefined) fullyTimed = false;
      else lines.push({ text: credit.text, time: credit.time + offset });
      continue;
    }
    const times = [...value.matchAll(lyricTimestampPattern)];
    const body = value.replace(lyricTimestampPattern, '').replace(/<\d+:\d{2}(?:[.:]\d+)?>/g, '').trim();
    plain.push(body);
    if (value && times[0]?.index !== 0) fullyTimed = false;
    const tokens = [...value.matchAll(/<(\d+):(\d{2})(?:[.:](\d+))?>/g)];
    const words = tokens.length ? tokens.map((token, i) => ({ time: Number(token[1]) * 60 + Number(token[2]) + Number(`0.${token[3] || 0}`) + offset, text: value.slice(token.index! + token[0].length, tokens[i + 1]?.index ?? value.length) })) : undefined;
    for (const time of times) lines.push({ time: Number(time[1]) * 60 + Number(time[2]) + Number(`0.${time[3] || 0}`) + offset, text: body, words });
  }
  // A stray timestamp must not hide the rest of a plain or partially timed lyric.
  const grouped: LyricLine[] = [];
  if (fullyTimed || partial) for (const line of lines.sort((a, b) => a.time - b.time)) {
    const previous = grouped.at(-1);
    if (previous?.time === line.time) previous.secondary = [...(previous.secondary || []), line.text];
    else grouped.push(line);
  }
  return { lines: grouped, plain: plain.join('\n').trim(), offset, fullyTimed };
}
