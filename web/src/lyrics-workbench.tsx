import { createContext, Fragment, memo, useCallback, useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, Check, Download, GitCompareArrows, Link2, LoaderCircle, LockKeyhole, Music2, Pause, Play, Plus, Redo2, Repeat, RotateCw, Scissors, Search, Sparkles, Trash2, Undo2, Unlock, Upload, Volume2, X } from 'lucide-react';
import './lyrics-workbench.css';
import { Modal } from './components';
import { ApiError, json, messageOf, read, request } from './api';
import type { Track } from './types';
import type { Player } from './player';
import { identity, parseLyrics, type LyricLine } from './utils';
import { peekCachedLyrics, useActiveLyric } from './lyrics';
import { LyricText } from './lyric-text';
import { loadLyricDraft, saveLyricDraft } from './storage';
import { downloadLyrics, importLyrics, joinLineText, moveLine, parseDocument, readTime, reconcileDocument, serializeDocument, timeLabel, type EditLine, type LyricDocument, type LyricWord } from './lyric-document';
import { LyricWaveform, type WaveView } from './lyric-waveform';
import { cacheWaveformPeaks, useWorkbenchAudio } from './workbench-audio';

type Result = { id: string; time: number | null; words?: LyricWord[]; confidence: number; warning?: string };
type Job = { id: string; kind: 'align' | 'waveform'; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; phase: string; progress: number; audioVersion: string; draftVersion: string; results?: Result[]; peaks?: number[]; error?: string };
type Base = { lyricsText: string; lyricsVersion: string; audioVersion: string };
type ModelInput = { lines: EditLine[]; offset: number; audioVersion: string };
type History = { past: LyricDocument[]; doc: LyricDocument; future: LyricDocument[]; pastTargets?: string[]; futureTargets?: string[] };
type Workspace = { editId: string; stampId?: string; autoAdvance?: boolean; selected: string[]; range: [number, number]; rate: number; loop: boolean; step: number; followLyrics: boolean; waveView: WaveView; scroll: number[]; find: string; replacement: string; reviewOnly: boolean };
type Draft = { doc: LyricDocument; base: Base; raw?: string; source?: boolean; job?: Job; waveJob?: Job; modelInput?: ModelInput; history?: History; workspace?: Workspace };
type CandidateState = { result?: Result; applied: boolean };
type TimeControls = {
  inputs: Map<string, () => boolean>;
  reverts: Map<HTMLElement, () => boolean>;
  pending: (id: string, pending: boolean) => void;
};

const TimeContext = createContext<TimeControls | undefined>(undefined);
const comparable = serializeDocument;
const activeJob = (job?: Job) => job?.status === 'queued' || job?.status === 'running';
const isStampable = (line: EditLine) => !line.translation && !line.credit;
const isOriginal = (line: EditLine) => isStampable(line) && !!line.text.trim();
const isTyping = (target: HTMLElement) => target.isContentEditable || !!target.closest('input:not([type="checkbox"]):not([type="range"]),textarea,select,[role="textbox"]');
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25] as const;
const STEP_OPTIONS = [10, 50, 100, 200, 500, 1000] as const;
const EMPTY_LINES: EditLine[] = [];
const EMPTY_CANDIDATE: CandidateState = { applied: false };
const formatStep = (ms: number) => ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;

function TimeInput({ value, onChange, label, disabled, required = false, className = '' }: {
  value: number | null; onChange: (time: number | null) => void; label: string; disabled?: boolean; required?: boolean; className?: string;
}) {
  const controls = useContext(TimeContext)!;
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
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

  function revertIfDirty() {
    const clean = timeLabel(props.current.value);
    if (textRef.current === clean && !error) return false;
    textRef.current = clean; setText(clean); setError(''); controls.pending(id, false);
    return true;
  }

  useEffect(() => {
    textRef.current = timeLabel(value); setText(textRef.current); setError(''); controls.pending(id, false);
  }, [value, disabled]);

  useEffect(() => {
    const element = inputRef.current;
    controls.inputs.set(id, commit);
    if (element) controls.reverts.set(element, revertIfDirty);
    return () => {
      controls.inputs.delete(id);
      if (element) controls.reverts.delete(element);
      controls.pending(id, false);
    };
  }, [controls, id]);

  return <input
    ref={inputRef}
    aria-label={label}
    aria-invalid={!!error}
    title={error || undefined}
    className={`lyric-time-input ${className}`}
    value={text}
    placeholder="未打点"
    disabled={disabled}
    onChange={event => {
      textRef.current = event.target.value;
      setText(textRef.current);
      setError('');
      controls.pending(id, textRef.current !== timeLabel(value));
    }}
    onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }}
  />;
}

/** Isolated 60fps clock: updates DOM directly during playback so the row list never re-renders on clock ticks. */
const WorkbenchClock = memo(function WorkbenchClock({
  ownPlayback, playing, position, getPosition, duration,
}: {
  ownPlayback: boolean; playing: boolean; position: number; getPosition: () => number; duration: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const paintRef = useRef<() => void>(() => undefined);
  paintRef.current = () => {
    if (ref.current) ref.current.textContent = timeLabel(ownPlayback ? getPosition() * 1000 : 0);
  };
  useLayoutEffect(() => { paintRef.current(); }, [ownPlayback, playing, position]);
  useEffect(() => {
    if (!ownPlayback || !playing) return;
    let frame = 0;
    const tick = () => { paintRef.current(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ownPlayback, playing]);
  return <span className="lyric-clock">
    <span ref={ref} />
    <small> / {timeLabel(duration * 1000)}</small>
  </span>;
});

/** Isolated live karaoke preview strip so word-level highlights never re-render the lyric sheet. */
const WorkbenchPreviewStrip = memo(function WorkbenchPreviewStrip({
  lines, fullyTimed, ownPlayback, playing, position, getPosition,
}: {
  lines: LyricLine[]; fullyTimed: boolean; ownPlayback: boolean; playing: boolean; position: number; getPosition: () => number;
}) {
  const active = ownPlayback && playing;
  const current = useActiveLyric(lines, position, getPosition, active);
  const words = useMemo(() => lines.flatMap(line => line.words || []), [lines]);
  const currentWord = useActiveLyric(words, position, getPosition, active);
  const currLine = ownPlayback && current >= 0 ? lines[current] : undefined;
  const prevLine = ownPlayback && current > 0 ? lines[current - 1] : undefined;
  const nextLine = ownPlayback && current >= 0 ? lines[current + 1] : lines[0];
  const sungThrough = words[currentWord]?.time ?? -Infinity;

  return <div className="lyric-preview-strip" aria-label="歌词试听预览">
    {!fullyTimed && <span className="lyric-partial-tag">局部预览</span>}
    {currLine ? <>
      <span className="preview-side prev">{prevLine ? (prevLine.text || '♪') : '—'}</span>
      <span className="preview-current"><LyricText line={currLine} sungThrough={sungThrough} /></span>
      <span className="preview-side next">{nextLine ? (nextLine.text || '♪') : '—'}</span>
    </> : <span className="preview-idle">{lines.length ? '按 Space 试听，按 K 给橙色目标行打点' : '导入歌词或新增一行，试听后按 K 实时打点'}</span>}
  </div>;
});

type RowActions = {
  registerInput: (id: string, el: HTMLTextAreaElement | null) => void;
  insertAt: (index: number) => void;
  chooseLine: (id: string) => void;
  toggleSelect: (id: string, checked: boolean) => void;
  auditionLine: (id: string) => void;
  changeTime: (id: string, value: number | null) => void;
  focusLine: (id: string) => void;
  changeText: (id: string, text: string) => void;
  splitLine: (id: string) => void;
  toggleLock: (id: string) => void;
  toggleTranslation: (id: string, index: number) => void;
  acceptCandidate: (id: string) => void;
  auditionTime: (ms: number) => void;
};

/** Memoized individual lyric row: prevents O(N) re-renders when typing, stamping, or tracking playback. */
const LyricRow = memo(function LyricRow({
  line, index, offset, isSelected, isTargeted, isEditing, isPlaying, playingNow, isMatched,
  warning, candidateState, stampIssue, stampFlashSeq, stale, filtering, actions,
}: {
  line: EditLine; index: number; offset: number;
  isSelected: boolean; isTargeted: boolean; isEditing: boolean; isPlaying: boolean; playingNow: boolean; isMatched: boolean;
  warning: string; candidateState: CandidateState; stampIssue?: string; stampFlashSeq?: number;
  stale: boolean; filtering: boolean; actions: RowActions;
}) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const result = candidateState.result;

  const autoResize = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(30, el.scrollHeight)}px`;
  }, []);

  useLayoutEffect(() => { autoResize(); }, [line.text, autoResize]);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) { lastWidth = el.clientWidth; autoResize(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoResize]);

  return <Fragment>
    {!filtering && <div className="lyric-insert-divider">
      <button type="button" className="lyric-insert-hit" aria-label={index === 0 ? '在开头新增一行' : `在第 ${index} 行后新增一行`} onClick={() => actions.insertAt(index)}>
        <span><Plus size={10} /> 插入行</span>
      </button>
    </div>}
    <div
      className={`lyric-edit-row ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''} ${isTargeted ? 'targeted' : ''} ${isPlaying ? 'playing' : ''} ${isMatched ? 'matched' : ''} ${line.translation ? 'is-translation' : ''}`}
      onClick={event => { if (event.target === event.currentTarget) actions.chooseLine(line.id); }}
    >
      {stampFlashSeq !== undefined && <span key={stampFlashSeq} className="lyric-stamp-flash" aria-hidden="true" />}
      <input
        type="checkbox"
        aria-label={`选择第 ${index + 1} 行`}
        checked={isSelected}
        onChange={event => actions.toggleSelect(line.id, event.target.checked)}
      />
      <button
        type="button"
        className="lyric-row-number"
        aria-label={`将第 ${index + 1} 行设为打点目标`}
        aria-pressed={isTargeted}
        title="点击设为 K 打点目标（不改变播放位置）"
        onClick={() => actions.chooseLine(line.id)}
      >
        <span>{String(index + 1).padStart(2, '0')}</span>
        {isTargeted && <kbd>K</kbd>}
      </button>
      <button
        type="button"
        className={`icon-button lyric-row-audition ${isPlaying ? 'active' : ''}`}
        aria-label={`试听第 ${index + 1} 行`}
        title="从本行前 1.5s 试听"
        onClick={() => actions.auditionLine(line.id)}
      >
        {isPlaying && playingNow ? <span className="lyric-eq" aria-hidden="true"><i /><i /><i /></span> : <Play size={12} fill={isPlaying ? 'currentColor' : 'none'} />}
      </button>
      <TimeInput
        label={`第 ${index + 1} 行时间`}
        value={line.time === null ? null : line.time + offset}
        disabled={line.translation}
        onChange={value => actions.changeTime(line.id, value)}
      />
      <div className="lyric-text-cell">
        {line.translation && <span className="lyric-row-tag">↳ 译</span>}
        {line.credit && <span className="lyric-row-tag">署名</span>}
        <textarea
          ref={element => { textRef.current = element; actions.registerInput(line.id, element); }}
          rows={1}
          aria-label={`第 ${index + 1} 行歌词`}
          placeholder={line.time !== null ? '♪ 空行（间奏标记）' : '输入歌词…'}
          value={line.text}
          onFocus={() => actions.focusLine(line.id)}
          onChange={event => actions.changeText(line.id, event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              actions.splitLine(line.id);
            }
          }}
        />
      </div>
      <div className="lyric-row-flags">
        {!!line.words?.length && <span className="lyric-words-badge" title="含逐字时间戳">逐字</span>}
        <button
          type="button"
          className={`icon-button lyric-flag-btn ${line.locked ? 'is-active' : ''}`}
          aria-label={`${line.locked ? '解锁' : '锁定'}第 ${index + 1} 行锚点`}
          title={line.locked ? '解锁锚点' : '锁定锚点（跳过自动打点，用于锚点校准）'}
          disabled={line.time === null || line.translation}
          onClick={() => actions.toggleLock(line.id)}
        >
          {line.locked ? <LockKeyhole size={13} /> : <Unlock size={13} />}
        </button>
        {index > 0 ? <button
          type="button"
          className={`lyric-link lyric-flag-btn ${line.translation ? 'is-active' : ''}`}
          title="译文跟随上一行时间"
          onClick={() => actions.toggleTranslation(line.id, index)}
        >{line.translation ? '译' : '联'}</button> : <span className="lyric-flag-spacer" />}
      </div>
      {stampIssue && <div className="lyric-stamp-issue" role="alert">{stampIssue}</div>}
      {(result || warning) && <div className="lyric-candidate">
        {(warning || result?.warning) && <span className="lyric-candidate-warn">{warning || result?.warning}</span>}
        {result?.time != null && <>
          <span className="mono">{candidateState.applied ? '✓ 已应用' : `建议 ${timeLabel(result.time)}`}</span>
          {!candidateState.applied && <span className="mono">{line.time === null ? '未打点' : `${result.time - line.time - offset > 0 ? '+' : ''}${Math.round(result.time - line.time - offset)}ms`}</span>}
          <button type="button" className="text-button" disabled={stale || candidateState.applied} onClick={() => actions.acceptCandidate(line.id)}>
            <Check size={12} />{candidateState.applied ? '已应用' : '应用'}
          </button>
          <button type="button" className="text-button" onClick={() => actions.auditionTime(Math.max(0, result.time! - 1500))}>试听建议</button>
        </>}
      </div>}
    </div>
  </Fragment>;
});

export function LyricsWorkbench({ track, player, onClose, onSaved }: { track: Track; player: Player; onClose: () => void; onSaved: (track: Track) => void }) {
  const initialLyrics = track.lyricsText ?? peekCachedLyrics(track) ?? '';
  const [history, setHistory] = useState<History>(() => ({ past: [], doc: parseDocument(initialLyrics), future: [] }));
  const historyRef = useRef(history); historyRef.current = history;
  const doc = history.doc;
  const [base, setBase] = useState<Base>({ lyricsText: initialLyrics, lyricsVersion: track.lyricsVersion || '', audioVersion: track.audioVersion || '' });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [editId, setEditId] = useState(doc.lines[0]?.id || '');
  const [stampId, setStampId] = useState(() => doc.lines.find(line => isStampable(line) && !line.locked)?.id || '');
  const stampIdRef = useRef(stampId); stampIdRef.current = stampId;
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [stampIssue, setStampIssue] = useState<{ id: string; message: string }>();
  const [stampFlash, setStampFlash] = useState<{ id: string; sequence: number }>();
  const stampSequence = useRef(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
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
  const [findOpen, setFindOpen] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [serverCopy, setServerCopy] = useState<Track>();
  const [inspectorTab, setInspectorTab] = useState<'tune' | 'model'>('tune');
  const [mobileTab, setMobileTab] = useState<'edit' | 'wave' | 'model'>('edit');
  const [draftStatus, setDraftStatus] = useState<'saving' | 'saved' | 'error'>('saved');
  const [pendingTimes, setPendingTimes] = useState(new Set<string>());
  const timeControls = useRef<TimeControls>({ inputs: new Map(), reverts: new Map(), pending: () => undefined });
  timeControls.current.pending = (id, pending) => setPendingTimes(old => {
    if (old.has(id) === pending) return old;
    const next = new Set(old); if (pending) next.add(id); else next.delete(id); return next;
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const lineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef('');
  const rowList = useRef<HTMLDivElement>(null);
  const inspectorScroll = useRef<HTMLDivElement>(null);
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
  const preview = useMemo(() => parseLyrics(currentText), [currentText]);
  const previewDoc = useMemo(() => source ? reconcileDocument(raw, doc) : doc, [source, raw, doc]);
  const lineIndexMap = useMemo(() => new Map(doc.lines.map((line, index) => [line.id, index])), [doc.lines]);
  const chosen = useMemo(() => doc.lines.filter(line => selected.has(line.id)), [doc.lines, selected]);
  const chosenOriginalCount = useMemo(() => chosen.filter(isOriginal).length, [chosen]);
  const lockedAnchorCount = useMemo(() => doc.lines.filter(line => line.locked && line.time !== null && line.anchorBase !== undefined).length, [doc.lines]);
  const editing = useMemo(() => doc.lines.find(line => line.id === editId), [doc.lines, editId]);
  const stampTarget = useMemo(() => doc.lines.find(line => line.id === stampId), [doc.lines, stampId]);
  const stampUnavailable = !stampTarget ? '点击行号选择打点目标' : stampTarget.locked ? '先解锁这句锚点再打点' : stampTarget.translation ? '译文跟随原文，请选择原文打点' : stampTarget.credit ? '署名行不参与打点' : '';
  const ownPlayback = player.trackId === track.id;
  const current = useActiveLyric(preview.lines, player.position, player.getPosition, player.playing && ownPlayback);
  const playingTime = ownPlayback && current >= 0 ? preview.lines[current]?.time : undefined;

  const results = useMemo(() => new Map(job?.results?.map(result => [result.id, result])), [job?.results]);
  const conflict = !!serverCopy && (serverCopy.lyricsVersion !== base.lyricsVersion || serverCopy.audioVersion !== base.audioVersion);

  const checkStale = useCallback((document: LyricDocument) => {
    if (!modelInput) return false;
    const ids = new Set(modelInput.lines.map(line => line.id));
    const order = document.lines.filter(line => ids.has(line.id)).map(line => line.id);
    const lines = new Map(document.lines.map(line => [line.id, line]));
    return conflict || source && raw !== serialized || modelInput.audioVersion !== base.audioVersion || modelInput.offset !== document.offset || modelInput.lines.some((old, index) => {
      const line = lines.get(old.id), result = results.get(old.id);
      return !line || order[index] !== old.id || line.text !== old.text || line.pronunciation !== old.pronunciation || !!line.translation !== !!old.translation || !!line.locked !== !!old.locked || line.time !== old.time && line.time !== (result?.time == null ? undefined : Math.max(0, result.time - document.offset));
    });
  }, [modelInput, conflict, source, raw, serialized, base.audioVersion, results]);
  const stale = useMemo(() => checkStale(doc), [checkStale, doc]);

  const candidateMap = useMemo(() => {
    const map = new Map<string, CandidateState>();
    if (!results.size) return map;
    for (const line of doc.lines) {
      const result = results.get(line.id);
      if (result?.time == null) { if (result) map.set(line.id, { result, applied: false }); continue; }
      const expectedWords = result.words?.map(word => ({ ...word, start: Math.max(0, word.start - doc.offset), end: Math.max(0, word.end - doc.offset) }));
      const applied = (line.locked || line.time === Math.max(0, result.time - doc.offset)) && JSON.stringify(line.words) === JSON.stringify(expectedWords);
      map.set(line.id, { result, applied });
    }
    return map;
  }, [doc.lines, doc.offset, results]);

  const matches = useMemo(() => find ? doc.lines.filter(line => line.text.includes(find)) : [], [doc.lines, find]);
  const rawMatches = useMemo(() => {
    const out: number[] = [];
    if (find) for (let at = raw.indexOf(find); at >= 0; at = raw.indexOf(find, at + find.length)) out.push(at);
    return out;
  }, [raw, find]);
  const matchCount = source ? rawMatches.length : matches.length;

  const filtering = reviewOnly && job?.status === 'done';
  const visibleLines = useMemo(() => filtering ? doc.lines.filter(line => {
    const state = candidateMap.get(line.id);
    return state?.result && (!state.applied || state.result.warning);
  }) : doc.lines, [filtering, doc.lines, candidateMap]);

  const appliedCount = useMemo(() => {
    let count = 0;
    for (const state of candidateMap.values()) if (state.result && state.applied) count++;
    return count;
  }, [candidateMap]);
  const pendingReviewCount = useMemo(() => {
    if (job?.status !== 'done') return 0;
    let count = 0;
    for (const state of candidateMap.values()) if (state.result?.time != null && (!state.applied || state.result.warning)) count++;
    return count;
  }, [job?.status, candidateMap]);

  const timedCount = useMemo(() => previewDoc.lines.filter(line => line.time !== null).length, [previewDoc.lines]);
  const totalCount = useMemo(() => previewDoc.lines.filter(line => line.text.trim() || line.time !== null).length, [previewDoc.lines]);

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

  function revealLine(id: string) {
    const list = rowList.current, row = lineInputs.current.get(id)?.closest('.lyric-edit-row');
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    if (target.top < bounds.top + 8 || target.bottom > bounds.bottom - 8) {
      list.scrollBy({ top: target.top - bounds.top - list.clientHeight * 0.35, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
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
    latestPlayer.current.startAudition(audioTrack, Math.max(0, Math.min(audioTrack.duration * 1000, time)) / 1000);
    latestPlayer.current.setPlaybackRate(rate);
  }
  function chooseLine(id: string) { setEditId(id); setTarget(id); revealLine(id); }

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
    if (!followLyrics || !player.playing || !ownPlayback || playingTime === undefined || Date.now() < manualScrollUntil.current) return;
    if (stampIdRef.current) return;
    if (document.activeElement instanceof HTMLElement && isTyping(document.activeElement) && document.activeElement.closest('.lyric-edit-row')) return;
    const line = doc.lines.find(item => item.time !== null && (item.time + doc.offset) / 1000 === playingTime);
    if (line) revealLine(line.id);
  }, [playingTime, player.playing, ownPlayback, followLyrics, stampId]);

  function mark() {
    if (!flushTimes()) return;
    if (latestPlayer.current.trackId !== track.id) { setError('请先试听当前曲目'); return; }
    const document = historyRef.current.doc;
    const start = document.lines.findIndex(line => line.id === stampIdRef.current), line = document.lines[start];
    if (!line) { setNotice('点击行号选择打点目标'); return; }
    function reject(message: string) { setStampIssue({ id: line.id, message }); revealLine(line.id); }
    if (line.locked) { reject('先解锁这句锚点再打点'); return; }
    if (!isStampable(line)) { reject(line.translation ? '译文跟随原文，请选择原文打点' : '署名行不参与打点'); return; }
    const time = Math.round(latestPlayer.current.getPosition() * 1000) - document.offset;
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
    const currentDoc = historyRef.current.doc;
    if (currentDoc.lines.some(line => selected.has(line.id) && !line.translation && !line.locked && line.time !== null && line.time + amount < 0 && !line.credit)) { setError('调整后时间不能为负'); return; }
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
    setNotice('已按锁定锚点重新校准区间时间');
  }
  function insertLine(index: number) {
    if (!flushTimes()) return;
    const line: EditLine = { id: identity(), text: '', time: null };
    pendingFocus.current = line.id;
    change(old => {
      const lines = [...old.lines];
      if (lines[index]?.translation) lines[index] = { ...lines[index], translation: false };
      lines.splice(index, 0, line); return { ...old, lines };
    });
    chooseLine(line.id);
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
    chooseLine(next.id);
  }
  function mergeLines() {
    if (!flushTimes()) return;
    const currentDoc = historyRef.current.doc, lines = currentDoc.lines.filter(line => selected.has(line.id));
    if (lines.length < 2) return;
    const indices = lines.map(line => currentDoc.lines.indexOf(line));
    if (indices.at(-1)! - indices[0] + 1 !== indices.length) { setError('请选择连续的歌词行'); return; }
    if (lines.some(line => line.translation || line.credit)) { setError('请先解除译文关联，署名行不能合并'); return; }
    change(old => ({ ...old, lines: old.lines.flatMap(line => line.id === lines[0].id ? [{ ...line, text: joinLineText(lines), words: undefined, pronunciation: undefined }] : selected.has(line.id) ? [] : [line]) }));
    setSelected(new Set());
    chooseLine(lines[0].id);
  }
  function deleteLines(ids: Iterable<string>) {
    if (!flushTimes()) return;
    const removed = new Set(ids), currentDoc = historyRef.current.doc;
    const index = currentDoc.lines.findIndex(line => line.id === editId);
    const lines = currentDoc.lines.flatMap((line, i) => removed.has(line.id) ? [] : [line.translation && i > 0 && removed.has(currentDoc.lines[i - 1].id) ? { ...line, translation: false } : line]);
    if (lines.length === currentDoc.lines.length) return;
    if (removed.has(editId)) setEditId(currentDoc.lines.slice(index + 1).find(line => !removed.has(line.id))?.id || currentDoc.lines.slice(0, index).reverse().find(line => !removed.has(line.id))?.id || '');
    change({ ...currentDoc, lines });
  }
  function setRangeFromSelected() {
    if (!flushTimes()) return;
    const document = historyRef.current.doc;
    const times = document.lines.filter(line => selected.has(line.id) && line.time !== null).map(line => line.time! + document.offset).sort((a, b) => a - b);
    if (!times.length) return;
    const next = document.lines.filter(line => line.time !== null && line.time + document.offset > times.at(-1)!).sort((a, b) => a.time! - b.time!)[0];
    updateRange([Math.max(0, times[0] - 1500), Math.min(audioTrack.duration * 1000, next ? next.time! + document.offset : audioTrack.duration * 1000)]);
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
    if (document.lines.some(line => line.words?.some((word, i, ws) => word.start < 0 || i > 0 && word.start < ws[i - 1].start))) { setError('逐字时间必须按演唱顺序排列'); return; }
    if (new TextEncoder().encode(text).length > 1024 ** 2) { setError('歌词不能超过 1 MiB'); return; }
    if (!text.trim() && base.lyricsText.trim() && !window.confirm('清空并写回当前歌曲的歌词？')) return;
    operation.current = true; setBusy(true); setError('');
    try {
      const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { lyricsText: text, expectedLyricsVersion: base.lyricsVersion, expectedAudioVersion: base.audioVersion });
      const nextBase = { lyricsText: text, lyricsVersion: result.track.lyricsVersion || '', audioVersion: result.track.audioVersion || '' };
      setBase(nextBase); latestDraft.current.base = nextBase;
      onSaved(result.track); setNotice('已写回歌曲文件'); setServerCopy(undefined);
      if (modelInput && modelInput.audioVersion === base.audioVersion) { const input = { ...modelInput, audioVersion: nextBase.audioVersion }; setModelInput(input); latestDraft.current.modelInput = input; }
      await saveLyricDraft(draftKey.current, latestDraft.current).then(() => setDraftStatus('saved')).catch(() => setDraftStatus('error'));
    } catch (failure) { setError(messageOf(failure)); if (failure instanceof ApiError && failure.status === 409) await checkServer(); }
    finally { operation.current = false; setBusy(false); }
  }
  async function close() {
    if (operation.current) return;
    if (!ready) { latestPlayer.current.endAudition(); onClose(); return; }
    if (!flushTimes()) return;
    operation.current = true; setBusy(true);
    try { await saveLyricDraft(draftKey.current, latestDraft.current); }
    catch { if (dirty && !window.confirm('无法保存草稿，仍要关闭并放弃修改？')) { operation.current = false; setBusy(false); return; } }
    latestPlayer.current.endAudition(); onClose();
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
    if (checkStale(historyRef.current.doc)) { setError('草稿已变更，请重新校准'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => {
      const result = results.get(line.id); if (!ids.includes(line.id) || result?.time == null) return line;
      const time = Math.max(0, result.time - old.offset);
      const words = result.words?.map(word => ({ ...word, start: Math.max(0, word.start - old.offset), end: Math.max(0, word.end - old.offset) }));
      return { ...line, time: line.locked ? line.time : time, words };
    }) }));
  }
  function reviewNext() {
    const lines = doc.lines.filter(line => { const state = candidateMap.get(line.id); return state?.result?.time != null && (!state.applied || state.result.warning); });
    if (!lines.length) { setNotice('候选已全部应用，可继续试听'); return; }
    const line = lines[(lines.findIndex(item => item.id === editId) + 1) % lines.length];
    chooseLine(line.id); audition(Math.max(0, results.get(line.id)!.time! - 1500));
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
      if (latest.audioVersion !== base.audioVersion) { latestPlayer.current.endAudition(); setPeaks([]); setWaveJob(undefined); setAudioTrack(latest); updateRange([0, Math.round(latest.duration * 1000)]); setLoop(false); setWaveView({ zoom: 4, follow: true, start: 0 }); }
      setJob(undefined); setModelInput(undefined); setReviewOnly(false); setServerCopy(undefined); setError('');
      setNotice(keepDraft ? '已保留草稿，请确认内容后保存' : '已载入服务器歌词');
    } finally { operation.current = false; setBusy(false); }
  }

  // Stable callbacks for memoized LyricRow items
  const rowActions = useRef<RowActions>({} as RowActions);
  rowActions.current = {
    registerInput: (id, el) => { if (el) lineInputs.current.set(id, el); else lineInputs.current.delete(id); },
    insertAt: index => insertLine(index),
    chooseLine: id => chooseLine(id),
    toggleSelect: (id, checked) => setSelected(old => { const next = new Set(old); if (checked) next.add(id); else next.delete(id); return next; }),
    auditionLine: id => {
      if (!flushTimes()) return;
      const line = historyRef.current.doc.lines.find(item => item.id === id);
      if (line) audition(Math.max(0, (line.time ?? 0) + historyRef.current.doc.offset - 1500));
    },
    changeTime: (id, value) => update(id, item => moveLine(item, value === null ? null : value - historyRef.current.doc.offset)),
    focusLine: id => setEditId(id),
    changeText: (id, text) => update(id, item => ({ ...item, text, words: undefined, pronunciation: undefined }), `text:${id}`),
    splitLine: id => splitLine(id),
    toggleLock: id => { if (flushTimes()) update(id, item => ({ ...item, locked: !item.locked, anchorBase: item.locked ? undefined : item.time ?? undefined })); },
    toggleTranslation: (id, index) => { if (flushTimes()) update(id, item => ({ ...item, translation: !item.translation, time: !item.translation ? historyRef.current.doc.lines[index - 1].time : item.time })); },
    acceptCandidate: id => accept([id]),
    auditionTime: ms => audition(ms),
  };
  const stableRowActions = useMemo<RowActions>(() => ({
    registerInput: (id, el) => rowActions.current.registerInput(id, el),
    insertAt: index => rowActions.current.insertAt(index),
    chooseLine: id => rowActions.current.chooseLine(id),
    toggleSelect: (id, checked) => rowActions.current.toggleSelect(id, checked),
    auditionLine: id => rowActions.current.auditionLine(id),
    changeTime: (id, value) => rowActions.current.changeTime(id, value),
    focusLine: id => rowActions.current.focusLine(id),
    changeText: (id, text) => rowActions.current.changeText(id, text),
    splitLine: id => rowActions.current.splitLine(id),
    toggleLock: id => rowActions.current.toggleLock(id),
    toggleTranslation: (id, index) => rowActions.current.toggleTranslation(id, index),
    acceptCandidate: id => rowActions.current.acceptCandidate(id),
    auditionTime: ms => rowActions.current.auditionTime(ms),
  }), []);

  const handleWaveSelect = useCallback((id: string) => setEditId(id), []);
  const handleWaveMove = useEffectEvent((id: string, time: number) => {
    if (ready && !busy && !source && flushTimes()) update(id, line => moveLine(line, time));
  });
  const handleWaveSeek = useEffectEvent((time: number) => {
    if (ready && !busy && flushTimes()) audition(time);
  });
  const handleWaveRange = useEffectEvent((next: [number, number]) => {
    if (ready && !busy) updateRange(next);
  });
  const getAudioPositionMs = useCallback(() => latestPlayer.current.trackId === track.id ? latestPlayer.current.getPosition() * 1000 : 0, [track.id]);

  // Global workbench keyboard shortcuts (including Cmd/Ctrl+Z everywhere in row mode!)
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || document.querySelector('.playback-conflict')) return;
    const target = event.target as HTMLElement;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 's') { event.preventDefault(); if (!event.repeat) void save(); return; }
    if (mod && key === 'f') {
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
      return;
    }
    if (!ready || busy) {
      if (event.key === 'Escape' && !mod && !busy) { event.preventDefault(); void close(); }
      return;
    }
    if (event.key === 'Escape' && !mod) {
      event.preventDefault();
      if (serverCopy && !conflict) { setServerCopy(undefined); return; }
      if (findOpen && target.closest('.lyric-replace')) { setFindOpen(false); return; }
      void close();
      return;
    }

    // Cmd/Ctrl+Z (and Cmd/Ctrl+Shift+Z / Ctrl+Y) triggers workbench undo/redo everywhere in row mode
    // except utility non-document inputs (find/replace & A/B range).
    if (mod && !source && (key === 'z' || (key === 'y' && event.ctrlKey && !event.metaKey))) {
      const inUtilityInput = !!target.closest('.lyric-replace, .lyric-ab-inline');
      if (!inUtilityInput) {
        event.preventDefault();
        const revert = timeControls.current.reverts.get(target);
        if (revert?.()) return;
        if (flushTimes()) {
          if (key === 'y' || event.shiftKey) redo();
          else undo();
        }
        return;
      }
    }

    if (isTyping(target)) return;
    if (!mod && !source && key === 'k' && !event.repeat) { event.preventDefault(); mark(); }
    else if (!mod && event.key.startsWith('Arrow')) {
      event.preventDefault();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (event.shiftKey && !source) {
          const lines = doc.lines.filter(isStampable), index = lines.findIndex(line => line.id === stampIdRef.current), next = lines[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (next) { chooseLine(next.id); audition((next.time ?? 0) + doc.offset - 1500); }
        } else if (latestPlayer.current.trackId === track.id) {
          latestPlayer.current.seek(latestPlayer.current.getPosition() + (event.key === 'ArrowLeft' ? -5 : 5));
        }
      } else if (!source) {
        const index = visibleLines.findIndex(line => line.id === stampIdRef.current);
        const line = visibleLines[index < 0 ? event.key === 'ArrowUp' ? visibleLines.length - 1 : 0 : index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (line) chooseLine(line.id);
      }
    }
  });
  useEffect(() => { document.addEventListener('keydown', onKey, true); return () => document.removeEventListener('keydown', onKey, true); }, []);

  // Parallel fast initialization: fetch authoritative track, local draft, and cached server waveform simultaneously.
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setLoadError('');

    const jobsTask = read<{ jobs: Job[] }>(`/tracks/${encodeURIComponent(track.id)}/lyrics-jobs`, abort.signal)
      .then(value => {
        if (!active) return;
        const waveform = value.jobs.find(item => item.kind === 'waveform' && item.audioVersion === track.audioVersion && item.status === 'done');
        if (waveform?.peaks) { setPeaks(waveform.peaks); cacheWaveformPeaks(track, waveform.peaks); }
      }).catch(() => undefined);

    void Promise.allSettled([
      read<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, abort.signal),
      loadLyricDraft<Draft>(draftKey.current),
      jobsTask,
    ]).then(([trackRes, draftRes]) => {
      if (!active) return;
      if (trackRes.status === 'rejected') {
        setLoadError(messageOf(trackRes.reason));
        return;
      }
      const fresh = trackRes.value.track;
      const saved = draftRes.status === 'fulfilled' ? draftRes.value : undefined;
      if (draftRes.status === 'rejected') setDraftStatus('error');
      setAudioTrack(fresh);

      if (saved) {
        installHistory(saved.history || { past: [], doc: saved.doc, future: [] });
        setBase(saved.base); setRaw(saved.raw || ''); setSource(!!saved.source);
        setJob(saved.job); setWaveJob(saved.waveJob); setModelInput(saved.modelInput);
        const workspace = saved.workspace;
        setEditId(workspace?.editId || saved.doc.lines[0]?.id || '');
        setSelected(new Set(workspace?.selected || []));
        setTarget(workspace?.stampId ?? workspace?.editId ?? saved.doc.lines.find(line => isStampable(line) && !line.locked)?.id ?? '');
        setAutoAdvance(workspace?.autoAdvance ?? false);
        if (workspace) {
          updateRange(workspace.range); setRate(workspace.rate); setLoop(workspace.loop); setStep(workspace.step);
          setFollowLyrics(workspace.followLyrics); setWaveView(workspace.waveView);
          setFind(workspace.find); setReplacement(workspace.replacement); setReviewOnly(workspace.reviewOnly);
          if (workspace.find) setFindOpen(true);
          scroll.current = workspace.scroll;
        }
        const changed = saved.base.lyricsVersion !== fresh.lyricsVersion || saved.base.audioVersion !== fresh.audioVersion;
        if (changed) { setServerCopy(fresh); setNotice('已恢复草稿，服务器版本已变更，请查看并选择版本'); }
        else if ((saved.source ? saved.raw || '' : comparable(saved.doc)) !== saved.base.lyricsText && (saved.source ? saved.raw || '' : comparable(saved.doc)) !== comparable(parseDocument(saved.base.lyricsText))) {
          setNotice('已恢复未写回的草稿');
        }
      } else {
        const parsed = parseDocument(fresh.lyricsText || '');
        installHistory({ past: [], doc: parsed, future: [] });
        setBase({ lyricsText: fresh.lyricsText || '', lyricsVersion: fresh.lyricsVersion || '', audioVersion: fresh.audioVersion || '' });
        setEditId(parsed.lines[0]?.id || '');
        setTarget(parsed.lines.find(line => isStampable(line) && !line.locked)?.id || '');
        updateRange([0, Math.round(fresh.duration * 1000)]);
      }
      setReady(true);
    });

    return () => { active = false; abort.abort(); };
  }, [track.id, loadAttempt]);

  useEffect(() => () => { mounted.current = false; latestPlayer.current.endAudition(); }, []);

  useEffect(() => {
    if (!ready) return;
    rowList.current?.scrollTo({ top: scroll.current[0], behavior: 'instant' });
    inspectorScroll.current?.scrollTo({ top: scroll.current[1], behavior: 'instant' });
    body.current?.scrollTo({ top: scroll.current[2], behavior: 'instant' });
  }, [ready, source]);

  // Check /lyrics-tools once on open; only poll periodically when Model tab is open or a job is active (keeps manual editing network-quiet).
  const needsToolPoll = inspectorTab === 'model' || mobileTab === 'model' || activeJob(job) || activeJob(waveJob);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await read<typeof tools>('/lyrics-tools', abort.signal, 10000);
        if (!abort.signal.aborted) setTools(value);
      } catch {
        if (!abort.signal.aborted) setTools({ available: false, alignment: false, languages: [] });
      }
      if (!abort.signal.aborted && needsToolPoll) timer = setTimeout(() => void poll(), 10000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [needsToolPoll]);

  // Debounced local IndexedDB draft backup (no server request)
  useEffect(() => {
    if (!ready || busy || submitting || pendingTimes.size) return;
    setDraftStatus('saving');
    const timer = setTimeout(() => {
      if (!operation.current) {
        void saveLyricDraft(draftKey.current, latestDraft.current)
          .then(() => { if (mounted.current) setDraftStatus('saved'); })
          .catch(() => { if (mounted.current) setDraftStatus('error'); });
      }
    }, 1000);
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
        if (activeJob(waveJob)) {
          const result = await read<{ job: Job }>(`/lyrics-jobs/${waveJob!.id}`, abort.signal);
          setWaveJob(result.job);
          if (result.job.peaks) { setPeaks(result.job.peaks); cacheWaveformPeaks(audioTrack, result.job.peaks); }
        }
      } catch (failure) { if (!abort.signal.aborted) setError(messageOf(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 300);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, waveJob?.id, waveJob?.status, audioTrack]);

  const repeatLoop = useEffectEvent(() => {
    const control = latestPlayer.current;
    if (loop && validRange() && control.auditionTrack?.id === track.id && control.playing && !control.audioRef.current?.seeking && (control.getPosition() * 1000 >= rangeRef.current[1] || control.getPosition() * 1000 < rangeRef.current[0])) {
      control.seek(rangeRef.current[0] / 1000);
    }
  });
  useEffect(() => {
    if (!loop || !player.playing) return;
    let frame = 0; const tick = () => { repeatLoop(); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, player.playing]);
  useEffect(() => { setMatchIndex(-1); }, [find, source]);

  const protectedOperation = busy || !!submitting || !ready;
  const stepLabel = formatStep(step);
  const editingIndex = editing ? (lineIndexMap.get(editing.id) ?? -1) : -1;
  const stampIndex = stampTarget ? (lineIndexMap.get(stampTarget.id) ?? -1) : -1;
  const rangeOk = validRange();
  const hasModelActivity = activeJob(job) || pendingReviewCount > 0;
  const langSummary = tools.languages.join(' / ').replace('zh', '中文').replace('en', '英语');

  const modelPanelContent = <div className="studio-panel-stack">
    <div className="studio-card">
      <div className="studio-card-head">
        <span className="studio-card-title"><Sparkles size={14} />SOFA 歌声对齐</span>
        <span className={`studio-pill ${tools.alignment ? 'is-ok' : ''}`}>{tools.alignment ? `${langSummary || '就绪'}` : '未就绪'}</span>
      </div>
      <div className="studio-model-grid">
        <button type="button" className="studio-btn" disabled={source || !tools.alignment || activeJob(job) || !!submitting || conflict} onClick={() => void act(() => submit('align', true))}>
          {submitting === 'align' ? '提交中…' : '校准整首'}
        </button>
        <button type="button" className="studio-btn" disabled={source || !tools.alignment || activeJob(job) || !!submitting || conflict || !chosenOriginalCount || !rangeOk} onClick={() => void act(() => submit('align'))}>
          校准所选 ({chosenOriginalCount})
        </button>
      </div>
      {!tools.alignment && <p className="studio-hint">模型服务未就绪，可继续人工打点与时间轴精修。</p>}
      {activeJob(job) && <div className="lyric-job-progress">
        <progress max={1} value={job!.progress} />
        <span>{job!.status === 'queued' ? '等待校准' : job!.phase}</span>
        <button type="button" className="text-button" onClick={() => void act(async () => { const result = await request<{ job: Job }>(`/lyrics-jobs/${job!.id}`, { method: 'DELETE' }); setJob(result.job); })}>取消</button>
      </div>}
      {job?.status === 'error' && <p className="error-text">{job.error}</p>}
      {job?.status === 'cancelled' && <p className="studio-hint">校准已取消，可重新提交。</p>}
    </div>

    {job?.status === 'done' && <div className="studio-card">
      <div className="studio-card-head">
        <span className="studio-card-title">候选结果复核</span>
        <span className="studio-pill is-accent mono">{stale ? '已过期' : `${appliedCount} / ${job.results?.length || 0}`}</span>
      </div>
      {stale && <p className="error-text">草稿关键内容已变更，请重新提交校准。</p>}
      <div className="studio-action-wrap">
        <button type="button" className="studio-btn primary" disabled={stale || appliedCount === job.results?.length} onClick={() => accept(job.results?.map(item => item.id) || [])}>应用全部</button>
        <button type="button" className="studio-btn" onClick={reviewNext}>下一项试听</button>
        <button type="button" className="studio-btn" onClick={() => { setJob(undefined); setModelInput(undefined); setReviewOnly(false); }}>丢弃候选</button>
      </div>
      <label className="studio-check">
        <input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} />
        列表只看待复核 / 带警告行
      </label>
    </div>}

    {!source && editing && !editing.translation && <div className="studio-card">
      <div className="studio-card-head">
        <span className="studio-card-title">第 {String(editingIndex + 1).padStart(2, '0')} 行发音校正</span>
      </div>
      <input
        className="studio-input"
        aria-label="发音校正"
        placeholder="拼音、英语词或 / 连接音素，空格分隔"
        title="留空自动；英语音素用 / 连接，如 l/ah/v"
        value={editing.pronunciation || ''}
        onChange={event => update(editing.id, line => ({ ...line, pronunciation: event.target.value }), `pronunciation:${editing.id}`)}
      />
      <p className="studio-hint">留空自动路由；如「我 luv 你」可填 <code>wo l/ah/v ni</code>。</p>
    </div>}
  </div>;

  return <TimeContext.Provider value={timeControls.current}>
    <Modal title={`${track.title} · 歌词工作台`} className="lyrics-workbench" wide isolate onClose={() => void close()}>

      {/* 1. UNIFIED COMPACT STUDIO HEADER */}
      <fieldset className="studio-header" disabled={protectedOperation}>
        <div className="studio-title-group">
          <span className="studio-badge-icon" aria-hidden="true"><Music2 size={14} /></span>
          <h2 title={track.title}>{track.title}</h2>
          <span className="studio-count-pill mono">{timedCount} / {totalCount} 已打点</span>
        </div>

        <div className="lyric-mode" role="tablist" aria-label="编辑模式">
          <button type="button" role="tab" aria-selected={!source} className={!source ? 'active' : ''} onClick={() => { if (source) switchSource(); }}>逐行</button>
          <button type="button" role="tab" aria-selected={source} className={source ? 'active' : ''} onClick={() => { if (!source) switchSource(); }}>源码</button>
        </div>
        {source && <button type="button" className="studio-header-btn" title="移除空行和行首空白" onClick={formatSource}>格式化</button>}

        <div className="studio-header-tools">
          <button type="button" className="icon-button" aria-label="撤销" title="撤销 (⌘Z / Ctrl+Z)" disabled={source || !history.past.length} onClick={() => { if (flushTimes()) undo(); }}><Undo2 size={15} /></button>
          <button type="button" className="icon-button" aria-label="重做" title="重做 (⇧⌘Z / Ctrl+Y)" disabled={source || !history.future.length} onClick={() => { if (flushTimes()) redo(); }}><Redo2 size={15} /></button>
          <span className="studio-sep" aria-hidden="true" />
          <button type="button" className={`studio-header-btn ${findOpen ? 'active' : ''}`} title="查找与替换 (⌘F)" onClick={() => {
            setFindOpen(old => {
              const next = !old;
              if (next) requestAnimationFrame(() => findInput.current?.focus());
              return next;
            });
          }}><Search size={14} /><span>查找</span>{find && <small className="mono">{matchCount}</small>}</button>
          <button type="button" className="studio-header-btn" onClick={() => fileInput.current?.click()}><Upload size={14} /><span>导入</span></button>
          <button type="button" className="studio-header-btn" onClick={() => { if (flushTimes()) downloadLyrics(source ? raw : comparable(historyRef.current.doc), `${track.title}.${previewDoc.lines.some(line => line.time !== null) ? 'lrc' : 'txt'}`); }}><Download size={14} /><span>导出</span></button>
          <button type="button" className={`studio-header-btn ${conflict ? 'is-alert' : ''}`} onClick={() => void checkServer()}><GitCompareArrows size={14} /><span>版本对比</span></button>
          <button type="button" className="icon-button studio-close-btn" aria-label="关闭" onClick={() => void close()}><X size={18} /></button>
        </div>
        <input ref={fileInput} type="file" hidden accept=".lrc,.txt" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void act(async () => {
            if (!flushTimes() || totalCount && !window.confirm('导入将替换当前歌词，可撤销。继续？')) return;
            const text = await importLyrics(file), next = parseDocument(text);
            change(next);
            setTarget(next.lines.find(line => isStampable(line) && !line.locked)?.id || '');
            setRaw(text); setSelected(new Set()); setReviewOnly(false);
          });
        }} />
      </fieldset>

      {/* INLINE NOTICE / LOAD ERROR BANNER */}
      {(loadError || error || notice) && <div className={`lyric-notice ${loadError || error ? 'error-text' : ''}`} role={loadError || error ? 'alert' : 'status'}>
        <span>{loadError || error || notice}</span>
        {loadError
          ? <button type="button" className="text-button" onClick={() => setLoadAttempt(n => n + 1)}><RotateCw size={12} />重试加载</button>
          : <button type="button" className="text-button" onClick={() => { setError(''); setNotice(''); }}>关闭</button>}
      </div>}

      {/* MOBILE TAB SWITCHER (<= 860px only, pinned directly beneath header so its Y coordinate never jumps!) */}
      <nav className="studio-mobile-tabs" aria-label="工作台视图切换">
        <button type="button" className={mobileTab === 'edit' ? 'active' : ''} onClick={() => setMobileTab('edit')}>逐行编辑</button>
        <button type="button" className={mobileTab === 'wave' ? 'active' : ''} onClick={() => setMobileTab('wave')}>波形与精修</button>
        <button type="button" className={mobileTab === 'model' ? 'active' : ''} onClick={() => setMobileTab('model')}>模型校准{hasModelActivity && <i className="tab-dot" />}</button>
      </nav>

      {/* 2. FULL-WIDTH STUDIO TRANSPORT + A/B + WAVEFORM DECK */}
      <section className={`studio-wave-deck ${mobileTab === 'wave' ? 'mobile-expanded' : ''}`}>
        <fieldset className="lyric-transport" disabled={!ready || busy}>
          <button type="button" className={`studio-play-btn ${ownPlayback && player.playRequested ? 'is-playing' : ''}`} aria-label="校准试听" title="播放 / 暂停 (Space)" aria-busy={ownPlayback && player.loading} onClick={toggleAudition}>
            {ownPlayback && player.loading ? <LoaderCircle size={16} className="spin" /> : ownPlayback && player.playRequested ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>
          <WorkbenchClock ownPlayback={ownPlayback} playing={player.playing} position={player.position} getPosition={player.getPosition} duration={audioTrack.duration} />
          <span className={`lyric-play-context ${ownPlayback && player.auditionTrack ? 'is-audition' : ''}`}>
            {ownPlayback ? player.auditionTrack ? '校准试听' : '队列播放' : player.playRequested ? '队列播放其他曲目' : '尚未试听'}
          </span>
          {player.auditionTrack && <button type="button" className="wave-chip" onClick={() => player.endAudition()}>结束试听</button>}

          <div className="wave-speed-group" role="group" aria-label="试听速度">
            {SPEED_OPTIONS.map(value => <button key={value} type="button" className={rate === value ? 'active' : ''} aria-pressed={rate === value} onClick={() => {
              setRate(value);
              if (player.auditionTrack?.id === track.id) player.setPlaybackRate(value);
            }}>{value}×</button>)}
          </div>

          <label className="lyric-volume" title="试听音量">
            <Volume2 size={13} aria-hidden="true" />
            <input type="range" aria-label="试听音量" min={0} max={1} step={0.05} value={player.snapshot.volume} style={{ '--progress': `${player.snapshot.volume * 100}%` } as CSSProperties} onChange={event => player.setVolume(Number(event.target.value))} />
          </label>

          <span className="studio-sep wave-sep" aria-hidden="true" />

          {/* Inline A/B Loop Controls right above the waveform */}
          <div className="lyric-ab-inline">
            <label><span>A</span><TimeInput label="选段开始时间" required value={range[0]} onChange={value => { if (value !== null) updateRange([value, rangeRef.current[1]]); }} /></label>
            <button type="button" className="wave-chip" disabled={!ownPlayback} onClick={() => updateRange([Math.round(player.getPosition() * 1000), range[1]])}>设A</button>
            <label><span>B</span><TimeInput label="选段结束时间" required value={range[1]} onChange={value => { if (value !== null) updateRange([rangeRef.current[0], value]); }} /></label>
            <button type="button" className="wave-chip" disabled={!ownPlayback} onClick={() => updateRange([range[0], Math.round(player.getPosition() * 1000)])}>设B</button>
            <button type="button" className={`wave-chip ${loop ? 'active' : ''}`} aria-pressed={loop} onClick={() => {
              if (!loop && (!flushTimes() || !validRange())) { setError('选段必须满足 0 ≤ A < B ≤ 曲目时长'); return; }
              setLoop(old => !old);
            }}><Repeat size={11} />循环</button>
            {!rangeOk && <span className="error-text">A/B 无效</span>}
          </div>

          <div className="lyric-audio-status" role="status">
            {preload.phase === 'loading'
              ? <><progress max={1} value={preload.progress} /><span>预加载 {Math.round(preload.progress * 100)}%</span></>
              : preload.phase === 'ready'
                ? <span className="is-ready">全曲就绪</span>
                : <><span>{preload.message}</span>{preload.phase === 'error' && <button type="button" className="wave-chip" onClick={preload.retry}>重试</button>}</>}
          </div>

          {ownPlayback && player.failure && <span className="error-text">{player.failure}<button type="button" className="wave-chip" onClick={toggleAudition}>重试</button></span>}
        </fieldset>

        {/* Full-Width Waveform Canvas (desktop always visible; mobile visible on 'wave' tab) */}
        <div className="studio-wave-canvas-area">
          {waveformPeaks.length > 0
            ? <LyricWaveform
                peaks={waveformPeaks}
                duration={audioTrack.duration * 1000}
                lines={source ? EMPTY_LINES : doc.lines}
                offset={doc.offset}
                selected={selected}
                editId={editId}
                stampId={stampId}
                range={range}
                view={waveView}
                onView={setWaveView}
                position={ownPlayback && !player.playing ? player.position * 1000 : 0}
                getPosition={getAudioPositionMs}
                playing={ownPlayback && player.playing}
                onSelect={handleWaveSelect}
                onMove={handleWaveMove}
                onSeek={handleWaveSeek}
                onRange={handleWaveRange}
              />
            : <div className="lyric-wave-empty">
                {preload.wave === 'pending'
                  ? <div className="lyric-wave-loading">
                      <LoaderCircle size={15} className="spin" />
                      <span>{preload.phase === 'loading' ? `加载全曲音频生成波形 (${Math.round(preload.progress * 100)}%)，当前可先流式试听与编辑` : '本地解码生成波形…'}</span>
                    </div>
                  : <button type="button" className="studio-btn" disabled={!tools.available || activeJob(waveJob) || !!submitting || conflict} onClick={() => void act(() => submit('waveform'))}>
                      {submitting === 'waveform' ? '提交中…' : activeJob(waveJob) ? waveJob?.phase : '服务器生成波形'}
                    </button>}
                {waveJob?.error && <p className="error-text">{waveJob.error}</p>}
              </div>}
        </div>

        {/* Compact 1-Line Live Karaoke Strip */}
        <WorkbenchPreviewStrip lines={preview.lines} fullyTimed={preview.fullyTimed} ownPlayback={ownPlayback} playing={player.playing} position={player.position} getPosition={player.getPosition} />
      </section>

      {/* 3. MAIN WORKSPACE: PRIMARY LYRIC SHEET + FOCUSED INSPECTOR */}
      <fieldset className={`lyric-work-body mobile-tab-${mobileTab}`} ref={body} disabled={!ready || busy} onScroll={event => { scroll.current[2] = event.currentTarget.scrollTop; }}>

        {/* LEFT / MAIN: LYRIC SHEET */}
        <section className="lyric-edit-pane">
          {!source && <div className="lyric-stamp-bar">
            <div className="lyric-stamp-target" aria-live="polite" title={stampTarget?.text}>
              <kbd>K</kbd>
              <span>{stampTarget ? `→ 第 ${String(stampIndex + 1).padStart(2, '0')} 行 · ${stampTarget.text || '空行（间奏）'}` : '点击行号选择打点目标'}</span>
              {stampTarget && stampUnavailable && <small className="stamp-reason">{stampUnavailable}</small>}
            </div>
            <div className="lyric-stamp-actions">
              <button type="button" className="studio-nudge-btn mono" aria-label="打点目标提前" disabled={!!stampUnavailable || stampTarget?.time === null} onClick={() => nudgeTarget(-step)}>−{stepLabel}</button>
              <button type="button" className="studio-nudge-btn mono" aria-label="打点目标延后" disabled={!!stampUnavailable || stampTarget?.time === null} onClick={() => nudgeTarget(step)}>+{stepLabel}</button>
              <button type="button" className="studio-stamp-primary" disabled={!!stampUnavailable} onClick={mark}>打点 <kbd>K</kbd></button>
              <label className="studio-inline-check"><input type="checkbox" checked={autoAdvance} onChange={event => { setAutoAdvance(event.target.checked); setStampIssue(undefined); }} />自动下一句</label>
              <span className="studio-sep" aria-hidden="true" />
              <label className="studio-inline-check muted-check"><input type="checkbox" checked={followLyrics} onChange={event => setFollowLyrics(event.target.checked)} />歌词跟随</label>
            </div>
          </div>}

          {/* Contextual Bulk Selection Bar — Only visible when rows are checked! */}
          {!source && chosen.length > 0 && <div className="lyric-bulk-bar" role="toolbar" aria-label="批量操作">
            <span className="bulk-count mono">已选 {chosen.length} 行</span>
            <button type="button" className="studio-bulk-btn mono" onClick={() => shift(-step)}>所选 −{stepLabel}</button>
            <button type="button" className="studio-bulk-btn mono" onClick={() => shift(step)}>所选 +{stepLabel}</button>
            <button type="button" className="studio-bulk-btn" disabled={!chosen.some(line => line.time !== null)} onClick={setRangeFromSelected}>设为 A-B</button>
            <button type="button" className="studio-bulk-btn" disabled={chosen.length < 2} onClick={mergeLines}>合行</button>
            <button type="button" className="studio-bulk-btn" onClick={() => {
              if (flushTimes()) change(old => ({ ...old, lines: old.lines.map(line => selected.has(line.id) && !line.locked && !line.translation ? moveLine(line, null) : line) }));
            }}>清除时间</button>
            <button type="button" className="studio-bulk-btn is-danger" onClick={() => deleteLines(selected)}><Trash2 size={12} />删除所选</button>
            <button type="button" className="text-button bulk-clear" onClick={() => setSelected(new Set())}>取消选择</button>
          </div>}

          {/* Collapsible Find & Replace Bar */}
          {findOpen && <div className="lyric-replace">
            <input ref={findInput} aria-label="查找歌词" placeholder="查找…" value={find} onChange={event => setFind(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey ? -1 : 1); } }} />
            <span className="lyric-match-count mono">{find ? `${matchCount} ${source ? '处' : '行'}` : ''}</span>
            <button type="button" className="studio-bulk-btn" disabled={!matchCount} onClick={() => findNext(-1)}>上一处</button>
            <button type="button" className="studio-bulk-btn" disabled={!matchCount} onClick={() => findNext(1)}>下一处</button>
            <input aria-label="替换文字" placeholder="替换为…" value={replacement} onChange={event => setReplacement(event.target.value)} />
            <button type="button" className="studio-bulk-btn" disabled={!matchCount} onClick={() => replace('one')}>替换一处</button>
            {!source && <button type="button" className="studio-bulk-btn" disabled={!find || !chosen.length} onClick={() => replace('selected')}>替换所选</button>}
            <button type="button" className="studio-bulk-btn" disabled={!matchCount} onClick={() => replace('all')}>全部替换</button>
            <button type="button" className="icon-button" aria-label="收起查找" onClick={() => setFindOpen(false)}><X size={14} /></button>
          </div>}

          {source ? <textarea ref={sourceInput} className="lyric-source" aria-label="歌词源码" spellCheck={false} value={raw} onChange={event => setRaw(event.target.value)} /> : <>
            <div className="lyric-table-head">
              <input type="checkbox" aria-label="选择全部歌词" title="全选 / 取消全选" checked={visibleLines.length > 0 && visibleLines.every(line => selected.has(line.id))} onChange={event => setSelected(new Set(event.target.checked ? visibleLines.map(line => line.id) : []))} />
              <span>行号/K</span>
              <span>试听</span>
              <span>时间</span>
              <span>歌词内容</span>
              <span>锚点 / 译文</span>
            </div>
            <div className="lyric-row-list" ref={rowList} onScroll={event => { scroll.current[0] = event.currentTarget.scrollTop; }} onWheel={() => { manualScrollUntil.current = Date.now() + 4000; }} onTouchMove={() => { manualScrollUntil.current = Date.now() + 4000; }}>
              {visibleLines.map(line => {
                const index = lineIndexMap.get(line.id) ?? 0;
                const state = candidateMap.get(line.id) || EMPTY_CANDIDATE;
                const isPlaying = line.time !== null && playingTime !== undefined && playingTime === (line.time + doc.offset) / 1000;
                const warning = line.time !== null && (line.time + doc.offset > audioTrack.duration * 1000 || index > 0 && doc.lines[index - 1].time !== null && line.time < doc.lines[index - 1].time!) ? '时间顺序或范围需检查' : '';
                return <LyricRow
                  key={line.id}
                  line={line}
                  index={index}
                  offset={doc.offset}
                  isSelected={selected.has(line.id)}
                  isTargeted={stampId === line.id}
                  isEditing={editId === line.id}
                  isPlaying={isPlaying}
                  playingNow={player.playing}
                  isMatched={!!find && line.text.includes(find)}
                  warning={warning}
                  candidateState={state}
                  stampIssue={stampIssue?.id === line.id ? stampIssue.message : undefined}
                  stampFlashSeq={stampFlash?.id === line.id ? stampFlash.sequence : undefined}
                  stale={stale}
                  filtering={filtering}
                  actions={stableRowActions}
                />;
              })}
              {!filtering && ready && <button type="button" className="lyric-insert-end" aria-label="在末尾新增一行" onClick={() => insertLine(doc.lines.length)}><Plus size={13} /><span>在末尾新增一行</span></button>}
              {!visibleLines.length && <p className="lyric-list-empty">{!ready && !loadError ? '加载歌词与草稿…' : reviewOnly ? '候选已全部应用' : '导入歌词或新增一行开始编辑'}</p>}
            </div>
          </>}
        </section>

        {/* RIGHT: FOCUSED CONTEXTUAL INSPECTOR */}
        <aside className="studio-inspector">
          <div className="studio-inspector-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={inspectorTab === 'tune'} className={inspectorTab === 'tune' ? 'active' : ''} onClick={() => setInspectorTab('tune')}>精修与当前行</button>
            <button type="button" role="tab" aria-selected={inspectorTab === 'model'} className={inspectorTab === 'model' ? 'active' : ''} onClick={() => setInspectorTab('model')}>
              <span>模型校准</span>
              {activeJob(job) && <span className="studio-tab-badge">运行中</span>}
              {!activeJob(job) && pendingReviewCount > 0 && <span className="studio-tab-badge mono">{pendingReviewCount} 待审</span>}
            </button>
          </div>

          <div className="studio-inspector-body" ref={inspectorScroll} onScroll={event => { scroll.current[1] = event.currentTarget.scrollTop; }}>
            {inspectorTab === 'tune' ? <div className="studio-panel-stack">
              {/* Card 1: Shared Step + Overall Offset + Anchor Calibration */}
              <div className="studio-card">
                <div className="studio-card-head">
                  <span className="studio-card-title">微调步长与全局偏移</span>
                  <span className="studio-card-sub">统一作用于所有微调</span>
                </div>
                <div className="studio-step-grid" role="group" aria-label="调整步长">
                  {STEP_OPTIONS.map(value => <button key={value} type="button" className={step === value ? 'active' : ''} aria-pressed={step === value} onClick={() => setStep(value)}>{formatStep(value)}</button>)}
                </div>

                <fieldset className="studio-offset-row" disabled={source}>
                  <label>
                    <span>整体偏移</span>
                    <input type="number" aria-label="整体偏移毫秒" value={doc.offset} step={step} onChange={event => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value) && flushTimes()) change(old => ({ ...old, offset: value }), 'offset');
                    }} />
                    <small>ms</small>
                  </label>
                  <div className="studio-offset-btns">
                    <button type="button" className="studio-nudge-btn mono" onClick={() => { if (flushTimes()) change(old => ({ ...old, offset: old.offset - step })); }}>−{stepLabel}</button>
                    <button type="button" className="studio-nudge-btn mono" onClick={() => { if (flushTimes()) change(old => ({ ...old, offset: old.offset + step })); }}>+{stepLabel}</button>
                  </div>
                </fieldset>

                <div className="studio-anchor-row">
                  <div>
                    <strong>锚点线性校准</strong>
                    <span>{lockedAnchorCount >= 2 ? `已锁定 ${lockedAnchorCount} 个锚点，可按区间插值` : `已锁定 ${lockedAnchorCount} 个锚点（需锁定 ≥ 2 个）`}</span>
                  </div>
                  <button type="button" className="studio-btn" disabled={source || lockedAnchorCount < 2} onClick={interpolate}>锚点校准</button>
                </div>
              </div>

              {/* Card 2: Active Editing Row Structure & Quick Actions */}
              {!source && <div className="studio-card">
                <div className="studio-card-head">
                  <span className="studio-card-title">{editing ? `编辑行 · 第 ${String(editingIndex + 1).padStart(2, '0')} 行` : '未选择编辑行'}</span>
                  <div className="studio-row-chips">
                    {editing?.locked && <span className="studio-pill is-accent">锚点</span>}
                    {editing?.translation && <span className="studio-pill">译文</span>}
                    {editing?.credit && <span className="studio-pill">署名</span>}
                    {editing && editing.time === null && <span className="studio-pill">未打点</span>}
                  </div>
                </div>
                {editing && <div className="studio-edit-snippet" title={editing.text}>{editing.text || '♪ 空行（间奏标记）'}</div>}
                <div className="studio-structure-grid">
                  <button type="button" className="studio-btn" onClick={() => addLine(false)}><Plus size={12} />上方插行</button>
                  <button type="button" className="studio-btn" onClick={() => addLine(true)}><Plus size={12} />下方插行</button>
                  <button type="button" className="studio-btn" disabled={!editing} onClick={() => splitLine()}><Scissors size={12} />光标拆行</button>
                  <button type="button" className="studio-btn" disabled={!editing || editingIndex <= 0} onClick={() => {
                    if (flushTimes()) change(old => { const lines = [...old.lines], i = lines.findIndex(l => l.id === editId); if (i <= 0) return old; [lines[i], lines[i - 1]] = [lines[i - 1], lines[i]]; return { ...old, lines }; });
                  }}><ArrowUp size={12} />上移</button>
                  <button type="button" className="studio-btn" disabled={!editing || editingIndex < 0 || editingIndex >= doc.lines.length - 1} onClick={() => {
                    if (flushTimes()) change(old => { const lines = [...old.lines], i = lines.findIndex(l => l.id === editId); if (i < 0 || i >= lines.length - 1) return old; [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]]; return { ...old, lines }; });
                  }}><ArrowDown size={12} />下移</button>
                  <button type="button" className="studio-btn is-danger" disabled={!editing} onClick={() => deleteLines([editId])}><Trash2 size={12} />删行</button>
                </div>
                {editing && <div className="studio-row-quick-links">
                  <button type="button" className="text-button" onClick={() => stableRowActions.auditionLine(editing.id)}><Play size={12} />试听本行</button>
                  <button type="button" className="text-button" disabled={editing.time === null || editing.translation} onClick={() => stableRowActions.toggleLock(editing.id)}>
                    <LockKeyhole size={12} />{editing.locked ? '解锁锚点' : '锁定锚点'}
                  </button>
                  {editingIndex > 0 && <button type="button" className="text-button" onClick={() => stableRowActions.toggleTranslation(editing.id, editingIndex)}>
                    <Link2 size={12} />{editing.translation ? '解除译文' : '关联为译文'}
                  </button>}
                </div>}
              </div>}

              {/* Card 3: Enhanced LRC Word-Level Timing Editor */}
              {!source && !!editing?.words?.length && <div className="studio-card">
                <div className="studio-card-head">
                  <span className="studio-card-title">第 {String(editingIndex + 1).padStart(2, '0')} 行逐字时间</span>
                  <span className="studio-card-sub mono">{editing.words.length} 词</span>
                </div>
                <div className="lyric-word-list">
                  {editing.words.map((word, index) => <div key={index} className="lyric-word-item">
                    <span title={word.text}>{word.text}</span>
                    <TimeInput label={`字词 ${index + 1} 开始`} required value={word.start + doc.offset} onChange={value => {
                      if (value !== null) update(editing.id, line => ({ ...line, words: line.words?.map((item, i) => i === index ? { ...item, start: Math.max(0, value - historyRef.current.doc.offset) } : item) }));
                    }} />
                  </div>)}
                </div>
              </div>}

              {/* Compact 4-State Visual Legend */}
              <div className="studio-legend">
                <span><i className="dot-play" />绿条 = 正在播放</span>
                <span><i className="dot-target" />橙标 = K 打点目标</span>
                <span><i className="dot-edit" />亮边 = 当前编辑行</span>
                <span><i className="dot-sel" />浅蓝 = 批量勾选</span>
              </div>
            </div> : modelPanelContent}
          </div>
        </aside>

        {/* MOBILE MODEL VIEW */}
        <section className="studio-mobile-model">{modelPanelContent}</section>
      </fieldset>

      {/* 4. SLIM STUDIO FOOTER */}
      <footer className="modal-footer studio-footer">
        <div className="studio-status" role="status">
          <i className={`studio-status-dot ${busy || submitting || !ready ? 'is-busy' : dirty ? 'is-dirty' : 'is-clean'}`} aria-hidden="true" />
          <span>{busy ? '验证并写回中…' : submitting ? '正在提交校准…' : !ready ? (loadError ? '加载失败' : '读取歌词与草稿…') : dirty ? `未写回 · ${pendingTimes.size ? '时间待确认' : draftStatus === 'error' ? '草稿保存失败，请导出' : draftStatus === 'saving' ? '草稿保存中…' : '草稿已保留'}` : draftStatus === 'error' ? '文件已保存 · 工作位置保存失败' : '已写回'}</span>
        </div>

        <div className="studio-shortcuts" aria-hidden="true">
          <span><kbd>Space</kbd>试听</span>
          <span><kbd>K</kbd>打点</span>
          <span><kbd>←/→</kbd>±5s</span>
          <span><kbd>⇧←/→</kbd>上下句</span>
          <span><kbd>↑/↓</kbd>切目标</span>
          <span><kbd>⌘Z</kbd>撤销</span>
          <span><kbd>⌘F</kbd>查找</span>
          <span><kbd>⌘S</kbd>写回</span>
        </div>

        <div className="studio-footer-actions">
          <button type="button" className="studio-btn secondary" disabled={busy || !!submitting} onClick={() => void close()}>收起</button>
          <button type="button" className="studio-btn primary" disabled={protectedOperation || conflict} onClick={() => void act(save)}>{busy ? '写回中…' : '保存并写回'}</button>
        </div>
      </footer>

      {/* SERVER VERSION COMPARISON OVERLAY (Never crushes the lyric list!) */}
      {serverCopy && <div className="studio-diff-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !conflict) setServerCopy(undefined); }}>
        <div className={`studio-diff-dialog ${conflict ? 'conflict' : ''}`} role="dialog" aria-label="服务器版本对比">
          <header>
            <div>
              <strong>{conflict ? serverCopy.audioVersion !== base.audioVersion ? '音频版本已变更' : '歌词版本已变更' : '服务器版本与编辑基准一致'}</strong>
              <span>{conflict ? '请核对差异后选择载入服务器版本，或保留当前草稿覆盖' : '随时对照服务器上的已写回文本'}</span>
            </div>
            <button type="button" className="icon-button" aria-label="关闭对比" disabled={conflict} onClick={() => setServerCopy(undefined)}><X size={16} /></button>
          </header>
          <div className="lyric-version-comparison">
            <label>当前草稿<textarea readOnly aria-label="当前草稿对比" value={currentText} /></label>
            <label>服务器歌词<textarea readOnly aria-label="服务器歌词" value={serverCopy.lyricsText || ''} /></label>
          </div>
          <footer>
            <button type="button" className="studio-btn" disabled={protectedOperation} onClick={() => void checkServer()}>重新检查</button>
            <div className="diff-actions-right">
              <button type="button" className="studio-btn" disabled={protectedOperation} onClick={() => void act(() => resolveServer(false))}>载入服务器版本</button>
              {conflict
                ? <button type="button" className="studio-btn primary" disabled={protectedOperation} onClick={() => void act(() => resolveServer(true))}>保留草稿继续编辑</button>
                : <button type="button" className="studio-btn primary" onClick={() => setServerCopy(undefined)}>关闭对比</button>}
            </div>
          </footer>
        </div>
      </div>}
    </Modal>
  </TimeContext.Provider>;
}

function editorTab(): string {
  try { let id = sessionStorage.getItem('lilt.lyrics-editor-tab'); if (!id) { id = identity(); sessionStorage.setItem('lilt.lyrics-editor-tab', id); } return id; }
  catch { return identity(); }
}
