import { createContext, Fragment, useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, LockKeyhole, LoaderCircle, Pause, Play, Plus, Sparkles, Trash2, Undo2, Redo2, Upload } from 'lucide-react';
import './lyrics-workbench.css';
import { Modal } from './components';
import { ApiError, json, messageOf, read, request } from './api';
import type { Track } from './types';
import type { Player } from './player';
import { identity, parseLyrics } from './utils';
import { useActiveLyric } from './lyrics';
import { LyricText } from './lyric-text';
import { loadLyricDraft, saveLyricDraft } from './storage';
import { downloadLyrics, importLyrics, joinLineText, moveLine, parseDocument, readTime, reconcileDocument, serializeDocument, timeLabel, type EditLine, type LyricDocument, type LyricWord } from './lyric-document';
import { LyricWaveform, type WaveView } from './lyric-waveform';
import { useWorkbenchAudio } from './workbench-audio';

type Result = { id: string; time: number | null; words?: LyricWord[]; confidence: number; warning?: string };
type Job = { id: string; kind: 'align' | 'waveform'; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; phase: string; progress: number; audioVersion: string; draftVersion: string; results?: Result[]; peaks?: number[]; error?: string };
type Base = { lyricsText: string; lyricsVersion: string; audioVersion: string };
type ModelInput = { lines: EditLine[]; offset: number; audioVersion: string };
type History = { past: LyricDocument[]; doc: LyricDocument; future: LyricDocument[]; pastTargets?: string[]; futureTargets?: string[] };
type Workspace = { editId: string; stampId?: string; autoAdvance?: boolean; selected: string[]; range: [number, number]; rate: number; loop: boolean; step: number; followLyrics: boolean; waveView: WaveView; scroll: number[]; find: string; replacement: string; reviewOnly: boolean };
type Draft = { doc: LyricDocument; base: Base; raw?: string; source?: boolean; job?: Job; waveJob?: Job; modelInput?: ModelInput; history?: History; workspace?: Workspace };
type TimeControls = { inputs: Map<string, () => boolean>; pending: (id: string, pending: boolean) => void };
const TimeContext = createContext<TimeControls | undefined>(undefined);
const comparable = serializeDocument;
const activeJob = (job?: Job) => job?.status === 'queued' || job?.status === 'running';
const isStampable = (line: EditLine) => !line.translation && !line.credit;
const isOriginal = (line: EditLine) => isStampable(line) && !!line.text.trim();
const isTyping = (target: HTMLElement) => target.isContentEditable || !!target.closest('input:not([type="checkbox"]):not([type="range"]),textarea,select,[role="textbox"]');

function TimeInput({ value, onChange, label, disabled, required = false }: { value: number | null; onChange: (time: number | null) => void; label: string; disabled?: boolean; required?: boolean }) {
  const controls = useContext(TimeContext)!;
  const id = useId();
  const [text, setText] = useState(timeLabel(value));
  const [error, setError] = useState('');
  const textRef = useRef(text);
  const props = useRef({ value, onChange, disabled, required }); props.current = { value, onChange, disabled, required };
  function commit() {
    if (props.current.disabled) return true;
    try {
      const time = readTime(textRef.current);
      if (props.current.required && time === null) throw new Error('请填写时间');
      if (time !== props.current.value) props.current.onChange(time);
      textRef.current = timeLabel(time); setText(textRef.current); setError(''); controls.pending(id, false);
      return true;
    } catch (failure) { setError(messageOf(failure)); controls.pending(id, true); return false; }
  }
  useEffect(() => {
    textRef.current = timeLabel(value); setText(textRef.current); setError(''); controls.pending(id, false);
  }, [value, disabled]);
  useEffect(() => {
    controls.inputs.set(id, commit);
    return () => { controls.inputs.delete(id); controls.pending(id, false); };
  }, [controls, id]);
  return <input aria-label={label} aria-invalid={!!error} title={error || undefined} className="lyric-time-input" value={text} placeholder="未打点" disabled={disabled} onChange={event => { textRef.current = event.target.value; setText(textRef.current); setError(''); controls.pending(id, textRef.current !== timeLabel(value)); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }} />;
}

export function LyricsWorkbench({ track, player, onClose, onSaved }: { track: Track; player: Player; onClose: () => void; onSaved: (track: Track) => void }) {
  const [history, setHistory] = useState<History>(() => ({ past: [], doc: parseDocument(track.lyricsText || ''), future: [] }));
  const historyRef = useRef(history); historyRef.current = history;
  const doc = history.doc;
  const [base, setBase] = useState<Base>({ lyricsText: track.lyricsText || '', lyricsVersion: track.lyricsVersion || '', audioVersion: track.audioVersion || '' });
  const [selected, setSelected] = useState<Set<string>>(() => new Set(doc.lines[0] ? [doc.lines[0].id] : []));
  const [editId, setEditId] = useState(doc.lines[0]?.id || '');
  const [stampId, setStampId] = useState(() => doc.lines.find(line => isStampable(line) && !line.locked)?.id || '');
  const stampIdRef = useRef(stampId); stampIdRef.current = stampId;
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [stampIssue, setStampIssue] = useState<{ id: string; message: string }>();
  const [stampFlash, setStampFlash] = useState<{ id: string; sequence: number }>();
  const stampSequence = useRef(0);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState<'align' | 'waveform'>();
  const [source, setSource] = useState(false);
  const [raw, setRaw] = useState('');
  const [step, setStep] = useState(100);
  const [loop, setLoop] = useState(false);
  const [range, setRange] = useState<[number, number]>([0, Math.round(track.duration * 1000)]);
  const rangeRef = useRef(range); rangeRef.current = range;
  const [rate, setRate] = useState(1);
  const [followLyrics, setFollowLyrics] = useState(true);
  const [waveView, setWaveView] = useState<WaveView>({ zoom: 4, follow: true, start: 0 });
  const [tools, setTools] = useState({ available: false, alignment: false, languages: [] as string[] });
  const [job, setJob] = useState<Job>();
  const [waveJob, setWaveJob] = useState<Job>();
  const [peaks, setPeaks] = useState<number[]>([]);
  const [audioTrack, setAudioTrack] = useState(track);
  const [modelInput, setModelInput] = useState<ModelInput>();
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [serverCopy, setServerCopy] = useState<Track>();
  const [draftStatus, setDraftStatus] = useState<'saving' | 'saved' | 'error'>('saved');
  const [pendingTimes, setPendingTimes] = useState(new Set<string>());
  const timeControls = useRef<TimeControls>({ inputs: new Map(), pending: () => undefined });
  timeControls.current.pending = (id, pending) => setPendingTimes(old => {
    if (old.has(id) === pending) return old;
    const next = new Set(old); if (pending) next.add(id); else next.delete(id); return next;
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const lineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef('');
  const rowList = useRef<HTMLDivElement>(null);
  const calibrationPane = useRef<HTMLElement>(null);
  const body = useRef<HTMLFieldSetElement>(null);
  const scroll = useRef([0, 0, 0]);
  const manualScrollUntil = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const group = useRef({ id: '', at: 0 });
  const latestPlayer = useRef(player); latestPlayer.current = player;
  const preload = useWorkbenchAudio(audioTrack, (target, url) => latestPlayer.current.setAuditionSource(target, url));
  const waveformPeaks = preload.peaks || peaks;
  const draftKey = useRef(`${track.id}:${editorTab()}`);
  const serialized = useMemo(() => comparable(doc), [doc]);
  const baseline = useMemo(() => comparable(parseDocument(base.lyricsText)), [base.lyricsText]);
  const currentText = source ? raw : serialized;
  const dirty = (source ? raw !== base.lyricsText && raw !== baseline : serialized !== baseline) || pendingTimes.size > 0;
  const preview = useMemo(() => parseLyrics(currentText, true), [currentText]);
  const previewDoc = useMemo(() => source ? reconcileDocument(raw, doc) : doc, [source, raw, doc]);
  const chosen = doc.lines.filter(line => selected.has(line.id));
  const editing = doc.lines.find(line => line.id === editId);
  const stampTarget = doc.lines.find(line => line.id === stampId);
  const stampUnavailable = !stampTarget ? '点击行号选择打点目标' : stampTarget.locked ? '先解锁这句锚点再打点' : stampTarget.translation ? '译文跟随原文，请选择原文打点' : stampTarget.credit ? '署名行不参与打点' : '';
  const current = useActiveLyric(preview.lines, player.position, player.getPosition, player.playing && player.trackId === track.id);
  const words = preview.lines.flatMap(line => line.words || []);
  const currentWord = useActiveLyric(words, player.position, player.getPosition, player.playing && player.trackId === track.id);
  const results = useMemo(() => new Map(job?.results?.map(result => [result.id, result])), [job?.results]);
  const conflict = !!serverCopy && (serverCopy.lyricsVersion !== base.lyricsVersion || serverCopy.audioVersion !== base.audioVersion);
  function modelStale(document: LyricDocument) {
    if (!modelInput) return false;
    const ids = new Set(modelInput.lines.map(line => line.id));
    const order = document.lines.filter(line => ids.has(line.id)).map(line => line.id);
    const lines = new Map(document.lines.map(line => [line.id, line]));
    return conflict || source && raw !== serialized || modelInput.audioVersion !== base.audioVersion || modelInput.offset !== document.offset || modelInput.lines.some((old, index) => {
      const line = lines.get(old.id), result = results.get(old.id);
      return !line || order[index] !== old.id || line.text !== old.text || line.pronunciation !== old.pronunciation || !!line.translation !== !!old.translation || !!line.locked !== !!old.locked || line.time !== old.time && line.time !== (result?.time == null ? undefined : Math.max(0, result.time - document.offset));
    });
  }
  const stale = modelStale(doc);
  const matches = find ? doc.lines.filter(line => line.text.includes(find)) : [];
  const rawMatches: number[] = [];
  if (find) for (let at = raw.indexOf(find); at >= 0; at = raw.indexOf(find, at + find.length)) rawMatches.push(at);
  const matchCount = source ? rawMatches.length : matches.length;
  function candidate(line: EditLine) {
    const result = results.get(line.id);
    if (result?.time == null) return { result, applied: false };
    const expectedWords = result.words?.map(word => ({ ...word, start: Math.max(0, word.start - doc.offset), end: Math.max(0, word.end - doc.offset) }));
    return { result, applied: (line.locked || line.time === Math.max(0, result.time - doc.offset)) && JSON.stringify(line.words) === JSON.stringify(expectedWords) };
  }
  const visibleLines = reviewOnly && job?.status === 'done' ? doc.lines.filter(line => { const state = candidate(line); return state.result && (!state.applied || state.result.warning); }) : doc.lines;
  const latestDraft = useRef<Draft>({ doc, base });
  latestDraft.current = { doc, base, raw, source, job, waveJob, modelInput, history, workspace: { editId, stampId, autoAdvance, selected: [...selected], range, rate, loop, step, followLyrics, waveView, scroll: scroll.current, find, replacement, reviewOnly } };

  function setTarget(id: string) { stampIdRef.current = id; setStampId(id); setStampIssue(undefined); if (latestDraft.current.workspace) latestDraft.current.workspace.stampId = id; }

  function installHistory(next: History) { historyRef.current = next; latestDraft.current.doc = next.doc; latestDraft.current.history = next; setHistory(next); }
  function change(next: LyricDocument | ((current: LyricDocument) => LyricDocument), groupId = '') {
    const old = historyRef.current;
    const value = typeof next === 'function' ? next(old.doc) : next;
    if (value === old.doc) return;
    const lines: EditLine[] = [];
    value.lines.forEach((line, index) => lines.push(line.translation ? index ? { ...line, time: lines[index - 1].time, words: undefined, locked: false, anchorBase: undefined } : { ...line, translation: false } : line));
    const coalesce = groupId && group.current.id === groupId && Date.now() - group.current.at < 1000;
    group.current = { id: groupId, at: Date.now() };
    const targets = old.pastTargets || old.past.map(() => stampIdRef.current);
    installHistory({ past: coalesce ? old.past : [...old.past.slice(-49), old.doc], pastTargets: coalesce ? targets : [...targets.slice(-49), stampIdRef.current], doc: { ...value, lines }, future: [], futureTargets: [] });
  }
  function update(id: string, transform: (line: EditLine) => EditLine, groupId = '') { change(old => ({ ...old, lines: old.lines.map(line => line.id === id ? transform(line) : line) }), groupId); }
  function restoreTarget(id: string | undefined, document: LyricDocument) {
    if (id === undefined) return;
    const target = document.lines.find(line => line.id === id);
    setTarget(target?.id || ''); setStampFlash(undefined); setNotice('');
    if (target) { setEditId(target.id); requestAnimationFrame(() => revealLine(target.id)); }
  }
  function undo() {
    group.current.id = ''; const old = historyRef.current;
    if (!old.past.length) return;
    const next = old.past.at(-1)!;
    installHistory({ past: old.past.slice(0, -1), pastTargets: old.pastTargets?.slice(0, -1), doc: next, future: [old.doc, ...old.future], futureTargets: [stampIdRef.current, ...(old.futureTargets || old.future.map(() => stampIdRef.current))] });
    restoreTarget(old.pastTargets?.at(-1), next);
  }
  function redo() {
    group.current.id = ''; const old = historyRef.current;
    if (!old.future.length) return;
    const next = old.future[0];
    installHistory({ past: [...old.past, old.doc], pastTargets: [...(old.pastTargets || old.past.map(() => stampIdRef.current)), stampIdRef.current], doc: next, future: old.future.slice(1), futureTargets: old.futureTargets?.slice(1) });
    restoreTarget(old.futureTargets?.[0], next);
  }
  function flushTimes() { const valid = [...timeControls.current.inputs.values()].map(commit => commit()).every(Boolean); if (!valid) setError('请修正标红的时间字段'); return valid; }
  function updateRange(next: [number, number]) { rangeRef.current = next; if (latestDraft.current.workspace) latestDraft.current.workspace.range = next; setRange(next); }
  function validRange() { const [a, b] = rangeRef.current; return a >= 0 && b > a && b <= audioTrack.duration * 1000; }
  async function act(action: () => void | Promise<void>) { setError(''); try { await action(); } catch (failure) { setError(messageOf(failure)); if (failure instanceof ApiError && failure.status === 409) await checkServer(); } }
  function audition(time: number) {
    if (!ready || busy || conflict) return;
    if (loop && !validRange()) { setError('选段必须满足 0 ≤ A < B ≤ 曲目时长'); return; }
    player.startAudition(audioTrack, Math.max(0, Math.min(audioTrack.duration * 1000, time)) / 1000); player.setPlaybackRate(rate);
  }
  function revealLine(id: string) {
    const list = rowList.current, row = lineInputs.current.get(id)?.closest('.lyric-edit-row');
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    if (target.top < bounds.top + 8 || target.bottom > bounds.bottom - 8) list.scrollBy({ top: target.top - bounds.top - list.clientHeight * 0.35, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function chooseLine(id: string, single = false) { setEditId(id); setTarget(id); if (single) setSelected(new Set([id])); revealLine(id); }
  const toggleAudition = useEffectEvent(() => {
    if (!ready || busy || !flushTimes()) return;
    const control = latestPlayer.current;
    if (control.trackId === track.id && control.playRequested) control.pause();
    else audition(control.trackId === track.id ? control.getPosition() * 1000 : rangeRef.current[0]);
  });
  useEffect(() => { latestPlayer.current.setAuditionToggle(toggleAudition); return () => latestPlayer.current.setAuditionToggle(); }, []);
  useEffect(() => {
    const ids = new Set(doc.lines.map(line => line.id));
    setSelected(old => [...old].some(id => !ids.has(id)) ? new Set([...old].filter(id => ids.has(id))) : old);
    if (!ids.has(editId)) setEditId(doc.lines.find(line => selected.has(line.id))?.id || doc.lines[0]?.id || '');
    if (stampIdRef.current && !ids.has(stampIdRef.current)) setTarget('');
  }, [doc]);
  useLayoutEffect(() => {
    const id = pendingFocus.current, input = lineInputs.current.get(id);
    if (!input) return;
    pendingFocus.current = ''; input.focus({ preventScroll: true }); revealLine(id);
  }, [doc]);
  useEffect(() => {
    if (!followLyrics || !player.playing || player.trackId !== track.id || current < 0 || Date.now() < manualScrollUntil.current) return;
    if (stampIdRef.current) return;
    if (document.activeElement instanceof HTMLElement && isTyping(document.activeElement) && document.activeElement.closest('.lyric-edit-row')) return;
    const line = doc.lines.find(item => item.time !== null && (item.time + doc.offset) / 1000 === preview.lines[current]?.time);
    if (line) revealLine(line.id);
  }, [current, player.playing, followLyrics, stampId]);
  function mark() {
    if (!flushTimes()) return;
    if (player.trackId !== track.id) { setError('请先试听当前曲目'); return; }
    const document = historyRef.current.doc;
    const start = document.lines.findIndex(line => line.id === stampIdRef.current), line = document.lines[start];
    if (!line) { setNotice('点击行号选择打点目标'); return; }
    function reject(message: string) { setStampIssue({ id: line.id, message }); revealLine(line.id); }
    if (line.locked) { reject('先解锁这句锚点再打点'); return; }
    if (!isStampable(line)) { reject(line.translation ? '译文跟随原文，请选择原文打点' : '署名行不参与打点'); return; }
    const time = Math.round(player.getPosition() * 1000) - document.offset;
    if (time < 0) { reject('请先调整整体偏移，避免负时间'); return; }
    if (time + document.offset > audioTrack.duration * 1000) { reject('打点时间不能超过曲目时长'); return; }
    const previous = document.lines.slice(0, start).reverse().find(item => isStampable(item) && item.time !== null);
    // Pending starts may be wrong too; continuous stamping stops only at confirmed anchors.
    const boundary = document.lines.slice(start + 1).find(item => isStampable(item) && item.time !== null && (!autoAdvance || item.locked));
    if (previous && time < previous.time!) { reject(`早于第 ${document.lines.indexOf(previous) + 1} 行 ${timeLabel(previous.time! + document.offset)}，请向后试听再打点`); return; }
    if (boundary && time > boundary.time!) { reject(autoAdvance ? `超过第 ${document.lines.indexOf(boundary) + 1} 行锚点 ${timeLabel(boundary.time! + document.offset)}，请先调整锚点` : `超过第 ${document.lines.indexOf(boundary) + 1} 行 ${timeLabel(boundary.time! + document.offset)}，可开启自动下一句重打这段`); return; }
    setStampIssue(undefined); setError(''); setNotice('');
    update(line.id, old => moveLine(old, time));
    setStampFlash({ id: line.id, sequence: ++stampSequence.current });
    revealLine(line.id);
    if (!autoAdvance) return;
    const following = document.lines.slice(document.lines.indexOf(line) + 1).find(item => isStampable(item) && !item.locked);
    setTarget(following?.id || '');
    if (following) { setEditId(following.id); if (followLyrics) revealLine(following.id); }
    else setNotice('连续打点完成，点击行号可继续校正');
  }
  function switchSource() {
    if (!flushTimes()) return;
    if (source) { const next = reconcileDocument(raw, historyRef.current.doc); if (next !== historyRef.current.doc) change(next); setSource(false); }
    else { setRaw(comparable(historyRef.current.doc)); setSource(true); }
  }
  function formatSource() {
    if (!flushTimes()) return;
    setRaw(text => text.split(/\r?\n/).map(line => line.trimStart()).filter(Boolean).join(text.includes('\r\n') ? '\r\n' : '\n'));
    setMatchIndex(-1);
  }
  function shift(amount: number) {
    if (!flushTimes()) return;
    const current = historyRef.current.doc;
    if (current.lines.some(line => selected.has(line.id) && !line.translation && !line.locked && line.time !== null && line.time + amount < 0 && !line.credit)) { setError('调整后时间不能为负'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => selected.has(line.id) && !line.translation && !line.locked && line.time !== null ? moveLine(line, line.time + amount) : line) }));
  }
  function nudgeTarget(amount: number) {
    if (!flushTimes()) return;
    const line = historyRef.current.doc.lines.find(item => item.id === stampIdRef.current);
    if (!line || line.time === null || line.locked || line.translation) return;
    if (line.time + amount < 0 && !line.credit) { setError('调整后时间不能为负'); return; }
    update(line.id, old => moveLine(old, old.time! + amount));
  }
  function interpolate() {
    if (!flushTimes()) return;
    const anchors = historyRef.current.doc.lines.filter(line => line.locked && line.time !== null && line.anchorBase !== undefined);
    if (anchors.length < 2) { setError('先锁定两个以上时间点，再调整锚点时间'); return; }
    for (let i = 1; i < anchors.length; i++) if (anchors[i].anchorBase! <= anchors[i - 1].anchorBase! || anchors[i].time! <= anchors[i - 1].time!) { setError('锚点必须按时间顺序排列'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => {
      if (line.locked) return { ...line, anchorBase: line.time ?? undefined };
      if (line.time === null) return line;
      const next = anchors.findIndex(anchor => anchor.anchorBase! >= line.time!);
      if (next <= 0) return line;
      const a = anchors[next - 1], b = anchors[next];
      return moveLine(line, Math.round(a.time! + (line.time - a.anchorBase!) / (b.anchorBase! - a.anchorBase!) * (b.time! - a.time!)));
    }) }));
  }
  function insertLine(index: number) {
    if (!flushTimes()) return;
    const line: EditLine = { id: identity(), text: '', time: null };
    pendingFocus.current = line.id;
    change(old => {
      const lines = [...old.lines];
      // Inserting into a translation group must preserve the existing row's time.
      if (lines[index]?.translation) lines[index] = { ...lines[index], translation: false };
      lines.splice(index, 0, line); return { ...old, lines };
    });
    chooseLine(line.id, true);
  }
  function addLine(after: boolean) {
    const lines = historyRef.current.doc.lines, index = lines.findIndex(item => item.id === editId);
    insertLine(index < 0 ? after ? lines.length : 0 : index + Number(after));
  }
  function splitLine(id = editId) {
    if (!flushTimes()) return;
    const line = historyRef.current.doc.lines.find(item => item.id === id);
    if (!line) return;
    const at = lineInputs.current.get(line.id)?.selectionStart ?? Math.floor(line.text.length / 2);
    const index = historyRef.current.doc.lines.indexOf(line);
    if (at === 0 || at === line.text.length) { insertLine(index + Number(at !== 0)); return; }
    const next: EditLine = { id: identity(), text: line.text.slice(at), time: null };
    pendingFocus.current = next.id;
    change(old => ({ ...old, lines: old.lines.flatMap((item, i) => item.id === line.id ? [{ ...item, text: item.text.slice(0, at), words: undefined, pronunciation: undefined }, next] : [i === index + 1 && item.translation ? { ...item, translation: false } : item]) }));
    chooseLine(next.id, true);
  }
  function mergeLines() {
    if (!flushTimes()) return;
    const current = historyRef.current.doc, lines = current.lines.filter(line => selected.has(line.id));
    if (lines.length < 2) return;
    const indices = lines.map(line => current.lines.indexOf(line));
    if (indices.at(-1)! - indices[0] + 1 !== indices.length) { setError('请选择连续的歌词行'); return; }
    if (lines.some(line => line.translation || line.credit)) { setError('请先解除译文关联，署名行不能合并'); return; }
    change(old => ({ ...old, lines: old.lines.flatMap(line => line.id === lines[0].id ? [{ ...line, text: joinLineText(lines), words: undefined, pronunciation: undefined }] : selected.has(line.id) ? [] : [line]) }));
    chooseLine(lines[0].id, true);
  }
  function findNext(direction: number) {
    if (!matchCount) return;
    setReviewOnly(false);
    const index = (matchIndex + direction + matchCount) % matchCount; setMatchIndex(index);
    if (source) { const input = sourceInput.current!; input.focus({ preventScroll: true }); input.setSelectionRange(rawMatches[index], rawMatches[index] + find.length); }
    else chooseLine(matches[index].id);
  }
  function replace(scope: 'all' | 'selected' | 'one') {
    if (!find || !flushTimes()) return;
    if (source) {
      if (scope === 'one' && rawMatches.length) { const at = rawMatches[Math.max(0, matchIndex) % rawMatches.length]; setRaw(raw.slice(0, at) + replacement + raw.slice(at + find.length)); }
      else setRaw(raw.replaceAll(find, replacement));
    } else {
      const id = matches[Math.max(0, matchIndex) % matches.length]?.id;
      change(old => ({ ...old, lines: old.lines.map(line => (scope === 'all' || scope === 'selected' && selected.has(line.id) || scope === 'one' && line.id === id) && line.text.includes(find) ? { ...line, text: scope === 'one' ? line.text.replace(find, replacement) : line.text.replaceAll(find, replacement), words: undefined, pronunciation: undefined } : line) }));
    }
    setMatchIndex(-1);
  }
  async function checkServer() {
    try { const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`); setServerCopy(result.track); }
    catch (failure) { setError(messageOf(failure)); }
  }
  async function save() {
    if (operation.current || !ready || conflict || !flushTimes()) return;
    const document = source ? reconcileDocument(raw, historyRef.current.doc) : historyRef.current.doc;
    const text = source ? raw : comparable(document);
    if (document.lines.some(line => line.time !== null && line.time < 0 && !line.credit)) { setError('普通歌词的时间不能为负，请调整整体偏移'); return; }
    if (document.lines.some(line => line.words?.some((word, i, words) => word.start < 0 || i > 0 && word.start < words[i - 1].start))) { setError('逐字时间必须按演唱顺序排列'); return; }
    if (new TextEncoder().encode(text).length > 1024 ** 2) { setError('歌词不能超过 1 MiB'); return; }
    if (!text.trim() && base.lyricsText.trim() && !window.confirm('清空并写回当前歌曲的歌词？')) return;
    operation.current = true; setBusy(true); setError('');
    try {
      const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { lyricsText: text, expectedLyricsVersion: base.lyricsVersion, expectedAudioVersion: base.audioVersion });
      const nextBase = { lyricsText: text, lyricsVersion: result.track.lyricsVersion || '', audioVersion: result.track.audioVersion || '' };
      setBase(nextBase); latestDraft.current.base = nextBase;
      onSaved(result.track); setNotice('已写回歌曲文件'); setServerCopy(undefined);
      // Metadata publication changes bytes, not samples; keep the active audition uninterrupted.
      if (modelInput && modelInput.audioVersion === base.audioVersion) { const input = { ...modelInput, audioVersion: nextBase.audioVersion }; setModelInput(input); latestDraft.current.modelInput = input; }
      await saveLyricDraft(draftKey.current, latestDraft.current).then(() => setDraftStatus('saved')).catch(() => setDraftStatus('error'));
    } catch (failure) { setError(messageOf(failure)); if (failure instanceof ApiError && failure.status === 409) await checkServer(); }
    finally { operation.current = false; setBusy(false); }
  }
  async function close() {
    if (operation.current || !ready || !flushTimes()) return;
    operation.current = true; setBusy(true);
    try { await saveLyricDraft(draftKey.current, latestDraft.current); }
    catch { if (dirty && !window.confirm('无法保存草稿，仍要关闭并放弃修改？')) { operation.current = false; setBusy(false); return; } }
    player.endAudition(); onClose();
  }
  async function submit(kind: 'align' | 'waveform', all = false) {
    if (operation.current || activeJob(kind === 'align' ? job : waveJob) || conflict || !flushTimes()) return;
    if (kind === 'align' && !all && !validRange()) throw new Error('选段必须满足 0 ≤ A < B ≤ 曲目时长');
    const document = historyRef.current.doc;
    const lines = (all ? document.lines : document.lines.filter(line => selected.has(line.id))).filter(isOriginal);
    if (kind === 'align' && !lines.length) throw new Error('请选择需要校准的原文歌词');
    const [start, end] = all ? [0, audioTrack.duration * 1000] : rangeRef.current;
    if (kind === 'align' && lines.some(line => line.locked && (line.time === null || line.time + document.offset < start || line.time + document.offset >= end))) throw new Error('锁定锚点必须位于选段内');
    operation.current = true; setSubmitting(kind);
    try {
      const model = { lines, offset: document.offset, audioVersion: base.audioVersion };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(model)));
      const version = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await json<{ job: Job }>(`/tracks/${encodeURIComponent(track.id)}/lyrics-jobs`, 'POST', {
        kind, audioVersion: base.audioVersion, expectedLyricsVersion: base.lyricsVersion, draftVersion: version, language: 'auto', start, end,
        lines: kind === 'align' ? lines.map(line => ({ id: line.id, text: line.text, time: line.time === null ? null : line.time + document.offset, locked: !!line.locked, pronunciation: line.pronunciation || '' })) : [],
      });
      if (kind === 'align') { setModelInput(model); setJob(result.job); latestDraft.current.modelInput = model; latestDraft.current.job = result.job; setReviewOnly(false); }
      else { setWaveJob(result.job); latestDraft.current.waveJob = result.job; }
      await saveLyricDraft(draftKey.current, latestDraft.current).catch(() => setDraftStatus('error'));
    } finally { operation.current = false; setSubmitting(undefined); }
  }
  function accept(ids: string[]) {
    if (!flushTimes()) return;
    if (modelStale(historyRef.current.doc)) { setError('草稿已变更，请重新校准'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => {
      const result = results.get(line.id); if (!ids.includes(line.id) || result?.time == null) return line;
      const time = Math.max(0, result.time - doc.offset);
      const words = result.words?.map(word => ({ ...word, start: Math.max(0, word.start - doc.offset), end: Math.max(0, word.end - doc.offset) }));
      return { ...line, time: line.locked ? line.time : time, words };
    }) }));
  }
  function reviewNext() {
    const lines = doc.lines.filter(line => { const state = candidate(line); return state.result?.time != null && (!state.applied || state.result.warning); });
    if (!lines.length) { setNotice('候选已全部应用，可继续试听'); return; }
    const line = lines[(lines.findIndex(item => item.id === editId) + 1) % lines.length];
    chooseLine(line.id, true); audition(Math.max(0, results.get(line.id)!.time! - 1500));
  }
  async function resolveServer(keepDraft: boolean) {
    if (!serverCopy || operation.current || !flushTimes()) return;
    if (!window.confirm(keepDraft ? '保留当前草稿，后续保存将覆盖已查看的服务器歌词？' : '用服务器版本替换当前草稿？')) return;
    operation.current = true; setBusy(true);
    try {
      const { track: latest } = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`);
      if (latest.lyricsVersion !== serverCopy.lyricsVersion || latest.audioVersion !== serverCopy.audioVersion) { setServerCopy(latest); throw new Error('服务器版本再次变更，请查看后重新选择'); }
      setBase({ lyricsText: latest.lyricsText || '', lyricsVersion: latest.lyricsVersion || '', audioVersion: latest.audioVersion || '' });
      if (!keepDraft) { change(reconcileDocument(latest.lyricsText || '', historyRef.current.doc)); setSource(false); }
      if (latest.audioVersion !== base.audioVersion) { player.endAudition(); setPeaks([]); setWaveJob(undefined); setAudioTrack(latest); updateRange([0, Math.round(latest.duration * 1000)]); setLoop(false); setWaveView({ zoom: 4, follow: true, start: 0 }); }
      setJob(undefined); setModelInput(undefined); setReviewOnly(false); setServerCopy(undefined); setError('');
      setNotice(keepDraft ? '已保留草稿，请确认内容后保存' : '已载入服务器歌词');
    } finally { operation.current = false; setBusy(false); }
  }
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || document.querySelector('.playback-conflict')) return;
    const target = event.target as HTMLElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!event.repeat) void save(); return; }
    if (!ready || busy) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void close(); return; }
    if (isTyping(target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !source) { event.preventDefault(); if (flushTimes()) { if (event.shiftKey) redo(); else undo(); } }
    else if (!event.ctrlKey && !event.metaKey && !source && event.key.toLowerCase() === 'k' && !event.repeat) { event.preventDefault(); mark(); }
    else if (!event.ctrlKey && !event.metaKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (event.shiftKey && !source) {
          const lines = doc.lines.filter(isStampable), index = lines.findIndex(line => line.id === stampIdRef.current), next = lines[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (next) { chooseLine(next.id, true); audition((next.time ?? 0) + doc.offset - 1500); }
        } else if (player.trackId === track.id) player.seek(player.getPosition() + (event.key === 'ArrowLeft' ? -5 : 5));
      } else if (!source) {
        const index = visibleLines.findIndex(line => line.id === stampIdRef.current), line = visibleLines[index < 0 ? event.key === 'ArrowUp' ? visibleLines.length - 1 : 0 : index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (line) chooseLine(line.id);
      }
    }
  });
  useEffect(() => { document.addEventListener('keydown', onKey, true); return () => document.removeEventListener('keydown', onKey, true); }, []);
  useEffect(() => {
    let active = true;
    void loadLyricDraft<Draft>(draftKey.current).then(saved => {
      if (!active || !saved) return;
      installHistory(saved.history || { past: [], doc: saved.doc, future: [] }); setBase(saved.base); setRaw(saved.raw || ''); setSource(!!saved.source); setJob(saved.job); setWaveJob(saved.waveJob); setModelInput(saved.modelInput);
      const workspace = saved.workspace;
      setEditId(workspace?.editId || saved.doc.lines[0]?.id || ''); setSelected(new Set(workspace?.selected || (saved.doc.lines[0] ? [saved.doc.lines[0].id] : [])));
      setTarget(workspace?.stampId ?? workspace?.editId ?? saved.doc.lines.find(line => isStampable(line) && !line.locked)?.id ?? ''); setAutoAdvance(workspace?.autoAdvance ?? false);
      if (workspace) {
        updateRange(workspace.range); setRate(workspace.rate); setLoop(workspace.loop); setStep(workspace.step); setFollowLyrics(workspace.followLyrics); setWaveView(workspace.waveView); setFind(workspace.find); setReplacement(workspace.replacement); setReviewOnly(workspace.reviewOnly); scroll.current = workspace.scroll;
      }
      const changed = saved.base.lyricsVersion !== track.lyricsVersion || saved.base.audioVersion !== track.audioVersion;
      if (changed) { setServerCopy(track); setNotice('已恢复草稿，服务器版本已变更，请查看并选择版本'); }
      else if ((saved.source ? saved.raw || '' : comparable(saved.doc)) !== saved.base.lyricsText && (saved.source ? saved.raw || '' : comparable(saved.doc)) !== comparable(parseDocument(saved.base.lyricsText))) setNotice('已恢复未写回的草稿');
    }).catch(() => { if (active) setDraftStatus('error'); }).finally(() => { if (active) setReady(true); });
    const abort = new AbortController();
    void read<{ jobs: Job[] }>(`/tracks/${encodeURIComponent(track.id)}/lyrics-jobs`, abort.signal).then(value => { if (!active) return; const waveform = value.jobs.find(item => item.kind === 'waveform' && item.audioVersion === track.audioVersion && item.status === 'done'); if (waveform?.peaks) setPeaks(waveform.peaks); }).catch(() => undefined);
    return () => { active = false; abort.abort(); mounted.current = false; latestPlayer.current.endAudition(); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    rowList.current?.scrollTo({ top: scroll.current[0], behavior: 'instant' }); calibrationPane.current?.scrollTo({ top: scroll.current[1], behavior: 'instant' }); body.current?.scrollTo({ top: scroll.current[2], behavior: 'instant' });
  }, [ready, source]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const value = await read<typeof tools>('/lyrics-tools', abort.signal, 10000); if (!abort.signal.aborted) setTools(value); } catch { if (!abort.signal.aborted) setTools({ available: false, alignment: false, languages: [] }); } if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 10000); }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!ready || busy || submitting || pendingTimes.size) return;
    setDraftStatus('saving');
    const timer = setTimeout(() => { if (!operation.current) void saveLyricDraft(draftKey.current, latestDraft.current).then(() => { if (mounted.current) setDraftStatus('saved'); }).catch(() => { if (mounted.current) setDraftStatus('error'); }); }, 600);
    return () => clearTimeout(timer);
  }, [doc, base, raw, source, job, waveJob, modelInput, ready, busy, submitting, editId, stampId, autoAdvance, selected, range, rate, loop, step, followLyrics, waveView, find, replacement, reviewOnly, pendingTimes.size]);
  const unload = useEffectEvent((event: BeforeUnloadEvent) => { if (dirty || busy || submitting) { event.preventDefault(); event.returnValue = ''; } });
  useEffect(() => { window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, []);
  useEffect(() => {
    if (!activeJob(job) && !activeJob(waveJob)) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (activeJob(job)) { const result = await read<{ job: Job }>(`/lyrics-jobs/${job!.id}`, abort.signal); setJob(result.job); }
        if (activeJob(waveJob)) { const result = await read<{ job: Job }>(`/lyrics-jobs/${waveJob!.id}`, abort.signal); setWaveJob(result.job); if (result.job.peaks) setPeaks(result.job.peaks); }
      } catch (failure) { if (!abort.signal.aborted) setError(messageOf(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 300); return () => { abort.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, waveJob?.id, waveJob?.status]);
  const repeatLoop = useEffectEvent(() => {
    const control = latestPlayer.current;
    if (loop && validRange() && control.auditionTrack?.id === track.id && control.playing && !control.audioRef.current?.seeking && (control.getPosition() * 1000 >= rangeRef.current[1] || control.getPosition() * 1000 < rangeRef.current[0])) control.seek(rangeRef.current[0] / 1000);
  });
  useEffect(() => {
    if (!loop || !player.playing) return;
    let frame = 0; const tick = () => { repeatLoop(); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [loop, player.playing]);
  useEffect(() => { setMatchIndex(-1); }, [find, source]);

  const protectedOperation = busy || !!submitting || !ready;
  const ownPlayback = player.trackId === track.id;
  const appliedCount = doc.lines.filter(line => candidate(line).result && candidate(line).applied).length;
  const timedCount = previewDoc.lines.filter(line => line.time !== null).length;
  const totalCount = previewDoc.lines.filter(line => line.text.trim() || line.time !== null).length;
  const filtering = reviewOnly && job?.status === 'done';
  return <TimeContext.Provider value={timeControls.current}><Modal title={`${track.title} · 歌词工作台`} className="lyrics-workbench" wide isolate onClose={() => void close()}>
    <fieldset className="lyric-work-top" disabled={protectedOperation}>
      <div className="lyric-mode"><button className={!source ? 'active' : ''} onClick={() => { if (source) switchSource(); }}>逐行</button><button className={source ? 'active' : ''} onClick={() => { if (!source) switchSource(); }}>源码</button></div>
      {source && <button className="text-button" title="移除空行和行首空白" onClick={formatSource}>格式化</button>}
      <span className="muted">{timedCount} / {totalCount} 行已打点</span>
      <button className="icon-button" aria-label="撤销" disabled={source || !history.past.length} onClick={() => { if (flushTimes()) undo(); }}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做" disabled={source || !history.future.length} onClick={() => { if (flushTimes()) redo(); }}><Redo2 size={17} /></button>
      <button className="text-button" onClick={() => fileInput.current?.click()}><Upload size={15} />导入</button>
      <button className="text-button" onClick={() => { if (flushTimes()) downloadLyrics(source ? raw : comparable(historyRef.current.doc), `${track.title}.${previewDoc.lines.some(line => line.time !== null) ? 'lrc' : 'txt'}`); }}><Download size={15} />导出</button>
      <input ref={fileInput} type="file" hidden accept=".lrc,.txt" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void act(async () => { if (!flushTimes() || totalCount && !window.confirm('导入将替换当前歌词，可撤销。继续？')) return; const text = await importLyrics(file), next = parseDocument(text); change(next); setTarget(next.lines.find(line => isStampable(line) && !line.locked)?.id || ''); setRaw(text); setSelected(new Set()); setReviewOnly(false); }); }} />
    </fieldset>
    {(error || notice) && <div className={`lyric-notice ${error ? 'error-text' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button className="text-button" onClick={() => { setError(''); setNotice(''); }}>关闭</button></div>}
    {serverCopy && <div className={`lyric-server-copy ${conflict ? 'conflict' : ''}`}><div className="lyric-server-heading"><strong>{conflict ? serverCopy.audioVersion !== base.audioVersion ? '音频版本已变更' : '歌词版本已变更' : '服务器版本与编辑基准一致'}</strong><button className="text-button" onClick={() => setServerCopy(undefined)} disabled={conflict}>关闭对比</button></div><div className="lyric-version-comparison"><label>当前草稿<textarea readOnly aria-label="当前草稿对比" value={currentText} /></label><label>服务器歌词<textarea readOnly aria-label="服务器歌词" value={serverCopy.lyricsText || ''} /></label></div><div><button className="text-button" disabled={protectedOperation} onClick={() => void act(() => resolveServer(false))}>载入服务器版本</button><button className="text-button" disabled={protectedOperation} onClick={() => void act(() => resolveServer(true))}>保留草稿继续编辑</button><button className="text-button" disabled={protectedOperation} onClick={() => void checkServer()}>重新检查</button></div></div>}
    <fieldset className="lyric-transport" disabled={!ready || busy}>
      <button className="round-play" aria-label="校准试听" aria-busy={ownPlayback && player.loading} onClick={toggleAudition}>{ownPlayback && player.loading ? <LoaderCircle size={19} className="spin" /> : ownPlayback && player.playRequested ? <Pause size={19} /> : <Play size={19} />}</button>
      <span className="lyric-clock">{timeLabel(ownPlayback ? player.position * 1000 : 0)}</span>
      <span className="lyric-play-context">{ownPlayback ? player.auditionTrack ? '校准试听' : '队列播放' : player.playRequested ? '队列正在播放其他曲目' : '尚未试听'}</span>
      <select aria-label="试听速度" value={rate} onChange={event => { const next = Number(event.target.value); setRate(next); if (player.auditionTrack?.id === track.id) player.setPlaybackRate(next); }}>{[0.5, 0.75, 1, 1.25].map(value => <option key={value} value={value}>{value}×</option>)}</select>
      <label className="lyric-volume">音量<input type="range" aria-label="试听音量" min={0} max={1} step={0.05} value={player.snapshot.volume} onChange={event => player.setVolume(Number(event.target.value))} /></label>
      {player.auditionTrack && <button className="text-button" onClick={() => player.endAudition()}>结束试听</button>}
      {!source && <div className="lyric-stamp-tools">
        <span className="lyric-stamp-target" aria-live="polite" title={stampTarget?.text}><kbd>K</kbd><span>{stampTarget ? `→ 第 ${doc.lines.indexOf(stampTarget) + 1} 行 · ${stampTarget.text || '空行'}` : '点击行号选择打点目标'}</span></span>
        <button className="text-button" aria-label="打点目标提前" disabled={!!stampUnavailable || stampTarget?.time === null} onClick={() => nudgeTarget(-step)}>提前</button><button className="text-button" aria-label="打点目标延后" disabled={!!stampUnavailable || stampTarget?.time === null} onClick={() => nudgeTarget(step)}>延后</button>
        <button className="text-button lyric-stamp-button" disabled={!!stampUnavailable} onClick={mark}>打点 <kbd>K</kbd></button>
        <label><input type="checkbox" checked={autoAdvance} onChange={event => { setAutoAdvance(event.target.checked); setStampIssue(undefined); }} />自动下一句</label>
        {stampTarget && stampUnavailable && <small>{stampUnavailable}</small>}
      </div>}
      {ownPlayback && player.failure && <span className="error-text">{player.failure}<button className="text-button" onClick={toggleAudition}>重试</button></span>}
    </fieldset>
    <fieldset className="lyric-work-body" ref={body} disabled={!ready || busy} onScroll={event => { scroll.current[2] = event.currentTarget.scrollTop; }}>
      <section className="lyric-edit-pane">
        {source ? <textarea ref={sourceInput} className="lyric-source" aria-label="歌词源码" spellCheck={false} value={raw} onChange={event => setRaw(event.target.value)} /> : <>
          <div className="lyric-edit-tools"><label><input type="checkbox" aria-label="选择全部歌词" checked={visibleLines.length > 0 && visibleLines.every(line => selected.has(line.id))} onChange={event => setSelected(new Set(event.target.checked ? visibleLines.map(line => line.id) : []))} />全选</label><span>{chosen.length} 行已选</span><button className="text-button" disabled={!chosen.length} onClick={() => shift(-step)}>提前</button><button className="text-button" disabled={!chosen.length} onClick={() => shift(step)}>延后</button><select aria-label="调整步长" value={step} onChange={event => setStep(Number(event.target.value))}>{[10, 50, 100, 200, 500, 1000].map(value => <option key={value} value={value}>{value} ms</option>)}</select><button className="text-button" disabled={!chosen.length} onClick={() => { if (flushTimes()) change(old => ({ ...old, lines: old.lines.map(line => selected.has(line.id) && !line.locked && !line.translation ? moveLine(line, null) : line) })); }}>清除时间</button></div>
          <div className="lyric-row-list" ref={rowList} onScroll={event => { scroll.current[0] = event.currentTarget.scrollTop; }} onWheel={() => { manualScrollUntil.current = Date.now() + 4000; }} onTouchMove={() => { manualScrollUntil.current = Date.now() + 4000; }}>
            {visibleLines.map(line => {
              const index = doc.lines.indexOf(line), state = candidate(line), result = state.result;
              const active = line.time !== null && preview.lines[current]?.time === (line.time + doc.offset) / 1000 && ownPlayback;
              const warning = line.time !== null && (line.time + doc.offset > audioTrack.duration * 1000 || index > 0 && doc.lines[index - 1].time !== null && line.time < doc.lines[index - 1].time!) ? '时间顺序或范围需检查' : '';
              return <Fragment key={line.id}>
                {!filtering && <button className="lyric-insert-gap" aria-label={index === 0 ? '在开头新增一行' : `在第 ${index} 行后新增一行`} onClick={() => insertLine(index)}><Plus size={12} /></button>}
                <div className={`lyric-edit-row ${selected.has(line.id) ? 'selected' : ''} ${editId === line.id ? 'editing' : ''} ${stampId === line.id ? 'targeted' : ''} ${active ? 'playing' : ''} ${find && line.text.includes(find) ? 'matched' : ''}`} onClick={event => { if (event.target === event.currentTarget) chooseLine(line.id); }}>
                {stampFlash?.id === line.id && <span key={stampFlash.sequence} className="lyric-stamp-flash" aria-hidden="true" />}
                <input type="checkbox" aria-label={`选择第 ${index + 1} 行`} checked={selected.has(line.id)} onChange={event => { setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(line.id); else next.delete(line.id); return next; }); }} />
                <button className="lyric-row-number" aria-label={`将第 ${index + 1} 行设为打点目标`} aria-pressed={stampId === line.id} title="选择打点目标，不改变播放位置" onClick={() => chooseLine(line.id)}>{String(index + 1).padStart(2, '0')}{stampId === line.id && <kbd>K</kbd>}</button>
                <button className="icon-button lyric-row-audition" aria-label={`试听第 ${index + 1} 行`} onClick={() => { if (flushTimes()) { const currentLine = historyRef.current.doc.lines.find(item => item.id === line.id); if (currentLine) audition(Math.max(0, (currentLine.time ?? 0) + historyRef.current.doc.offset - 1500)); } }}><Play size={13} /></button>
                <TimeInput label={`第 ${index + 1} 行时间`} value={line.time === null ? null : line.time + doc.offset} disabled={line.translation} onChange={value => update(line.id, item => moveLine(item, value === null ? null : value - historyRef.current.doc.offset))} />
                <textarea ref={element => { if (element) lineInputs.current.set(line.id, element); else lineInputs.current.delete(line.id); }} rows={1} aria-label={`第 ${index + 1} 行歌词`} value={line.text} onFocus={() => setEditId(line.id)} onChange={event => update(line.id, item => ({ ...item, text: event.target.value, words: undefined, pronunciation: undefined }), `text:${line.id}`)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); splitLine(line.id); } }} />
                <button className={`icon-button ${line.locked ? 'accent' : ''}`} aria-label={`${line.locked ? '解锁' : '锁定'}第 ${index + 1} 行锚点`} title="锁定后跳过自动打点，可手工调整锚点时间" disabled={line.time === null || line.translation} onClick={() => { if (flushTimes()) update(line.id, item => ({ ...item, locked: !item.locked, anchorBase: item.locked ? undefined : item.time ?? undefined })); }}><LockKeyhole size={14} /></button>
                {index > 0 && <button className={`lyric-link ${line.translation ? 'active' : ''}`} title="译文跟随上一行时间" onClick={() => { if (flushTimes()) update(line.id, item => ({ ...item, translation: !item.translation, time: !item.translation ? historyRef.current.doc.lines[index - 1].time : item.time })); }}>{line.translation ? '译' : '联'}</button>}
                {stampIssue?.id === line.id && <div className="lyric-stamp-issue" role="alert">{stampIssue.message}</div>}
                {(result || warning) && <div className="lyric-candidate">{warning || result?.warning}{result?.time != null && <><span>{state.applied ? '已应用' : `建议 ${timeLabel(result.time)}`}</span>{!state.applied && <span>{line.time === null ? '未打点' : `${result.time - line.time - doc.offset > 0 ? '+' : ''}${Math.round(result.time - line.time - doc.offset)} ms`}</span>}<button className="text-button" disabled={stale || state.applied} onClick={() => accept([line.id])}><Check size={12} />{state.applied ? '已应用' : '应用'}</button><button className="text-button" onClick={() => audition(Math.max(0, result.time! - 1500))}>试听建议</button></>}</div>}
              </div></Fragment>;
            })}
            {!filtering && <button className="lyric-insert-gap lyric-insert-end" aria-label="在末尾新增一行" onClick={() => insertLine(doc.lines.length)}><Plus size={12} /><span>新增一行</span></button>}
            {!visibleLines.length && <p className="lyric-list-empty">{reviewOnly ? '候选已全部应用' : '导入歌词或添加一行开始编辑'}</p>}
          </div>
          <div className="lyric-structure-tools"><label className="lyric-follow"><input type="checkbox" checked={followLyrics} onChange={event => setFollowLyrics(event.target.checked)} />歌词跟随</label><span>编辑第 {Math.max(0, doc.lines.findIndex(line => line.id === editId) + 1)} 行</span><button className="text-button" onClick={() => addLine(false)}><Plus size={14} />上方新增</button><button className="text-button" onClick={() => addLine(true)}>下方新增</button><button className="text-button" disabled={!editing} onClick={() => splitLine()}>拆行</button><button className="text-button" disabled={chosen.length < 2} onClick={mergeLines}>合行</button>{([-1, 1] as const).map(direction => <button className="text-button" key={direction} disabled={!editing} onClick={() => { if (flushTimes()) change(old => { const lines = [...old.lines], index = lines.findIndex(line => line.id === editId), target = index + direction; if (target < 0 || target >= lines.length) return old; [lines[index], lines[target]] = [lines[target], lines[index]]; return { ...old, lines }; }); }}>{direction < 0 ? '上移' : '下移'}</button>)}<button className="text-button" disabled={!chosen.length} onClick={() => { if (flushTimes()) change(old => ({ ...old, lines: old.lines.filter(line => !selected.has(line.id)) })); }}><Trash2 size={13} />删行</button></div>
        </>}
        <div className="lyric-replace"><input aria-label="查找歌词" placeholder="查找" value={find} onChange={event => setFind(event.target.value)} /><span className="lyric-match-count">{find ? `${matchCount} ${source ? '处' : '行'}` : ''}</span><button className="text-button" disabled={!matchCount} onClick={() => findNext(-1)}>上一处</button><button className="text-button" disabled={!matchCount} onClick={() => findNext(1)}>下一处</button><input aria-label="替换文字" placeholder="替换为" value={replacement} onChange={event => setReplacement(event.target.value)} /><button className="text-button" disabled={!matchCount} onClick={() => replace('one')}>替换一处</button>{!source && <button className="text-button" disabled={!find || !chosen.length} onClick={() => replace('selected')}>替换所选</button>}<button className="text-button" disabled={!matchCount} onClick={() => replace('all')}>全部替换</button></div>
      </section>
      <section className="lyric-calibration-pane" ref={calibrationPane} onScroll={event => { scroll.current[1] = event.currentTarget.scrollTop; }}>
        <div className="lyric-range"><label>A<TimeInput label="选段开始时间" required value={range[0]} onChange={value => { if (value !== null) updateRange([value, rangeRef.current[1]]); }} /></label><button className="text-button" disabled={!ownPlayback} onClick={() => updateRange([Math.round(player.getPosition() * 1000), range[1]])}>设 A</button><label>B<TimeInput label="选段结束时间" required value={range[1]} onChange={value => { if (value !== null) updateRange([rangeRef.current[0], value]); }} /></label><button className="text-button" disabled={!ownPlayback} onClick={() => updateRange([range[0], Math.round(player.getPosition() * 1000)])}>设 B</button><label><input type="checkbox" checked={loop} onChange={event => { if (event.target.checked && (!flushTimes() || !validRange())) { setError('选段必须满足 0 ≤ A < B ≤ 曲目时长'); return; } setLoop(event.target.checked); }} />选段循环</label><button className="text-button" disabled={!chosen.some(line => line.time !== null)} onClick={() => {
          if (!flushTimes()) return;
          const document = historyRef.current.doc;
          const times = document.lines.filter(line => selected.has(line.id) && line.time !== null).map(line => line.time! + document.offset).sort((a, b) => a - b);
          if (!times.length) return;
          const next = document.lines.filter(line => line.time !== null && line.time + document.offset > times.at(-1)!).sort((a, b) => a.time! - b.time!)[0];
          updateRange([Math.max(0, times[0] - 1500), Math.min(audioTrack.duration * 1000, next ? next.time! + document.offset : audioTrack.duration * 1000)]);
        }}>按所选行设范围</button>{!validRange() && <span className="error-text">A/B 范围无效，请调整后试听或校准</span>}</div>
        <div className="lyric-audio-status" role="status">{preload.phase === 'loading' ? <><progress max={1} value={preload.progress} /><span>加载全曲 {Math.round(preload.progress * 100)}%</span></> : preload.phase === 'ready' ? <span>全曲已加载</span> : <><span>{preload.message}</span>{preload.phase === 'error' && <button className="text-button" onClick={preload.retry}>重试</button>}</>}</div>
        {waveformPeaks.length > 0 ? <LyricWaveform peaks={waveformPeaks} duration={audioTrack.duration * 1000} lines={source ? [] : doc.lines} offset={doc.offset} selected={selected} editId={editId} range={range} view={waveView} onView={setWaveView} position={ownPlayback ? player.position * 1000 : 0} getPosition={() => latestPlayer.current.trackId === track.id ? latestPlayer.current.getPosition() * 1000 : 0} playing={ownPlayback && player.playing} onSelect={setEditId} onMove={(id, time) => { if (ready && !busy && !source && flushTimes()) update(id, line => moveLine(line, time)); }} onSeek={time => { if (ready && !busy && flushTimes()) audition(time); }} /> : <div className="lyric-wave-empty">{preload.wave === 'pending' ? <span>{preload.phase === 'loading' ? '加载音频后生成波形' : '生成波形…'}</span> : <button className="button secondary" disabled={!tools.available || activeJob(waveJob) || !!submitting || conflict} onClick={() => void act(() => submit('waveform'))}>{submitting === 'waveform' ? '提交中…' : activeJob(waveJob) ? waveJob?.phase : '服务器生成波形'}</button>}{waveJob?.error && <p className="error-text">{waveJob.error}</p>}</div>}
        <fieldset className="lyric-offset" disabled={source}><label>整体偏移<input type="number" aria-label="整体偏移毫秒" value={doc.offset} step={step} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && flushTimes()) change(old => ({ ...old, offset: value }), 'offset'); }} /><span>ms</span></label><button className="text-button" onClick={() => { if (flushTimes()) change(old => ({ ...old, offset: old.offset - step })); }}>提前</button><button className="text-button" onClick={() => { if (flushTimes()) change(old => ({ ...old, offset: old.offset + step })); }}>延后</button><button className="text-button" onClick={interpolate}>锚点校准</button></fieldset>
        <div className="lyric-preview" aria-label="歌词试听预览">{!preview.fullyTimed && <small>局部预览 · 还有未打点行</small>}{ownPlayback && preview.lines[current] ? preview.lines.slice(Math.max(0, current - 1), current + 2).map((line, index) => <p key={`${line.time}-${index}`} className={line.time === preview.lines[current].time ? 'active' : ''}><LyricText line={line} sungThrough={line.time === preview.lines[current].time ? words[currentWord]?.time ?? -Infinity : -Infinity} /></p>) : <p>{preview.lines.length ? '试听后预览歌词' : '为歌词打点后试听预览'}</p>}</div>
        <details className="lyric-model" open><summary><Sparkles size={17} />模型校准 <small>{tools.languages.join(' / ').replace('zh', '中文').replace('en', '英语')}</small></summary><div className="lyric-model-actions"><button className="button secondary" disabled={source || !tools.alignment || activeJob(job) || !!submitting || conflict} onClick={() => void act(() => submit('align', true))}>{submitting === 'align' ? '提交中…' : '校准整首'}</button><button className="button secondary" disabled={source || !tools.alignment || activeJob(job) || !!submitting || conflict || !chosen.length || !validRange()} onClick={() => void act(() => submit('align'))}>校准所选行</button></div>{!tools.alignment && <p className="muted">模型服务未就绪，可继续人工校准。</p>}{activeJob(job) && <div className="lyric-job-progress"><progress max={1} value={job!.progress} /><span>{job!.status === 'queued' ? '等待校准' : job!.phase}</span><button className="text-button" onClick={() => void act(async () => { const result = await request<{ job: Job }>(`/lyrics-jobs/${job!.id}`, { method: 'DELETE' }); setJob(result.job); })}>取消</button></div>}{job?.status === 'error' && <p className="error-text">{job.error}</p>}{job?.status === 'cancelled' && <p className="muted">校准已取消，可重新提交。</p>}{job?.status === 'done' && <div className="lyric-model-review"><span>{stale ? '草稿已变更，请重新校准' : `${appliedCount} / ${job.results?.length || 0} 行已应用`}</span><button className="text-button" disabled={stale || appliedCount === job.results?.length} onClick={() => accept(job.results?.map(item => item.id) || [])}>应用全部</button><button className="text-button" onClick={reviewNext}>下一项试听</button><label><input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} />只看待复核</label><button className="text-button" onClick={() => { setJob(undefined); setModelInput(undefined); setReviewOnly(false); }}>丢弃候选</button></div>}</details>
        {!source && editing && !editing.translation && <label className="lyric-pronunciation">第 {doc.lines.indexOf(editing) + 1} 行发音<input aria-label="发音校正" placeholder="拼音、英语词或音素，空格分隔" title="留空自动；英语音素用 / 连接，如 l/ah/v" value={editing.pronunciation || ''} onChange={event => update(editing.id, line => ({ ...line, pronunciation: event.target.value }), `pronunciation:${editing.id}`)} /></label>}
        {!source && !!editing?.words?.length && <details className="lyric-word-editor" open><summary>第 {doc.lines.indexOf(editing) + 1} 行逐字时间</summary>{editing.words!.map((word, index) => <div key={index}><span>{word.text}</span><TimeInput label={`字词 ${index + 1} 开始`} required value={word.start + doc.offset} onChange={value => { if (value !== null) update(editing.id, line => ({ ...line, words: line.words?.map((item, i) => i === index ? { ...item, start: Math.max(0, value - historyRef.current.doc.offset) } : item) })); }} /></div>)}</details>}
        <button className="text-button lyric-server-version" onClick={() => void checkServer()}>查看服务器版本</button>
      </section>
    </fieldset>
    <footer className="modal-footer"><span role="status">{busy ? '验证并写回中…' : submitting ? '正在提交校准…' : !ready ? '读取工作位置…' : dirty ? `未写回 · ${pendingTimes.size ? '时间待确认' : draftStatus === 'error' ? '草稿保存失败，请导出' : draftStatus === 'saving' ? '草稿保存中…' : '草稿已保留'}` : draftStatus === 'error' ? '文件已保存 · 工作位置保存失败' : '已写回'}</span><div><button className="button secondary" disabled={protectedOperation} onClick={() => void close()}>收起</button><button className="button primary" disabled={protectedOperation || !dirty || conflict} onClick={() => void act(save)}>{busy ? '写回中…' : '保存并写回'}</button></div></footer>
  </Modal></TimeContext.Provider>;
}

function editorTab(): string {
  try { let id = sessionStorage.getItem('lilt.lyrics-editor-tab'); if (!id) { id = identity(); sessionStorage.setItem('lilt.lyrics-editor-tab', id); } return id; }
  catch { return identity(); }
}
