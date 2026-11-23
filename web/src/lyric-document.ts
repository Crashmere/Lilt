import { identity } from './utils';

export type LyricWord = { text: string; start: number; end: number };
export type EditLine = { id: string; text: string; time: number | null; locked?: boolean; anchorBase?: number; translation?: boolean; pronunciation?: string; words?: LyricWord[]; original?: string; signature?: string; credit?: Record<string, unknown> };
export type LyricDocument = { lines: EditLine[]; headers: string[]; offset: number; newline: string };
const stamp = /\[(\d+):(\d{2})(?:[.:](\d+))?\]/g;
const wordStamp = /<(\d+):(\d{2})(?:[.:](\d+))?>/g;
const milliseconds = (parts: RegExpMatchArray) => Number(parts[1]) * 60000 + Number(parts[2]) * 1000 + Math.round(Number(`0.${parts[3] || '0'}`) * 1000);
const signature = (line: EditLine) => JSON.stringify([line.text, line.time, line.words]);

export function timeLabel(time: number | null): string {
  if (time === null) return '';
  const absolute = Math.abs(Math.round(time));
  return `${time < 0 ? '-' : ''}${String(Math.floor(absolute / 60000)).padStart(2, '0')}:${String(Math.floor(absolute / 1000) % 60).padStart(2, '0')}.${String(absolute % 1000).padStart(3, '0')}`;
}
export function readTime(value: string): number | null {
  if (!value.trim()) return null;
  const match = value.trim().match(/^(-?)(\d+):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match || Number(match[3]) >= 60) throw new Error('时间格式应为 00:00.000');
  return (match[1] ? -1 : 1) * (Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number((match[4] || '').padEnd(3, '0')));
}
export function parseDocument(text: string): LyricDocument {
  const doc: LyricDocument = { lines: [], headers: [], offset: 0, newline: text.includes('\r\n') ? '\r\n' : '\n' };
  doc.offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0);
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\[(ar|ti|al|by|offset|length|re|ve):[^\]]*\]\s*$/i.test(raw)) { if (!/^\s*\[offset:/i.test(raw)) doc.headers.push(raw); continue; }
    let credit: Record<string, unknown> | undefined;
    let body = raw;
    let creditTime: number | null = null;
    try {
      const record = JSON.parse(raw);
      if (record && Array.isArray(record.c) && record.c.length && record.c.every((part: { tx?: unknown }) => typeof part?.tx === 'string')) {
        credit = record; body = record.c.map((part: { tx: string }) => part.tx).join('');
        creditTime = typeof record.t === 'number' && Number.isFinite(record.t) ? record.t : null;
      }
    } catch { /* Ordinary lyrics are not JSON credit records. */ }
    const times = credit ? [] : [...raw.matchAll(stamp)];
    const tokens = credit ? [] : [...raw.matchAll(wordStamp)];
    if (!credit) body = raw.replace(stamp, '').replace(wordStamp, '');
    const words = tokens.length ? tokens.map((token, i) => ({ text: raw.slice((token.index || 0) + token[0].length, tokens[i + 1]?.index ?? raw.length), start: milliseconds(token), end: tokens[i + 1] ? milliseconds(tokens[i + 1]) : milliseconds(token) })) : undefined;
    for (const time of times.length ? times.map(milliseconds) : [creditTime]) {
      const line: EditLine = { id: identity(), text: body, time, words, credit };
      if (times.length <= 1) { line.original = raw; line.signature = signature(line); }
      doc.lines.push(line);
    }
  }
  if (doc.lines.length > 1 && doc.lines.at(-1)?.text === '' && doc.lines.at(-1)?.time === null) doc.lines.pop();
  doc.lines.forEach((line, i) => { if (i && line.time !== null && line.time === doc.lines[i - 1].time) line.translation = true; });
  return doc;
}
export function reconcileDocument(text: string, previous: LyricDocument): LyricDocument {
  if (text === serializeDocument(previous)) return previous;
  const parsed = parseDocument(text);
  const used = new Set<string>();
  // Enhanced LRC stores starts only; model interval ends must not affect row matching.
  const rowKey = (line: EditLine) => JSON.stringify([line.text, line.time, line.words?.map(word => [word.text, word.start])]);
  const matches = parsed.lines.map(line => {
    const old = previous.lines.find(item => !used.has(item.id) && rowKey(item) === rowKey(line));
    if (old) used.add(old.id);
    return old;
  });
  parsed.lines = parsed.lines.map((line, index) => {
    // Unchanged rows survive insertions/reordering; positional edits retain their identity.
    const old = matches[index] || (parsed.lines.length === previous.lines.length && !used.has(previous.lines[index].id) ? previous.lines[index] : undefined);
    if (!old) return line;
    used.add(old.id);
    const translation = line.time !== null && line.time === parsed.lines[index - 1]?.time && (old.translation ?? line.translation);
    const sameWords = JSON.stringify(line.words?.map(word => [word.text, word.start])) === JSON.stringify(old.words?.map(word => [word.text, word.start]));
    return { ...line, id: old.id, words: sameWords ? old.words : line.words, translation, locked: !translation && line.time !== null && old.locked, anchorBase: old.anchorBase, pronunciation: line.text === old.text ? old.pronunciation : undefined };
  });
  return parsed;
}

export function joinLineText(lines: EditLine[]): string {
  return lines.reduce((text, line) => {
    const separator = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(line.text) ? ' ' : '';
    return text + separator + line.text;
  }, '');
}
export function serializeDocument(doc: LyricDocument): string {
  const lines = doc.lines.map(line => {
    if (line.original !== undefined && line.signature === signature(line)) return line.original;
    if (line.credit) return JSON.stringify({ ...line.credit, t: line.time, c: [{ tx: line.text }] });
    const body = line.words?.length && line.words.map(word => word.text).join('') === line.text
      ? line.words.map(word => `<${timeLabel(word.start)}>${word.text}`).join('') : line.text;
    return `${line.time === null ? '' : `[${timeLabel(line.time)}]`}${body}`;
  });
  return [...doc.headers, ...(doc.offset ? [`[offset:${Math.round(doc.offset)}]`] : []), ...lines].join(doc.newline);
}
export function moveLine(line: EditLine, time: number | null): EditLine {
  const shift = time !== null && line.time !== null ? time - line.time : 0;
  return { ...line, time, words: time === null ? undefined : line.words?.map(word => ({ ...word, start: word.start + shift, end: word.end + shift })) };
}
export function downloadLyrics(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function importLyrics(file: File): Promise<string> {
  if (file.size > 1024 ** 2) throw new Error('歌词不能超过 1 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error('无法读取编码，请将歌词转为 UTF-8 后导入'); }
}
