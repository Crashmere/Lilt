import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Check, Download, LockKeyhole, Pause, Play, Plus, Sparkles, Trash2, Undo2, Redo2, Upload } from 'lucide-react';
import './lyrics-workbench.css';
import { Modal } from './components';
import { json, messageOf, read, request } from './api';
import type { Track } from './types';
import type { Player } from './player';
import { identity } from './utils';
import { useActiveLyric } from './lyrics';
import { loadLyricDraft, removeLyricDraft, saveLyricDraft } from './storage';
import { downloadLyrics, importLyrics, moveLine, parseDocument, readTime, serializeDocument, timeLabel, type EditLine, type LyricDocument, type LyricWord } from './lyric-document';
import { LyricWaveform } from './lyric-waveform';

type Result = { id: string; time: number | null; words?: LyricWord[]; confidence: number; warning?: string };
type Job = { id: string; kind: 'align' | 'waveform'; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; phase: string; progress: number; audioVersion: string; draftVersion: string; results?: Result[]; peaks?: number[]; error?: string };
type Base = { lyricsText: string; lyricsVersion: string; audioVersion: string };
type ModelInput = { lines: EditLine[]; offset: number; audioVersion: string };
type Draft = { doc: LyricDocument; base: Base; raw?: string; source?: boolean; job?: Job; modelInput?: ModelInput };
type History = { past: LyricDocument[]; doc: LyricDocument; future: LyricDocument[] };
const comparable = (doc: LyricDocument) => serializeDocument(doc);
const activeJob = (job?: Job) => job?.status === 'queued' || job?.status === 'running';

function TimeInput({ value, onChange, label, disabled }: { value: number | null; onChange: (time: number | null) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(timeLabel(value));
  const [error, setError] = useState(false);
  useEffect(() => { setText(timeLabel(value)); setError(false); }, [value]);
  function commit() { try { onChange(readTime(text)); setError(false); } catch { setError(true); } }
  return <input aria-label={label} aria-invalid={error} title={error ? '时间格式应为 00:00.000' : undefined} className="lyric-time-input" value={text} placeholder="未打点" disabled={disabled} onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />;
}

export function LyricsWorkbench({ track, player, onClose, onSaved }: { track: Track; player: Player; onClose: () => void; onSaved: (track: Track) => void }) {
  const [history, setHistory] = useState<History>(() => ({ past: [], doc: parseDocument(track.lyricsText || ''), future: [] }));
  const doc = history.doc;
  const [base, setBase] = useState<Base>({ lyricsText: track.lyricsText || '', lyricsVersion: track.lyricsVersion || '', audioVersion: track.audioVersion || '' });
  const [selected, setSelected] = useState<Set<string>>(() => new Set(history.doc.lines[0] ? [history.doc.lines[0].id] : []));
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(false);
  const [raw, setRaw] = useState('');
  const [step, setStep] = useState(100);
  const [loop, setLoop] = useState(false);
  const [range, setRange] = useState<[number, number]>([0, Math.round(track.duration * 1000)]);
  const [rate, setRate] = useState(1);
  const [tools, setTools] = useState({ available: false, alignment: false });
  const [job, setJob] = useState<Job>();
  const [waveJob, setWaveJob] = useState<Job>();
  const [peaks, setPeaks] = useState<number[]>([]);
  const [modelInput, setModelInput] = useState<ModelInput>();
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [serverCopy, setServerCopy] = useState<Track>();
  const fileInput = useRef<HTMLInputElement>(null);
  const lineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const saving = useRef(false);
  const mounted = useRef(true);
  const latestPlayer = useRef(player); latestPlayer.current = player;
  const latestDraft = useRef<Draft>({ doc, base }); latestDraft.current = { doc, base, raw, source, job, modelInput };
  const draftKey = useRef(`${track.id}:${editorTab()}`);
  const currentText = source ? raw : comparable(doc);
  const dirty = currentText !== comparable(parseDocument(base.lyricsText));
  const chosen = doc.lines.filter(line => selected.has(line.id));
  const timed = doc.lines.filter(line => line.time !== null && !line.translation).map(line => ({ time: (line.time! + doc.offset) / 1000, text: line.text })).sort((a, b) => a.time - b.time);
  const current = useActiveLyric(timed, player.position, player.getPosition, player.playing && player.trackId === track.id);
  const results = new Map(job?.results?.map(result => [result.id, result]));
  const modelOrder = modelInput ? doc.lines.filter(line => modelInput.lines.some(old => old.id === line.id)).map(line => line.id) : [];
  const stale = !!modelInput && (source && raw !== comparable(doc) || modelInput.audioVersion !== base.audioVersion || modelInput.offset !== doc.offset || modelInput.lines.some((old, index) => {
    const line = doc.lines.find(item => item.id === old.id), result = results.get(old.id);
    return !line || modelOrder[index] !== old.id || line.text !== old.text || line.pronunciation !== old.pronunciation || !!line.locked !== !!old.locked || line.time !== old.time && line.time !== (result?.time == null ? undefined : Math.max(0, result.time - doc.offset));
  }));

  function change(next: LyricDocument | ((current: LyricDocument) => LyricDocument)) {
    setHistory(old => {
      const value = typeof next === 'function' ? next(old.doc) : next;
      const lines: EditLine[] = [];
      value.lines.forEach((line, index) => lines.push(line.translation ? index ? { ...line, time: lines[index - 1].time, words: undefined } : { ...line, translation: false } : line));
      return { past: [...old.past.slice(-49), old.doc], doc: { ...value, lines }, future: [] };
    });
  }
  function update(id: string, transform: (line: EditLine) => EditLine) { change(old => ({ ...old, lines: old.lines.map(line => line.id === id ? transform(line) : line) })); }
  function undo() { setHistory(old => old.past.length ? { past: old.past.slice(0, -1), doc: old.past.at(-1)!, future: [old.doc, ...old.future] } : old); }
  function redo() { setHistory(old => old.future.length ? { past: [...old.past, old.doc], doc: old.future[0], future: old.future.slice(1) } : old); }
  async function act(action: () => void | Promise<void>) { setError(''); try { await action(); } catch (failure) { setError(messageOf(failure)); } }
  function audition(time: number) { player.startAudition(track, Math.max(0, time / 1000)); player.setPlaybackRate(rate); }
  function mark() {
    if (player.trackId !== track.id) { setError('请先试听当前曲目'); return; }
    const line = chosen[0]; if (!line) return;
    const time = Math.round(player.getPosition() * 1000) - doc.offset;
    if (time < 0 && !line.credit) { setError('请先调整整体偏移，避免负时间'); return; }
    update(line.id, old => moveLine(old, time));
    const index = doc.lines.findIndex(item => item.id === line.id);
    const following = doc.lines.slice(index + 1).find(item => !item.translation && !item.credit);
    if (following) setSelected(new Set([following.id]));
  }
  function switchSource() { if (source) { change(parseDocument(raw)); setSource(false); } else { setRaw(comparable(doc)); setSource(true); } }
  function shift(amount: number) {
    if (chosen.some(line => !line.locked && line.time !== null && line.time + amount < 0 && !line.credit)) { setError('调整后时间不能为负'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => selected.has(line.id) && !line.locked && line.time !== null ? moveLine(line, line.time + amount) : line) }));
  }
  function interpolate() {
    const anchors = doc.lines.filter(line => line.locked && line.time !== null && line.anchorBase !== undefined);
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
  async function save() {
    if (saving.current || !ready) return;
    const text = source ? raw : comparable(doc);
    if (!source && doc.lines.some(line => line.time !== null && line.time < 0 && !line.credit)) { setError('普通歌词的时间不能为负，请调整整体偏移'); return; }
    if (!source && doc.lines.some(line => line.words?.some((word, i, words) => word.start < 0 || i > 0 && word.start < words[i - 1].start))) { setError('逐字时间必须按演唱顺序排列'); return; }
    if (new TextEncoder().encode(text).length > 1024 ** 2) { setError('歌词不能超过 1 MiB'); return; }
    if (!text.trim() && base.lyricsText.trim() && !window.confirm('清空并写回当前歌曲的歌词？')) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { lyricsText: text, expectedLyricsVersion: base.lyricsVersion, expectedAudioVersion: base.audioVersion });
      setBase({ lyricsText: text, lyricsVersion: result.track.lyricsVersion || '', audioVersion: result.track.audioVersion || '' });
      onSaved(result.track); setNotice('已写回歌曲文件'); setServerCopy(undefined);
      setJob(undefined); setModelInput(undefined);
      await removeLyricDraft(draftKey.current).catch(() => setNotice('歌曲已保存，但浏览器草稿未能清理'));
    } catch (failure) { setError(messageOf(failure)); }
    finally { saving.current = false; setBusy(false); }
  }
  async function close() {
    if (busy) return;
    try { await saveLyricDraft(draftKey.current, latestDraft.current); }
    catch { if (dirty && !window.confirm('无法保存草稿，仍要关闭并放弃修改？')) return; }
    player.endAudition(); onClose();
  }
  async function submit(kind: 'align' | 'waveform', all = false) {
    const lines = (all ? doc.lines : chosen).filter(line => !line.credit && !line.translation && line.text.trim());
    if (kind === 'align' && !lines.length) throw new Error('请选择需要校准的原文歌词');
    const model = { lines, offset: doc.offset, audioVersion: base.audioVersion };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(model)));
    const version = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const result = await json<{ job: Job }>(`/tracks/${encodeURIComponent(track.id)}/lyrics-jobs`, 'POST', {
      kind, audioVersion: base.audioVersion, expectedLyricsVersion: base.lyricsVersion, draftVersion: version, language: 'zh', start: all ? 0 : range[0], end: all ? track.duration * 1000 : range[1],
      lines: kind === 'align' ? lines.map(line => ({ id: line.id, text: line.text, time: line.time === null ? null : line.time + doc.offset, locked: !!line.locked, pronunciation: line.pronunciation || '' })) : [],
    });
    if (kind === 'align') { setModelInput(model); setJob(result.job); } else setWaveJob(result.job);
  }
  function accept(ids: string[]) {
    if (stale) { setError('草稿已变更，请重新校准'); return; }
    change(old => ({ ...old, lines: old.lines.map(line => {
      const result = results.get(line.id); if (!ids.includes(line.id) || result?.time == null) return line;
      const time = Math.max(0, result.time - doc.offset);
      const words = result.words?.map(word => ({ ...word, start: Math.max(0, word.start - doc.offset), end: Math.max(0, word.end - doc.offset) }));
      return { ...line, time: line.locked ? line.time : time, words };
    }) }));
  }
  async function resolveServer(keepDraft: boolean) {
    if (!serverCopy) return;
    if (!window.confirm(keepDraft ? '保留当前草稿，后续保存将覆盖已查看的服务器歌词？' : '用服务器版本替换当前草稿？')) return;
    const { track: latest } = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`);
    if (latest.lyricsVersion !== serverCopy.lyricsVersion || latest.audioVersion !== serverCopy.audioVersion) {
      setServerCopy(latest); throw new Error('服务器版本再次变更，请查看后重新选择');
    }
    setBase({ lyricsText: latest.lyricsText || '', lyricsVersion: latest.lyricsVersion || '', audioVersion: latest.audioVersion || '' });
    if (!keepDraft) { change(parseDocument(latest.lyricsText || '')); setSource(false); }
    if (latest.audioVersion !== base.audioVersion) { player.endAudition(); setPeaks([]); setWaveJob(undefined); }
    setJob(undefined); setModelInput(undefined); setServerCopy(undefined); setError('');
    setNotice(keepDraft ? '已保留草稿，请确认内容后保存' : '已载入服务器歌词');
  }
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return;
    const target = event.target as HTMLElement;
    const typing = !!target.closest('input,textarea,select,[contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!event.repeat) void save(); return; }
    if (!ready || busy) return;
    if (typing || source) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'k' && !event.repeat) { event.preventDefault(); mark(); }
  });
  useEffect(() => {
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    let active = true;
    void loadLyricDraft<Draft>(draftKey.current).then(saved => {
      if (!active || !saved) return;
      setHistory({ past: [], doc: saved.doc, future: [] }); setBase(saved.base); setRaw(saved.raw || ''); setSource(!!saved.source); setJob(saved.job); setModelInput(saved.modelInput);
      setSelected(new Set(saved.doc.lines[0] ? [saved.doc.lines[0].id] : []));
      setNotice(saved.base.lyricsVersion !== track.lyricsVersion || saved.base.audioVersion !== track.audioVersion ? '已恢复草稿，服务器版本已变更，请先合并' : '已恢复未保存的草稿');
    }).catch(() => { if (active) setNotice('浏览器无法保存草稿，请及时导出'); }).finally(() => { if (active) setReady(true); });
    const abort = new AbortController();
    void read<typeof tools>('/lyrics-tools', abort.signal).then(value => { if (active) setTools(value); }).catch(() => undefined);
    void read<{ jobs: Job[] }>(`/tracks/${encodeURIComponent(track.id)}/lyrics-jobs`, abort.signal).then(value => {
      if (!active) return;
      const waveform = value.jobs.find(item => item.kind === 'waveform' && item.audioVersion === track.audioVersion && item.status === 'done');
      if (waveform?.peaks) setPeaks(waveform.peaks);
    }).catch(() => undefined);
    return () => { active = false; abort.abort(); mounted.current = false; latestPlayer.current.endAudition(); };
  }, []);
  useEffect(() => {
    if (!ready || busy) return;
    const timer = setTimeout(() => { if (!saving.current) void saveLyricDraft(draftKey.current, latestDraft.current).catch(() => { if (mounted.current) setNotice('草稿保存失败，请导出后再关闭'); }); }, 600);
    return () => clearTimeout(timer);
  }, [doc, base, raw, source, job, modelInput, ready, busy]);
  const unload = useEffectEvent((event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
  useEffect(() => { window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, []);
  useEffect(() => {
    if (!activeJob(job) && !activeJob(waveJob)) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (activeJob(job)) { const result = await read<{ job: Job }>(`/lyrics-jobs/${job!.id}`, abort.signal); setJob(result.job); }
        if (activeJob(waveJob)) { const result = await read<{ job: Job }>(`/lyrics-jobs/${waveJob!.id}`, abort.signal); setWaveJob(result.job); if (result.job.peaks) setPeaks(result.job.peaks); }
      } catch (failure) { if (!abort.signal.aborted) setError(messageOf(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 1500);
    }
    timer = setTimeout(() => { void poll(); }, 300);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, waveJob?.id, waveJob?.status]);
  const repeatLoop = useEffectEvent(() => {
    const control = latestPlayer.current;
    if (loop && range[1] > range[0] && control.auditionTrack?.id === track.id && control.playing && !control.audioRef.current?.seeking && control.getPosition() * 1000 >= range[1]) control.seek(range[0] / 1000);
  });
  useEffect(() => {
    if (!loop || !player.playing) return;
    let frame = 0; const tick = () => { repeatLoop(); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, player.playing]);

  return <Modal title={`${track.title} · 歌词工作台`} className="lyrics-workbench" wide onClose={() => { void close(); }}>
    <div className="lyric-work-top"><div className="lyric-mode"><button className={!source ? 'active' : ''} onClick={() => { if (source) switchSource(); }}>逐行</button><button className={source ? 'active' : ''} onClick={() => { if (!source) switchSource(); }}>源码</button></div><span className="muted">{doc.lines.filter(line => line.text.trim() && line.time !== null).length} / {doc.lines.filter(line => line.text.trim()).length} 行已打点</span><button className="icon-button" aria-label="撤销" disabled={source || !history.past.length} onClick={undo}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做" disabled={source || !history.future.length} onClick={redo}><Redo2 size={17} /></button><button className="text-button" onClick={() => fileInput.current?.click()}><Upload size={15} />导入</button><button className="text-button" onClick={() => { void act(() => downloadLyrics(currentText, `${track.title}.${doc.lines.some(line => line.time !== null) ? 'lrc' : 'txt'}`)); }}><Download size={15} />导出</button><input ref={fileInput} type="file" hidden accept=".lrc,.txt" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void act(async () => { const text = await importLyrics(file); change(parseDocument(text)); setRaw(text); }); }} /></div>
    {(error || notice) && <div className={`lyric-notice ${error ? 'error-text' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}{notice && !error && <button className="text-button" onClick={() => setNotice('')}>关闭</button>}</div>}
    <fieldset className="lyric-work-body" disabled={!ready || busy}>
      <section className="lyric-edit-pane">
        {source ? <textarea className="lyric-source" aria-label="歌词源码" spellCheck={false} value={raw} onChange={event => setRaw(event.target.value)} /> : <>
          <div className="lyric-edit-tools"><label><input type="checkbox" aria-label="选择全部歌词" checked={doc.lines.length > 0 && doc.lines.every(line => selected.has(line.id))} onChange={event => setSelected(new Set(event.target.checked ? doc.lines.map(line => line.id) : []))} />全选</label><button className="text-button" onClick={mark}>打点并下一行 <kbd>K</kbd></button><button className="text-button" onClick={() => shift(-step)}>提前</button><button className="text-button" onClick={() => shift(step)}>延后</button><select aria-label="调整步长" value={step} onChange={event => setStep(Number(event.target.value))}>{[10, 50, 100, 200, 500, 1000].map(value => <option key={value} value={value}>{value} ms</option>)}</select><button className="text-button" onClick={() => change(old => ({ ...old, lines: old.lines.map(line => selected.has(line.id) && !line.locked ? moveLine(line, null) : line) }))}>清除时间</button></div>
          <div className="lyric-row-list">{doc.lines.map((line, index) => {
            const result = results.get(line.id), active = line.time !== null && timed[current]?.time === (line.time + doc.offset) / 1000 && player.trackId === track.id;
            const warning = line.time !== null && (line.time + doc.offset > track.duration * 1000 || index > 0 && doc.lines[index - 1].time !== null && line.time < doc.lines[index - 1].time!) ? '时间顺序或范围需检查' : '';
            return <div key={line.id} className={`lyric-edit-row ${selected.has(line.id) ? 'selected' : ''} ${active ? 'playing' : ''}`}>
              <input type="checkbox" aria-label={`选择第 ${index + 1} 行`} checked={selected.has(line.id)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(line.id); else next.delete(line.id); return next; })} />
              <button className="lyric-row-number" aria-label={`试听第 ${index + 1} 行`} onClick={() => { setSelected(new Set([line.id])); audition(Math.max(0, (line.time ?? 0) + doc.offset - 1500)); }}>{String(index + 1).padStart(2, '0')}</button>
              <TimeInput label={`第 ${index + 1} 行时间`} value={line.time === null ? null : line.time + doc.offset} disabled={line.translation} onChange={value => { if (value !== (line.time === null ? null : line.time + doc.offset)) update(line.id, item => moveLine(item, value === null ? null : value - doc.offset)); }} />
              <textarea ref={element => { if (element) lineInputs.current.set(line.id, element); else lineInputs.current.delete(line.id); }} rows={1} aria-label={`第 ${index + 1} 行歌词`} value={line.text} onFocus={() => setSelected(new Set([line.id]))} onChange={event => update(line.id, item => ({ ...item, text: event.target.value, words: undefined }))} />
              <button className={`icon-button ${line.locked ? 'accent' : ''}`} aria-label={`${line.locked ? '解锁' : '锁定'}第 ${index + 1} 行锚点`} disabled={line.time === null || line.translation} onClick={() => update(line.id, item => ({ ...item, locked: !item.locked, anchorBase: item.locked ? undefined : item.time ?? undefined }))}><LockKeyhole size={14} /></button>
              {index > 0 && <button className={`lyric-link ${line.translation ? 'active' : ''}`} title="译文跟随上一行时间" onClick={() => update(line.id, item => ({ ...item, translation: !item.translation, time: !item.translation ? doc.lines[index - 1].time : item.time }))}>{line.translation ? '译' : '联'}</button>}
              {(result || warning) && <div className="lyric-candidate">{warning || result?.warning}{result?.time != null && <><span>建议 {timeLabel(result.time)}</span><button className="text-button" disabled={stale} onClick={() => accept([line.id])}><Check size={12} />应用</button><button className="text-button" onClick={() => audition(Math.max(0, result.time! - 1500))}>试听</button></>}</div>}
            </div>;
          })}</div>
          <div className="lyric-structure-tools"><button className="text-button" onClick={() => { const line = { id: identity(), text: '', time: null }; change(old => ({ ...old, lines: [...old.lines, line] })); setSelected(new Set([line.id])); }}><Plus size={14} />加行</button><button className="text-button" disabled={chosen.length !== 1} onClick={() => {
            const line = chosen[0], at = lineInputs.current.get(line.id)?.selectionStart || Math.floor(line.text.length / 2);
            const next = { id: identity(), text: line.text.slice(at), time: null };
            change(old => ({ ...old, lines: old.lines.flatMap(item => item.id === line.id ? [{ ...item, text: item.text.slice(0, at), words: undefined }, next] : [item]) }));
          }}>拆行</button><button className="text-button" disabled={chosen.length < 2} onClick={() => {
            const indices = chosen.map(line => doc.lines.indexOf(line)); if (indices.at(-1)! - indices[0] + 1 !== indices.length) { setError('请选择连续的歌词行'); return; }
            change(old => ({ ...old, lines: old.lines.flatMap(line => line.id === chosen[0].id ? [{ ...line, text: chosen.map(item => item.text).join(''), words: undefined }] : selected.has(line.id) ? [] : [line]) }));
          }}>合行</button>{([-1, 1] as const).map(direction => <button className="text-button" key={direction} disabled={chosen.length !== 1} onClick={() => change(old => { const lines = [...old.lines], index = lines.findIndex(line => line.id === chosen[0].id), target = index + direction; if (target >= 0 && target < lines.length) [lines[index], lines[target]] = [lines[target], lines[index]]; return { ...old, lines }; })}>{direction < 0 ? '上移' : '下移'}</button>)}<button className="text-button" disabled={!chosen.length} onClick={() => change(old => ({ ...old, lines: old.lines.filter(line => !selected.has(line.id)) }))}><Trash2 size={13} />删行</button></div>
        </>}
        <div className="lyric-replace"><input aria-label="查找歌词" placeholder="查找" value={find} onChange={event => setFind(event.target.value)} /><input aria-label="替换文字" placeholder="替换为" value={replacement} onChange={event => setReplacement(event.target.value)} /><button className="text-button" disabled={!find} onClick={() => { if (source) setRaw(raw.replaceAll(find, replacement)); else change(old => ({ ...old, lines: old.lines.map(line => line.text.includes(find) ? { ...line, text: line.text.replaceAll(find, replacement), words: undefined } : line) })); }}>全部替换</button></div>
      </section>
      <section className="lyric-calibration-pane">
        <div className="lyric-transport"><button className="round-play" aria-label="校准试听" onClick={() => { if (player.auditionTrack?.id === track.id && player.playing) player.pause(); else audition(player.auditionTrack?.id === track.id ? player.getPosition() * 1000 : range[0]); }}>{player.auditionTrack?.id === track.id && player.playing ? <Pause size={19} /> : <Play size={19} />}</button><span>{timeLabel(player.trackId === track.id ? player.position * 1000 : 0)}</span><select aria-label="试听速度" value={rate} onChange={event => { const next = Number(event.target.value); setRate(next); if (player.auditionTrack?.id === track.id) player.setPlaybackRate(next); }}>{[0.5, 0.75, 1, 1.25].map(value => <option key={value} value={value}>{value}×</option>)}</select><button className="text-button" disabled={!player.auditionTrack} onClick={() => player.endAudition()}>结束试听</button></div>
        <div className="lyric-range"><label>A<TimeInput label="选段开始时间" value={range[0]} onChange={value => { if (value !== null) setRange([Math.max(0, value), range[1]]); }} /></label><label>B<TimeInput label="选段结束时间" value={range[1]} onChange={value => { if (value !== null) setRange([range[0], Math.min(value, track.duration * 1000)]); }} /></label><label><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked); if (range[1] <= range[0]) setError('B 必须晚于 A'); }} />循环</label><button className="text-button" onClick={() => {
          const times = chosen.filter(line => line.time !== null).map(line => line.time! + doc.offset).sort((a, b) => a - b); if (!times.length) return;
          const next = doc.lines.find(line => line.time !== null && line.time + doc.offset > times.at(-1)!);
          setRange([Math.max(0, times[0] - 1500), next?.time !== null && next?.time !== undefined ? next.time + doc.offset : track.duration * 1000]);
        }}>按所选行设范围</button></div>
        {peaks.length > 0 ? <LyricWaveform peaks={peaks} duration={track.duration * 1000} lines={source ? [] : doc.lines} offset={doc.offset} selected={selected} position={player.trackId === track.id ? player.position * 1000 : 0} onMove={(id, time) => { if (ready && !busy && !source) update(id, line => moveLine(line, time)); }} onSeek={time => { if (ready && !busy) audition(time); }} /> : <div className="lyric-wave-empty"><button className="button secondary" disabled={!tools.available || activeJob(waveJob)} onClick={() => { void act(() => submit('waveform')); }}>{activeJob(waveJob) ? waveJob?.phase : '加载波形'}</button>{waveJob?.error && <p className="error-text">{waveJob.error}</p>}</div>}
        <fieldset className="lyric-offset" disabled={source}><label>整体偏移<input type="number" aria-label="整体偏移毫秒" value={doc.offset} step={step} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) change(old => ({ ...old, offset: value })); }} /><span>ms</span></label><button className="text-button" onClick={() => change(old => ({ ...old, offset: old.offset - step }))}>提前</button><button className="text-button" onClick={() => change(old => ({ ...old, offset: old.offset + step }))}>延后</button><button className="text-button" onClick={interpolate}>锚点校准</button></fieldset>
        <div className="lyric-preview" aria-label="歌词试听预览">{player.trackId === track.id && current >= 0 ? <>{timed.slice(Math.max(0, current - 1), current + 2).map((line, index) => <p key={`${line.time}-${index}`} className={line.time === timed[current].time ? 'active' : ''}>{line.text || '♪'}</p>)}{doc.lines.filter(line => line.translation && line.time !== null && (line.time + doc.offset) / 1000 === timed[current].time).map(line => <p className="translation" key={line.id}>{line.text}</p>)}</> : <p>试听后预览歌词</p>}</div>
        <div className="lyric-model"><h3><Sparkles size={17} />模型校准 <small>中文歌声</small></h3><div className="lyric-model-actions"><button className="button secondary" disabled={source || !tools.alignment || activeJob(job)} onClick={() => { void act(() => submit('align', true)); }}>校准整首</button><button className="button secondary" disabled={source || !tools.alignment || activeJob(job) || !chosen.length} onClick={() => { void act(() => submit('align')); }}>校准所选行</button></div>{!tools.alignment && <p className="muted">模型服务未就绪，可继续人工校准。</p>}{activeJob(job) && <div className="lyric-job-progress"><progress max={1} value={job!.progress} /><span>{job!.phase}</span><button className="text-button" onClick={() => { void act(async () => { const result = await request<{ job: Job }>(`/lyrics-jobs/${job!.id}`, { method: 'DELETE' }); setJob(result.job); }); }}>取消</button></div>}{job?.status === 'error' && <p className="error-text">{job.error}</p>}{job?.status === 'done' && <div className="lyric-model-review"><span>{stale ? '草稿已变更，请重新校准' : `${job.results?.length || 0} 行候选，应用后试听确认`}</span><button className="text-button" disabled={stale} onClick={() => accept(job.results?.map(item => item.id) || [])}>应用全部</button><button className="text-button" onClick={() => { setJob(undefined); setModelInput(undefined); }}>丢弃候选</button></div>}</div>
        {chosen.length === 1 && !chosen[0].translation && <label className="lyric-pronunciation">拼音校正<input aria-label="拼音校正" placeholder="空格分隔，留空自动" value={chosen[0].pronunciation || ''} onChange={event => update(chosen[0].id, line => ({ ...line, pronunciation: event.target.value }))} /></label>}
        {chosen.length === 1 && !!chosen[0].words?.length && <div className="lyric-word-editor"><h3>逐字时间</h3>{chosen[0].words!.map((word, index) => <div key={index}><span>{word.text}</span><TimeInput label={`字词 ${index + 1} 开始`} value={word.start + doc.offset} onChange={value => { if (value !== null) update(chosen[0].id, line => ({ ...line, words: line.words?.map((item, i) => i === index ? { ...item, start: Math.max(0, value - doc.offset) } : item) })); }} /></div>)}</div>}
        <button className="text-button lyric-server-version" onClick={() => { void act(async () => { const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`); setServerCopy(result.track); }); }}>查看服务器版本</button>
        {serverCopy && <div className="lyric-server-copy"><textarea readOnly aria-label="服务器歌词" value={serverCopy.lyricsText || ''} /><button className="text-button" onClick={() => { void act(() => resolveServer(false)); }}>载入服务器版本</button><button className="text-button" onClick={() => { void act(() => resolveServer(true)); }}>保留草稿继续编辑</button></div>}
      </section>
    </fieldset>
    <footer className="modal-footer"><span>{busy ? '验证并写回中…' : dirty ? '未保存 · 草稿保留在此浏览器' : '已保存'}{!ready ? ' · 读取草稿中…' : ''}</span><div><button className="button secondary" disabled={busy} onClick={() => { void close(); }}>收起</button><button className="button primary" disabled={busy || !ready || !dirty} onClick={() => { void act(save); }}>{busy ? '写回中…' : '保存并写回'}</button></div></footer>
  </Modal>;
}

function editorTab(): string {
  try { let id = sessionStorage.getItem('lilt.lyrics-editor-tab'); if (!id) { id = identity(); sessionStorage.setItem('lilt.lyrics-editor-tab', id); } return id; }
  catch { return identity(); }
}
