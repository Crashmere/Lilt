import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Download, FolderUp, Heart, ListMusic, LoaderCircle, Pause, Play, Plus, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Timer, UploadCloud, Volume2, X } from 'lucide-react';
import { ApiError, json, messageOf, request, trackURL } from './api';
import { Artwork, Empty, Modal } from './components';
import type { Player } from './player';
import type { PlayerState, Playlist, Rules, Track } from './types';
import type { Uploader } from './upload';
import { getCached } from './storage';
import { bytes, date, duration, parseLyrics } from './utils';

export function PlayerBar({ player, onQueue, onLyrics, favorite, onTimer, onDevices }: { player: Player; onQueue: () => void; onLyrics: () => void; favorite: (track: Track) => void; onTimer: () => void; onDevices: () => void }) {
  const qualityName = player.actual.quality === 'original' ? '原文件' : player.actual.quality === 'compact' ? '节省流量' : '标准';
  const totalDuration = player.track?.duration || 0;
  const position = player.track ? player.position : 0;
  const progress = totalDuration ? Math.max(0, Math.min(position / totalDuration, 1)) : 0;

  function seekAtPointer(event: React.PointerEvent<HTMLInputElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (totalDuration <= 0 || bounds.width <= 0) return;
    player.seek(Math.max(0, Math.min((event.clientX - bounds.left) / bounds.width, 1)) * totalDuration);
  }

  function startSeek(event: React.PointerEvent<HTMLInputElement>) {
    if (event.button !== 0 || !event.isPrimary || totalDuration <= 0) return;
    // Native range thumbs inset their travel, unlike the visible full-width timeline.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    seekAtPointer(event);
  }

  return <footer className={`player-bar ${!player.track ? 'player-empty' : ''}`}>
    <audio ref={player.audioRef} preload="metadata" />
    <div className="player-track"><button className="player-cover" onClick={onLyrics} aria-label="查看正在播放"><Artwork url={player.track?.coverUrl} /></button><div><button className="now-title" onClick={onLyrics}>{player.track?.title || '尚未播放'}</button><p>{player.track?.artist || '选择一首音乐'}</p></div>{player.track && <button className={`icon-button player-heart ${player.track.favorite ? 'accent' : ''}`} aria-label="收藏当前曲目" onClick={() => favorite(player.track!)}><Heart size={18} fill={player.track.favorite ? 'currentColor' : 'none'} /></button>}</div>
    <div className="player-center"><div className="transport"><button className={`icon-button optional ${player.snapshot.shuffle ? 'accent' : ''}`} aria-label="随机播放" aria-pressed={player.snapshot.shuffle} onClick={player.toggleShuffle}><Shuffle size={17} /></button><button className="icon-button" aria-label="上一首" onClick={player.previous} disabled={!player.track}><SkipBack size={21} fill="currentColor" /></button><button className="main-play" aria-label={player.playing ? '暂停' : '播放'} onClick={() => player.playing ? player.pause() : player.play()} disabled={player.loading || !player.queue.length}>{player.loading ? <LoaderCircle size={22} className="spin" /> : player.playing ? <Pause size={22} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button><button className="icon-button" aria-label="下一首" onClick={() => player.next()} disabled={!player.track}><SkipForward size={21} fill="currentColor" /></button><button className={`icon-button optional ${player.snapshot.repeat !== 'off' ? 'accent' : ''}`} aria-label={`循环：${player.snapshot.repeat === 'off' ? '关闭' : player.snapshot.repeat === 'all' ? '全部' : '单曲'}`} onClick={player.toggleRepeat}>{player.snapshot.repeat === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}</button></div><div className="player-progress"><span>{duration(position)}</span><div className="player-seek" style={{ '--progress': `${progress * 100}%` } as React.CSSProperties}><input type="range" aria-label="播放进度" min={0} max={totalDuration || 1} step="0.1" value={progress * totalDuration} disabled={totalDuration <= 0} onChange={event => player.seek(Number(event.target.value))} onPointerDown={startSeek} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekAtPointer(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { seekAtPointer(event); event.currentTarget.releasePointerCapture(event.pointerId); } }} /></div><span>{duration(totalDuration)}</span></div></div>
    <div className="player-options"><div className="quality-control"><select aria-label="播放音质" value={player.quality} onChange={event => player.changeQuality(event.target.value as 'original' | 'standard' | 'compact')}><option value="standard">标准</option><option value="original">原文件</option><option value="compact">节省流量</option></select><span>{player.actual.cached ? '离线 · ' : ''}{qualityName}{player.actual.bitrate ? ` · ${Math.round(player.actual.bitrate / 1000)}k` : ''}</span></div><button className={`icon-button optional ${player.sleepAt || player.sleepAfterTrack ? 'accent' : ''}`} aria-label="睡眠定时" onClick={onTimer}><Timer size={18} /></button><button className="icon-button" aria-label="歌词" onClick={onLyrics}><span className="lyrics-glyph">词</span></button><button className="icon-button" aria-label="播放队列" onClick={onQueue}><ListMusic size={21} /></button><button className="icon-button device-button" aria-label="播放设备" onClick={onDevices}><Volume2 size={19} /></button><input className="volume-slider" type="range" min={0} max={1} step="0.01" value={player.snapshot.volume} aria-label="音量" onChange={event => player.setVolume(Number(event.target.value))} /></div>
  </footer>;
}

export function QueuePanel({ player, onClose, onSave }: { player: Player; onClose: () => void; onSave: (ids: string[]) => void }) {
  const dragged = useRef(-1);
  return <aside className="side-panel" aria-label="播放队列"><header><div><h2>播放队列 <small>{player.queue.length}</small></h2></div><button className="icon-button" aria-label="关闭队列" onClick={onClose}><X size={22} /></button></header><div className="panel-toolbar"><button className="text-button" onClick={() => onSave(player.snapshot.queueIds)} disabled={!player.queue.length}><Plus size={16} />存为歌单</button><button className="text-button" onClick={player.clear} disabled={!player.queue.length}>清空</button></div><div className="queue-modes"><button className={`pill ${player.snapshot.shuffle ? 'active' : ''}`} aria-pressed={player.snapshot.shuffle} onClick={player.toggleShuffle}><Shuffle size={13} />随机</button><button className={`pill ${player.snapshot.repeat !== 'off' ? 'active' : ''}`} onClick={player.toggleRepeat}>{player.snapshot.repeat === 'one' ? <Repeat1 size={13} /> : <Repeat size={13} />}{player.snapshot.repeat === 'one' ? '单曲循环' : player.snapshot.repeat === 'all' ? '全部循环' : '循环关闭'}</button></div><div className="queue-items">{player.queue.length ? player.queue.map((track, index) => <div className={`queue-row ${player.snapshot.queueIndex === index ? 'current' : ''}`} key={`${track.id}-${index}`} draggable onDragStart={() => { dragged.current = index; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged.current >= 0 && dragged.current !== index) player.reorder(dragged.current, index); dragged.current = -1; }}><span className="queue-number">{index + 1}</span><Artwork url={track.coverUrl} /><button className="queue-name" onClick={() => player.begin(player.snapshot.queueIds, index)}><strong>{track.title}</strong><span>{track.artist}</span></button><div className="queue-row-actions"><button className="icon-button" aria-label="上移" disabled={index === 0} onClick={() => player.reorder(index, index - 1)}>↑</button><button className="icon-button" aria-label="下移" disabled={index === player.queue.length - 1} onClick={() => player.reorder(index, index + 1)}>↓</button><button className="icon-button" aria-label={`从队列移除 ${track.title}`} onClick={() => player.remove(index)}><X size={15} /></button></div></div>) : <Empty title="队列为空" />}</div></aside>;
}

export function LyricsPanel({ player, onClose, onEdit }: { player: Player; onClose: () => void; onEdit: (track: Track) => void }) {
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setText(''); setOffset(0); setError('');
    if (!player.track) return;
    let active = true;
    const track = player.track;
    void (async () => {
      const cached = await getCached(track.id).catch(() => undefined);
      if (active && cached) setText(cached.track.lyricsText || '');
      if (!navigator.onLine) return;
      try { const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`); if (active) setText(result.track.lyricsText || ''); }
      catch (error) { if (active && (!cached || error instanceof ApiError && error.status === 401)) setError(messageOf(error)); }
    })();
    return () => { active = false; };
  }, [player.trackId]);
  const lyrics = parseLyrics(text);
  let current = -1;
  lyrics.lines.forEach((line, index) => { if (line.time + offset <= player.position) current = index; });
  useEffect(() => { activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [current]);
  return <aside className="side-panel lyrics-panel"><header><div><span className="eyebrow">正在播放</span><h2>歌词</h2></div><button className="icon-button" aria-label="关闭歌词" onClick={onClose}><X size={22} /></button></header>{player.track ? <><div className="lyrics-track"><Artwork url={player.track.coverUrl} /><h3>{player.track.title}</h3><p>{player.track.artist}</p></div>{lyrics.lines.length > 0 && <div className="lyrics-offset"><button onClick={() => setOffset(value => value - 0.5)}>提前 0.5 秒</button><span>{offset > 0 ? '+' : ''}{offset.toFixed(1)} 秒</span><button onClick={() => setOffset(value => value + 0.5)}>延后 0.5 秒</button></div>}<div className="lyrics-body">{lyrics.lines.length ? lyrics.lines.map((line, index) => <button key={`${line.time}-${index}`} className={`lyric-line ${index === current ? 'active' : ''}`} ref={index === current ? activeRef : undefined} onClick={() => player.seek(Math.max(0, line.time + offset))}>{line.text || '♪'}</button>) : text ? <p className="plain-lyrics">{lyrics.plain}</p> : <Empty title={error || '此曲目没有歌词'}><button className="button secondary" onClick={() => onEdit(player.track!)}>添加歌词</button></Empty>}</div></> : <Empty title="尚未播放" text="选择曲目后查看歌词。" />}</aside>;
}

export function SleepModal({ player, onClose }: { player: Player; onClose: () => void }) {
  return <Modal title="睡眠定时" onClose={onClose}><div className="modal-body"><div className="timer-options">{[15, 30, 45, 60, 90].map(minutes => <button className="button secondary" key={minutes} onClick={() => { player.sleep(minutes); onClose(); }}>{minutes} 分钟</button>)}<button className="button secondary" onClick={() => { player.sleep(0); player.setSleepAfterTrack(true); onClose(); }}>本曲结束</button></div>{(player.sleepAt > 0 || player.sleepAfterTrack) && <div className="timer-status"><p>{player.sleepAfterTrack ? '本曲结束后停止' : `剩余 ${duration(player.sleepRemaining || Math.ceil((player.sleepAt - Date.now()) / 1000))}`}</p><button className="text-button" onClick={() => { player.sleep(0); player.setSleepAfterTrack(false); onClose(); }}>取消定时</button></div>}</div></Modal>;
}

export function DevicesModal({ player, tracks, onClose, notify }: { player: Player; tracks: Track[]; onClose: () => void; notify: (text: string) => void }) {
  const [states, setStates] = useState<PlayerState[]>([]);
  const [label, setLabel] = useState(player.snapshot.label);
  const [error, setError] = useState('');
  useEffect(() => { void request<{ states: PlayerState[] }>('/player-states').then(result => setStates(result.states || [])).catch(error => setError(messageOf(error))); }, []);
  return <Modal title="播放设备" onClose={onClose}><div className="modal-body"><label className="field">此浏览器名称<div className="inline-field"><input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} /><button className="button secondary" onClick={() => { player.setLabel(label); notify('设备名称已保存'); }}>保存</button></div></label>{error && <p className="error-text">{error}</p>}<div className="devices-list">{states.filter(state => state.deviceId !== player.snapshot.deviceId && state.trackId).map(state => { const track = tracks.find(item => item.id === state.trackId); return <article key={state.deviceId}><div><strong>{state.label || '其他浏览器'}</strong><p>{track?.title || '曲目已不在音乐库'} · {duration(state.position)}</p><small>{date(state.updatedAt)}</small></div><button className="button secondary" disabled={!track} onClick={() => { player.continueFrom(state); onClose(); }}>继续播放</button></article>; })}{!states.some(state => state.deviceId !== player.snapshot.deviceId && state.trackId) && !error && <p className="muted">没有其他设备的播放记录。</p>}</div></div></Modal>;
}

export function UploadModal({ uploader, tracks, onClose, onLocate }: { uploader: Uploader; tracks: Track[]; onClose: () => void; onLocate: (id: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { void uploader.inspect(); }, []);
  const phases = { waiting: '等待上传', hashing: '校验文件', uploading: '上传中', done: '已完成', duplicate: '库中已有', error: '上传失败', paused: '已暂停' };
  return <Modal title="上传音乐" wide onClose={onClose}><div className="modal-body upload-body"><div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); uploader.add(Array.from(event.dataTransfer.files)); }}><UploadCloud size={35} strokeWidth={1.25} /><h3>拖入音频文件</h3><p>可同时选择同名歌词、封面，或文件夹中的 cover 图片。</p><div><button className="button primary" onClick={() => fileInput.current?.click()}><Plus size={17} />选择文件</button><button className="button secondary" onClick={() => folderInput.current?.click()}><FolderUp size={17} />选择文件夹</button></div><input ref={fileInput} type="file" multiple hidden accept="audio/*,.flac,.opus,.aiff,.aif,.wma,.lrc,.txt,.jpg,.jpeg,.png,.webp" onChange={event => { uploader.add(Array.from(event.target.files || [])); event.target.value = ''; }} /><input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={event => { uploader.add(Array.from(event.target.files || [])); event.target.value = ''; }} /></div>
    {uploader.items.length > 0 && <><div className="upload-toolbar"><span>{uploader.items.length} 个音频文件</span><button className="text-button" onClick={uploader.clearDone} disabled={uploader.running}>清除已完成</button></div><div className="upload-items">{uploader.items.map(item => <article className={`upload-item ${item.phase}`} key={item.key}><div className="upload-item-top"><strong title={item.path}>{item.file.name}</strong><span>{item.phase === 'duplicate' && item.track?.deletedAt ? '回收站中已有' : phases[item.phase]}</span>{!uploader.running && <button className="icon-button" aria-label={`移除 ${item.file.name}`} onClick={() => uploader.remove(item.key)}><X size={16} /></button>}</div><p>{bytes(item.file.size)}{item.lyrics ? ' · 歌词' : ''}{item.cover ? ' · 封面' : ''}</p>{['hashing', 'uploading', 'paused'].includes(item.phase) && <div className="upload-meter"><i style={{ width: `${item.progress * 100}%` }} /></div>}{item.error && <p className="error-text">{item.error}</p>}{item.phase === 'duplicate' && item.trackId && <button className="text-button" onClick={() => onLocate(item.trackId!)}>查看已有曲目</button>}{!['done', 'duplicate'].includes(item.phase) && <select className="replacement-select" aria-label={`${item.file.name} 导入方式`} value={item.replaceTrackId || ''} disabled={uploader.running} onChange={event => uploader.replace(item.key, event.target.value)}><option value="">作为新曲目</option>{tracks.map(track => <option key={track.id} value={track.id}>替换：{track.title} · {track.artist}{track.version ? ` · ${track.version}` : ''}</option>)}</select>}</article>)}</div></>}
    {uploader.retained.length > 0 && <section className="retained-uploads"><h3>未完成的上传</h3><p>重新选择同一文件可继续。</p>{uploader.retained.map(upload => <div key={upload.id}><span>{upload.filename}<small>{bytes(upload.offset)} / {bytes(upload.size)}</small></span><button className="text-button" onClick={() => { void uploader.cancelRetained(upload.id); }}>取消</button></div>)}</section>}
    </div><footer className="modal-footer"><span>{uploader.running ? '收起面板后继续上传' : ''}</span>{uploader.running ? <button className="button secondary" onClick={uploader.pause}><Pause size={16} />暂停</button> : <button className="button primary" disabled={!uploader.items.some(item => !['done', 'duplicate'].includes(item.phase))} onClick={() => { void uploader.start(); }}>开始上传</button>}</footer></Modal>;
}

export function TrackEditor({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: () => Promise<void> }) {
  const [data, setData] = useState({ ...track, tagsText: (track.tags || []).join('，'), aliasesText: (track.aliases || []).join('，'), lyricsText: track.lyricsText || '' });
  const [cover, setCover] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const coverInput = useRef<HTMLInputElement>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);
  async function save() {
    setBusy(true); setError('');
    try {
      const { tagsText, aliasesText, ...fields } = data;
      await json(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { title: fields.title, artist: fields.artist, album: fields.album, albumArtist: fields.albumArtist, genre: fields.genre, year: fields.year, trackNumber: fields.trackNumber, discNumber: fields.discNumber, version: fields.version, tags: tagsText.split(/[,，\n]/).map(value => value.trim()).filter(Boolean), aliases: aliasesText.split(/[,，\n]/).map(value => value.trim()).filter(Boolean), lyricsText: fields.lyricsText });
      if (cover) { const form = new FormData(); form.append('file', cover); await request(`/tracks/${encodeURIComponent(track.id)}/cover`, { method: 'POST', body: form }); }
      await onSaved(); onClose();
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title="编辑曲目" wide onClose={onClose}><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-body editor-body"><div className="editor-cover"><Artwork url={track.coverUrl} /><div><strong>{track.originalName}</strong><p>{track.format?.toUpperCase()} · {bytes(track.size)} · {duration(track.duration)}</p><p>{track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : ''}{track.bitDepth ? ` · ${track.bitDepth} bit` : ''}{track.bitrate ? ` · ${Math.round(track.bitrate / 1000)} kbps` : ''}</p><button type="button" className="button secondary" onClick={() => coverInput.current?.click()}>更换封面</button>{cover && <span className="file-selected">{cover.name}</span>}<input hidden type="file" ref={coverInput} accept="image/png,image/jpeg,image/webp" onChange={event => setCover(event.target.files?.[0])} /></div></div><div className="form-grid">{([['title', '曲名'], ['artist', '艺术家'], ['album', '专辑'], ['albumArtist', '专辑艺术家'], ['version', '版本'], ['genre', '风格']] as const).map(([key, label]) => <label className="field" key={key}>{label}<input value={data[key] || ''} maxLength={500} onChange={event => setData(old => ({ ...old, [key]: event.target.value }))} /></label>)}{([['year', '年份'], ['trackNumber', '曲序'], ['discNumber', '碟号']] as const).map(([key, label]) => <label className="field" key={key}>{label}<input type="number" min={0} value={data[key] || ''} onChange={event => setData(old => ({ ...old, [key]: Number(event.target.value) }))} /></label>)}<label className="field full">标签<input value={data.tagsText} onChange={event => setData(old => ({ ...old, tagsText: event.target.value }))} placeholder="用逗号分隔" /></label><label className="field full">搜索别名<input value={data.aliasesText} onChange={event => setData(old => ({ ...old, aliasesText: event.target.value }))} placeholder="别名、拼音或首字母，用逗号分隔" /></label><label className="field full"><div className="field-title"><span>歌词</span><button type="button" className="text-button" onClick={() => lyricsInput.current?.click()}>导入 LRC / 文本</button></div><textarea className="lyrics-editor" value={data.lyricsText} onChange={event => setData(old => ({ ...old, lyricsText: event.target.value }))} rows={8} /><input hidden type="file" ref={lyricsInput} accept=".lrc,.txt" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(text => setData(old => ({ ...old, lyricsText: text }))); }} /></label></div>{error && <p className="error-text">{error}</p>}</div><footer className="modal-footer"><a className="text-button" href={trackURL(track.id, 'download')}><Download size={16} />下载原文件</a><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button></footer></form></Modal>;
}

const bulkFields = [['artist', '艺术家'], ['album', '专辑'], ['albumArtist', '专辑艺术家'], ['genre', '风格'], ['year', '年份']] as const;
type BulkField = typeof bulkFields[number][0] | 'tags';
export function BulkEditor({ tracks, onClose, onRefresh, onSaved }: { tracks: Track[]; onClose: () => void; onRefresh: () => Promise<void>; onSaved: () => void }) {
  const [enabled, setEnabled] = useState<Set<BulkField>>(new Set());
  const [values, setValues] = useState<Record<BulkField, string>>(() => {
    const common = (key: typeof bulkFields[number][0]) => tracks.every(track => track[key] === tracks[0][key]) ? String(tracks[0][key] || '') : '';
    return { artist: common('artist'), album: common('album'), albumArtist: common('albumArtist'), genre: common('genre'), year: common('year'), tags: '' };
  });
  const [tagMode, setTagMode] = useState<'append' | 'replace'>('append');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  function toggle(key: BulkField) { setEnabled(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  async function save() {
    const year = Number(values.year || 0);
    if (enabled.has('year') && (!Number.isInteger(year) || year < 0 || year > 9999)) { setError('请输入有效年份。'); return; }
    setBusy(true); setProgress(0); setError('');
    let completed = 0;
    try {
      for (const track of tracks) {
        const patch: Record<string, unknown> = {};
        for (const [key] of bulkFields) if (enabled.has(key)) patch[key] = key === 'year' ? year : values[key].trim();
        if (enabled.has('tags')) {
          const tags = values.tags.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
          patch.tags = tagMode === 'append' ? [...new Set([...(track.tags || []), ...tags])] : [...new Set(tags)];
        }
        await json(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', patch);
        setProgress(++completed);
      }
      await onRefresh(); onSaved(); onClose();
    } catch (error) {
      setError(`已保存 ${completed}/${tracks.length} 首。${messageOf(error)}`);
      if (completed) await onRefresh();
    } finally { setBusy(false); }
  }
  return <Modal title={`批量编辑 · ${tracks.length} 首`} wide onClose={() => { if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-body"><div className="form-grid bulk-fields">{bulkFields.map(([key, label]) => <div className="field" key={key}><label className="check-label"><input type="checkbox" checked={enabled.has(key)} disabled={busy} onChange={() => toggle(key)} />{label}</label><input aria-label={`批量编辑${label}`} type={key === 'year' ? 'number' : 'text'} min={key === 'year' ? 0 : undefined} max={key === 'year' ? 9999 : undefined} value={values[key]} disabled={!enabled.has(key) || busy} onChange={event => setValues(old => ({ ...old, [key]: event.target.value }))} /></div>)}<div className="field full"><div className="field-title"><label className="check-label"><input type="checkbox" checked={enabled.has('tags')} disabled={busy} onChange={() => toggle('tags')} />标签</label><select aria-label="批量标签操作" value={tagMode} disabled={!enabled.has('tags') || busy} onChange={event => setTagMode(event.target.value as 'append' | 'replace')}><option value="append">追加</option><option value="replace">替换全部</option></select></div><input aria-label="批量编辑标签" value={values.tags} disabled={!enabled.has('tags') || busy} onChange={event => setValues(old => ({ ...old, tags: event.target.value }))} placeholder="用逗号分隔" /></div></div>{error && <p className="error-text">{error}</p>}{busy && <div className="bulk-progress"><div className="upload-meter"><i style={{ width: `${progress / tracks.length * 100}%` }} /></div><span>正在保存 {progress}/{tracks.length} 首</span></div>}</div><footer className="modal-footer"><span>{enabled.size ? `更新 ${enabled.size} 项信息` : '选择要更新的字段'}</span><button className="button primary" type="submit" disabled={busy || !enabled.size}>{busy ? '保存中…' : error ? '重试' : '保存'}</button></footer></form></Modal>;
}

export function PlaylistEditor({ playlist, initialIds = [], onClose, onSaved }: { playlist?: Playlist; initialIds?: string[]; onClose: () => void; onSaved: (playlist: Playlist) => Promise<void> }) {
  const [name, setName] = useState(playlist?.name || '');
  const [description, setDescription] = useState(playlist?.description || '');
  const [kind, setKind] = useState<'manual' | 'smart'>(playlist?.kind || 'manual');
  const [rules, setRules] = useState<Rules>(playlist?.rules || {});
  const [tags, setTags] = useState((playlist?.rules.tags || []).join('，'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const data = { name: name.trim(), description, kind, rules: { ...rules, tags: tags.split(/[,，]/).map(value => value.trim()).filter(Boolean) }, trackIds: playlist?.trackIds || initialIds };
      const result = await json<{ playlist: Playlist }>(playlist ? `/playlists/${encodeURIComponent(playlist.id)}` : '/playlists', playlist ? 'PUT' : 'POST', data);
      await onSaved(result.playlist); onClose();
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title={playlist ? '编辑歌单' : '新建歌单'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-body"><label className="field">名称<input required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label><label className="field">简介<textarea value={description} rows={2} maxLength={1000} onChange={event => setDescription(event.target.value)} /></label><div className="segmented"><button type="button" className={kind === 'manual' ? 'active' : ''} onClick={() => setKind('manual')}>普通歌单</button><button type="button" className={kind === 'smart' ? 'active' : ''} onClick={() => setKind('smart')}>智能歌单</button></div>{kind === 'smart' ? <div className="smart-rules"><label className="check-label"><input type="checkbox" checked={rules.favorite || false} onChange={event => setRules(old => ({ ...old, favorite: event.target.checked ? true : undefined }))} />仅收藏曲目</label><label className="check-label"><input type="checkbox" checked={rules.unplayed || false} onChange={event => setRules(old => ({ ...old, unplayed: event.target.checked ? true : undefined }))} />尚未播放</label><label className="field">标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="用逗号分隔" /></label><div className="form-grid"><label className="field">艺术家<input value={rules.artist || ''} onChange={event => setRules(old => ({ ...old, artist: event.target.value || undefined }))} /></label><label className="field">风格<input value={rules.genre || ''} onChange={event => setRules(old => ({ ...old, genre: event.target.value || undefined }))} /></label>{([['yearFrom', '起始年份'], ['yearTo', '结束年份'], ['unheardDays', '至少多少天未听'], ['limit', '最多曲目数']] as const).map(([key, label]) => <label className="field" key={key}>{label}<input type="number" min={1} value={rules[key] || ''} onChange={event => setRules(old => ({ ...old, [key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}</div></div> : <p className="muted">{(playlist?.trackIds || initialIds).length} 首曲目</p>}{error && <p className="error-text">{error}</p>}</div><footer className="modal-footer"><span /> <button className="button primary" disabled={busy || !name.trim()} type="submit">{busy ? '保存中…' : '保存'}</button></footer></form></Modal>;
}
