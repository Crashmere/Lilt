import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, ChevronDown, CircleAlert, Download, FolderUp, ImagePlus, ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Play, Plus, Repeat, Repeat1, RotateCw, Shuffle, Trash2, UploadCloud, X } from 'lucide-react';
import { ApiError, json, messageOf, request, trackURL } from './api';
import { Artwork, Empty, Modal, TrackPlaylists } from './components';
import { TrackCredits, type CollectionNavigation } from './track-links';
import type { Player } from './player';
import type { PlaylistMemberships } from './playlist-memberships';
import type { Playlist, Rules, Track, Upload } from './types';
import type { Uploader, UploadPlaylist } from './upload';
import { droppedFiles } from './drop-files';
import { formatUploadRate } from './upload-rate';
import { useLyrics } from './lyrics';
import { bytes, duration, parseLyrics } from './utils';

function PlayerGlyph({ name }: { name: 'shuffle' | 'previous' | 'play' | 'pause' | 'next' | 'repeat' | 'more' | 'lyrics' | 'queue' | 'volume' }) {
  return <span className={`player-glyph player-glyph-${name}`} aria-hidden="true" />;
}

export function PlayerBar({ player, panel, onQueue, onLyrics, onMore, collectionNavigation }: { player: Player; panel: 'queue' | 'lyrics' | null; onQueue: () => void; onLyrics: () => void; onMore: (track: Track) => void; collectionNavigation: CollectionNavigation }) {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const unmutedVolume = useRef(player.snapshot.volume || 0.8);
  const totalDuration = player.track?.duration || 0;
  const position = player.track ? player.position : 0;
  const progress = totalDuration ? Math.max(0, Math.min(position / totalDuration, 1)) : 0;

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!optionsRef.current?.contains(event.target as Node)) setVolumeOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setVolumeOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);

  function toggleMute() {
    if (player.snapshot.volume > 0) { unmutedVolume.current = player.snapshot.volume; player.setVolume(0); }
    else player.setVolume(unmutedVolume.current);
  }

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
    <div className="transport">
      <button className={`icon-button mode-button shuffle-button ${player.snapshot.shuffle ? 'active' : ''}`} aria-label="随机播放" aria-pressed={player.snapshot.shuffle} onClick={player.toggleShuffle}><PlayerGlyph name="shuffle" /></button>
      <button className="icon-button skip-button previous-button" aria-label="上一首" onClick={player.previous} disabled={!player.track}><PlayerGlyph name="previous" /></button>
      <button className="icon-button main-play" aria-label={player.playing ? '暂停' : '播放'} aria-busy={player.loading} onClick={() => player.playing ? player.pause() : player.play()} disabled={!player.queue.length}><PlayerGlyph name={player.playing ? 'pause' : 'play'} /></button>
      <button className="icon-button skip-button next-button" aria-label="下一首" onClick={() => player.next()} disabled={!player.track}><PlayerGlyph name="next" /></button>
      <button className={`icon-button mode-button repeat-button ${player.snapshot.repeat !== 'off' ? 'active' : ''}`} aria-label={`循环：${player.snapshot.repeat === 'off' ? '关闭' : player.snapshot.repeat === 'all' ? '全部' : '单曲'}`} aria-pressed={player.snapshot.repeat !== 'off'} onClick={player.toggleRepeat}><PlayerGlyph name="repeat" />{player.snapshot.repeat === 'one' && <span className="repeat-one-count" aria-hidden="true">1</span>}</button>
    </div>
    <div className="player-center">
      <div className="player-track"><button className="player-cover" onClick={onLyrics} aria-label="查看正在播放" disabled={!player.track}><Artwork url={player.track?.coverUrl} /></button><div><button className="now-title" onClick={onLyrics} disabled={!player.track}>{player.track?.title || '尚未播放'}</button><p>{player.track ? <TrackCredits track={player.track} navigation={collectionNavigation} /> : '选择一首音乐'}</p></div></div>
      <div className="player-progress" title={`${duration(position)} / ${duration(totalDuration)}`}><div className="player-seek" style={{ '--progress': `${progress * 100}%` } as React.CSSProperties}><input type="range" aria-label="播放进度" aria-valuetext={`${duration(position)} / ${duration(totalDuration)}`} min={0} max={totalDuration || 1} step="0.1" value={progress * totalDuration} disabled={totalDuration <= 0} onChange={event => player.seek(Number(event.target.value))} onPointerDown={startSeek} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekAtPointer(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { seekAtPointer(event); event.currentTarget.releasePointerCapture(event.pointerId); } }} /></div></div>
    </div>
    <div className="player-options" ref={optionsRef}>
      <div className="player-more-actions">
        <button className="icon-button more-button" aria-label="当前歌曲更多功能" title="更多功能" disabled={!player.track} onClick={() => { setVolumeOpen(false); if (player.track) onMore(player.track); }}><PlayerGlyph name="more" /></button>
      </div>
      <div className="player-view-actions">
        <button className={`icon-button lyrics-button ${panel === 'lyrics' ? 'active' : ''}`} aria-label="歌词" aria-pressed={panel === 'lyrics'} onClick={() => { setVolumeOpen(false); onLyrics(); }}><PlayerGlyph name="lyrics" /></button>
        <button className={`icon-button queue-button ${panel === 'queue' ? 'active' : ''}`} aria-label="播放队列" aria-pressed={panel === 'queue'} onClick={() => { setVolumeOpen(false); onQueue(); }}><PlayerGlyph name="queue" /></button>
        <button className="icon-button volume-button" aria-label="调整音量" aria-expanded={volumeOpen} onClick={() => setVolumeOpen(old => !old)}><PlayerGlyph name="volume" /></button>
      </div>
      {volumeOpen && <div className="player-popover volume-control" role="dialog" aria-label="音量设置"><button className="icon-button mute-button" data-muted={player.snapshot.volume === 0} aria-label={player.snapshot.volume ? '静音' : '取消静音'} onClick={toggleMute}><PlayerGlyph name="volume" /></button><input type="range" min={0} max={1} step="0.01" value={player.snapshot.volume} style={{ '--progress': `${player.snapshot.volume * 100}%` } as React.CSSProperties} aria-label="音量" onChange={event => player.setVolume(Number(event.target.value))} /><span>{Math.round(player.snapshot.volume * 100)}%</span></div>}
    </div>
  </footer>;
}

export function QueuePanel({ player, playlistMemberships, showPlaylists, onClose, onSave, onMore, collectionNavigation }: { player: Player; playlistMemberships: PlaylistMemberships; showPlaylists: (track: Track) => void; onClose: () => void; onSave: (ids: string[]) => void; onMore: (track: Track) => void; collectionNavigation: CollectionNavigation }) {
  const dragged = useRef(-1);
  return <aside className="side-panel" aria-label="播放队列">
    <header><div><h2>播放队列 <small>{player.queue.length}</small></h2></div><button className="icon-button" aria-label="关闭队列" onClick={onClose}><X size={22} /></button></header>
    <div className="panel-toolbar"><button className="text-button" onClick={() => onSave(player.snapshot.queueIds)} disabled={!player.queue.length}><Plus size={16} />存为歌单</button><button className="text-button" onClick={player.clear} disabled={!player.queue.length}>清空</button></div>
    <div className="queue-modes"><button className={`pill ${player.snapshot.shuffle ? 'active' : ''}`} aria-pressed={player.snapshot.shuffle} onClick={player.toggleShuffle}><Shuffle size={13} />随机</button><button className={`pill ${player.snapshot.repeat !== 'off' ? 'active' : ''}`} onClick={player.toggleRepeat}>{player.snapshot.repeat === 'one' ? <Repeat1 size={13} /> : <Repeat size={13} />}{player.snapshot.repeat === 'one' ? '单曲循环' : player.snapshot.repeat === 'all' ? '全部循环' : '循环关闭'}</button></div>
    <div className="queue-items">{player.queue.length ? player.queue.map((track, index) => <div className={`queue-row ${player.snapshot.queueIndex === index ? 'current' : ''}`} key={`${track.id}-${index}`} draggable onDragStart={() => { dragged.current = index; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged.current >= 0 && dragged.current !== index) player.reorder(dragged.current, index); dragged.current = -1; }}>
      <span className="queue-number">{index + 1}</span><Artwork url={track.coverUrl} />
      <div className="queue-track"><button className="queue-name" onClick={() => player.begin(player.snapshot.queueIds, index)}><strong>{track.title}</strong></button><p className="queue-credits"><TrackCredits track={track} navigation={collectionNavigation} /></p></div>
      <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={playlistMemberships.get(track.id)} onOpen={() => showPlaylists(track)} /></div>
      <div className="queue-row-actions"><button className="icon-button" aria-label={`${track.title} 更多操作`} onClick={() => onMore(track)}><MoreHorizontal size={16} /></button><button className="icon-button" aria-label="上移" disabled={index === 0} onClick={() => player.reorder(index, index - 1)}>↑</button><button className="icon-button" aria-label="下移" disabled={index === player.queue.length - 1} onClick={() => player.reorder(index, index + 1)}>↓</button><button className="icon-button" aria-label={`从队列移除 ${track.title}`} onClick={() => player.remove(index)}><X size={15} /></button></div>
    </div>) : <Empty title="队列为空" />}</div>
  </aside>;
}

export function LyricsPanel({ player, onClose, onEdit }: { player: Player; onClose: () => void; onEdit: (track: Track) => void }) {
  const { text, loading, error, reload } = useLyrics(player.track);
  const [offset, setOffset] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOffset(0); }, [player.trackId]);
  const lyrics = parseLyrics(text);
  let current = -1;
  lyrics.lines.forEach((line, index) => { if (line.time + offset <= player.position) current = index; });
  useEffect(() => { activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [current]);
  return <aside className="side-panel lyrics-panel"><header><div><span className="eyebrow">正在播放</span><h2>歌词</h2></div><button className="icon-button" aria-label="关闭歌词" onClick={onClose}><X size={22} /></button></header>{player.track ? <><div className="lyrics-track"><Artwork url={player.track.coverUrl} /><h3>{player.track.title}</h3><p>{player.track.artist}</p></div>{lyrics.lines.length > 0 && <div className="lyrics-offset"><button onClick={() => setOffset(value => value - 0.5)}>提前 0.5 秒</button><span>{offset > 0 ? '+' : ''}{offset.toFixed(1)} 秒</span><button onClick={() => setOffset(value => value + 0.5)}>延后 0.5 秒</button></div>}<div className="lyrics-body" aria-busy={loading}>{loading ? <div className="empty-state" role="status"><div className="empty-symbol"><LoaderCircle size={32} className="spin" /></div><h3>歌词加载中…</h3></div> : error ? <Empty title="歌词加载失败" text={error}><button className="button secondary" onClick={reload}>重试</button></Empty> : lyrics.lines.length ? lyrics.lines.map((line, index) => <button key={`${line.time}-${index}`} className={`lyric-line ${index === current ? 'active' : ''}`} ref={index === current ? activeRef : undefined} onClick={() => player.seek(Math.max(0, line.time + offset))}>{line.text || '♪'}</button>) : text ? <p className="plain-lyrics">{lyrics.plain}</p> : <Empty title="此曲目没有歌词"><button className="button secondary" onClick={() => onEdit(player.track!)}>添加歌词</button></Empty>}</div></> : <Empty title="尚未播放" text="选择曲目后查看歌词。" />}</aside>;
}

export function UploadModal({ uploader, playlist, onClose, onLocate }: { uploader: Uploader; playlist?: UploadPlaylist; onClose: () => void; onLocate: (id: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [dropError, setDropError] = useState('');
  const [discard, setDiscard] = useState<Upload>();
  const [discardBusy, setDiscardBusy] = useState(false);
  const resumeTarget = useRef<Upload | undefined>(undefined);
  const dragDepth = useRef(0);
  useEffect(() => { void uploader.inspect(); }, []);
  const phases = { waiting: '等待上传', hashing: '读取与校验', uploading: '上传中', verifying: '校验与入库', joining: '加入歌单', applying: '保存歌词与封面', done: '已完成', duplicate: '库中已有', error: '上传失败', paused: '已暂停' };
  const completed = uploader.items.filter(item => ['done', 'duplicate'].includes(item.phase)).length;
  const priority = (phase: string) => ['hashing', 'uploading', 'verifying', 'joining', 'applying'].includes(phase) ? 0 : ['done', 'duplicate'].includes(phase) ? 2 : 1;
  const items = [...uploader.items].sort((a, b) => priority(a.phase) - priority(b.phase));
  const pending = uploader.retained.filter(upload => !uploader.items.some(item => item.uploadId === upload.id || item.fingerprint === upload.fingerprint || item.expectedFingerprint === upload.fingerprint));
  function pick(resume?: Upload) { resumeTarget.current = resume; if (fileInput.current) { fileInput.current.multiple = !resume; fileInput.current.click(); } }
  async function drop(transfer: DataTransfer) {
    setReading(true); setDropError('');
    try { uploader.add(await droppedFiles(transfer), undefined, playlist); }
    catch { setDropError('文件夹读取失败，请使用「选择文件夹」重试。'); }
    finally { setReading(false); }
  }
  async function confirmDiscard() {
    if (!discard || discardBusy) return;
    setDiscardBusy(true);
    try { if (await uploader.cancelRetained(discard.id)) setDiscard(undefined); }
    finally { setDiscardBusy(false); }
  }
  const resumable = uploader.items.some(item => ['paused', 'error'].includes(item.phase));
  const busy = reading || discardBusy;
  return <Modal title={playlist ? `上传音乐 · ${playlist.name}` : '上传音乐'} wide onClose={() => { if (!busy) onClose(); }}><div className="modal-body upload-body">
    <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragEnter={event => { event.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!busy) void drop(event.dataTransfer); }}>
      {reading ? <LoaderCircle size={35} className="spinning" /> : <UploadCloud size={35} strokeWidth={1.25} />}<h3>{reading ? '正在读取文件夹' : '拖入音乐或文件夹'}</h3><p>同名歌词、封面和文件夹中的 cover 图片会一起导入。</p>
      <div><button className="button primary" disabled={busy} onClick={() => pick()}><Music2 size={17} />选择文件</button><button className="button secondary" disabled={busy} onClick={() => folderInput.current?.click()}><FolderUp size={17} />选择文件夹</button></div>
      <input ref={fileInput} type="file" multiple hidden accept="audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.aiff,.aif,.wma,.webm,.ape,.wv,.tta,.dsf,.lrc,.txt,.jpg,.jpeg,.png,.webp" onChange={event => { uploader.add(Array.from(event.target.files || []), resumeTarget.current, playlist); resumeTarget.current = undefined; event.target.value = ''; }} />
      <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={event => { uploader.add(Array.from(event.target.files || []), undefined, playlist); event.target.value = ''; }} />
    </div>
    {dropError && <p className="error-text" role="alert">{dropError}</p>}
    {uploader.inspectError && <div className="upload-notice" role="alert"><span>{uploader.inspectError}</span><button className="text-button" onClick={() => { void uploader.inspect(); }}>重新加载</button></div>}
    {items.length > 0 && <>
      <div className="upload-summary"><div><span>本次上传</span><strong>{completed}<small> / {items.length}</small></strong></div><div className="upload-speed"><span>当前发送速率</span><strong>{formatUploadRate(items.reduce((sum, item) => sum + item.bytesPerSecond, 0))}</strong></div></div>
      <div className="upload-toolbar"><span>{items.filter(item => item.phase === 'error').length ? `${items.filter(item => item.phase === 'error').length} 项待重试` : `${items.length - completed} 项未完成`}</span><div>{resumable && uploader.running && <button className="text-button" disabled={busy} onClick={() => uploader.start()}>继续 / 重试全部</button>}<button className="text-button" onClick={uploader.clearDone} disabled={!completed || busy}>清除已完成</button></div></div>
      <div className="upload-items">{items.map(item => {
        const done = ['done', 'duplicate'].includes(item.phase);
        const active = ['hashing', 'uploading', 'verifying', 'joining', 'applying'].includes(item.phase);
        const status = item.retrying ? '连接中断，正在重试' : item.awaitingAck ? '等待服务器确认' : item.phase === 'duplicate' && item.track?.deletedAt ? '回收站中已有' : phases[item.phase];
        return <article className={`upload-item ${item.phase}`} key={item.key}>
          <div className="upload-state-icon">{item.phase === 'done' ? <Check size={19} /> : item.phase === 'duplicate' ? <CheckCheck size={19} /> : item.phase === 'error' ? <CircleAlert size={19} /> : active ? <LoaderCircle size={19} className="spinning" /> : item.phase === 'paused' ? <Pause size={18} /> : <Music2 size={19} />}</div>
          <div className="upload-description"><div className="upload-item-top"><strong title={item.path}>{item.file.name}</strong><span>{status}</span></div>
            {item.path !== item.file.name && <p className="upload-path" title={item.path}>{item.path}</p>}
            <div className="upload-meta"><span>{bytes(item.file.size)}</span>{item.playlist && <span>歌单：{item.playlist.name}</span>}{item.lyrics && <span>歌词</span>}{item.cover && <span>封面</span>}{!done && <span>{Math.min(99, Math.floor(item.progress * 100))}%</span>}</div>
            {!done && <><div className={`upload-meter ${['verifying', 'joining', 'applying'].includes(item.phase) ? 'processing' : ''}`} role="progressbar" aria-label={`${item.file.name} 上传进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(item.progress * 100)}><i style={{ width: `${item.progress * 100}%` }} /></div>{item.uploadId && <p className="upload-confirmed">服务器已确认 {bytes(item.uploadedBytes)} / {bytes(item.file.size)}</p>}</>}
            {item.error && <p className="error-text" role="alert">{item.error}</p>}
            {item.trackId && <button className="text-button upload-locate" onClick={() => onLocate(item.trackId!)}>{item.track?.deletedAt ? '查看回收站曲目' : item.phase === 'duplicate' ? '查看已有曲目' : '查看曲目'}</button>}
          </div>
          <div className="upload-row-actions">{!done && (['paused', 'error'].includes(item.phase) ? <button className="icon-button" disabled={busy} aria-label={`${item.phase === 'error' ? '重试' : '继续'} ${item.file.name}`} title={item.phase === 'error' ? '仅重试此文件' : '仅继续此文件'} onClick={() => uploader.start(item.key)}>{item.phase === 'error' ? <RotateCw size={16} /> : <Play size={16} />}</button> : <button className="icon-button" disabled={busy} aria-label={`暂停 ${item.file.name}`} onClick={() => uploader.pause(item.key)}><Pause size={16} /></button>)}<button className="icon-button" disabled={busy} aria-label={`移出列表 ${item.file.name}`} title={done ? '只移出列表，不删除音乐' : '移出队列，保留已确认的分片'} onClick={() => { uploader.remove(item.key); void uploader.inspect(); }}><X size={16} /></button></div>
        </article>;
      })}</div>
    </>}
    {pending.length > 0 && <section className="retained-uploads"><h3>未完成的上传 <small>{pending.length}</small></h3><p>选择相同原文件续传，已确认的分片无需重传。</p>{pending.map(upload => <div className="retained-upload" key={upload.id}><span title={upload.filename}>{upload.filename}<small>{bytes(upload.offset)} / {bytes(upload.size)}</small></span><div><button className="text-button" disabled={busy} onClick={() => pick(upload)}>选择原文件续传</button><button className="icon-button danger" disabled={busy} aria-label={`丢弃 ${upload.filename} 的未完成上传`} onClick={() => setDiscard(upload)}><Trash2 size={16} /></button></div></div>)}</section>}
    {discard && <div className="upload-discard" role="alert"><h3>丢弃未完成上传？</h3><p>「{discard.filename}」已接收的 {bytes(discard.offset)} 分片将被清理，已入库音乐不受影响。</p><div><button className="button secondary" disabled={discardBusy} onClick={() => setDiscard(undefined)}>保留上传</button><button className="button danger" disabled={discardBusy} onClick={() => { void confirmDiscard(); }}>{discardBusy ? '正在丢弃' : '确认丢弃'}</button></div></div>}
    </div><footer className="modal-footer"><span>{uploader.running ? '收起面板后继续上传' : resumable ? '暂停的上传和失败项可继续' : '分段上传 · 完整校验后入库'}</span>{uploader.running ? <button className="button secondary" disabled={busy} onClick={() => uploader.pause()}><Pause size={16} />暂停全部</button> : <button className="button primary" disabled={busy || !items.some(item => !['done', 'duplicate'].includes(item.phase))} onClick={() => uploader.start()}>{resumable ? <Play size={16} /> : <UploadCloud size={16} />}{resumable ? '继续 / 重试全部' : '开始上传'}</button>}</footer></Modal>;
}

export function TrackEditor({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: (track: Track) => Promise<void> }) {
  const [data, setData] = useState({ title: track.title, artist: track.artist, album: track.album, albumArtist: track.albumArtist, genre: track.genre, version: track.version, composer: track.composer || '', lyricist: track.lyricist || '', comment: track.comment || '', copyright: track.copyright || '', isrc: track.isrc || '', bpm: String(track.bpm || ''), year: String(track.year || ''), trackNumber: String(track.trackNumber || ''), discNumber: String(track.discNumber || ''), tagsText: (track.tags || []).join('，'), aliasesText: (track.aliases || []).join('，'), lyricsText: track.lyricsText || '' });
  const initialData = useRef(JSON.stringify(data));
  const expectedUpdatedAt = useRef(track.updatedAt);
  const [cover, setCover] = useState<File>();
  const [preview, setPreview] = useState('');
  const [removeCover, setRemoveCover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readingLyrics, setReadingLyrics] = useState(false);
  const [error, setError] = useState('');
  const coverInput = useRef<HTMLInputElement>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);
  const disabled = busy || readingLyrics;
  const dirty = JSON.stringify(data) !== initialData.current || !!cover || removeCover;
  useEffect(() => {
    if (!cover) { setPreview(''); return; }
    const url = URL.createObjectURL(cover); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);
  function close() { if (!disabled && (!dirty || window.confirm('放弃未保存的修改？'))) onClose(); }
  async function importLyrics(file: File) {
    if (file.size > 1024 ** 2) { setError('歌词不能超过 1 MiB'); return; }
    setReadingLyrics(true); setError('');
    try { const text = await file.text(); setData(old => ({ ...old, lyricsText: text })); }
    catch (error) { setError(messageOf(error)); }
    finally { setReadingLyrics(false); }
  }
  async function save() {
    if (disabled) return;
    if (!data.title.trim()) { setError('请输入曲名'); return; }
    const numbers = { year: Number(data.year || 0), trackNumber: Number(data.trackNumber || 0), discNumber: Number(data.discNumber || 0), bpm: Number(data.bpm || 0) };
    if (!Number.isFinite(numbers.bpm) || numbers.bpm < 0 || numbers.bpm > 9999) { setError('请输入 0 至 9999 的 BPM'); return; }
    for (const [key, label, maximum] of [['year', '年份', 9999], ['trackNumber', '曲序', 99999], ['discNumber', '碟号', 9999]] as const) {
      if (!Number.isInteger(numbers[key]) || numbers[key] < 0 || numbers[key] > maximum) { setError(`${label}应为 0 至 ${maximum} 的整数`); return; }
    }
    setBusy(true); setError('');
    try {
      const { tagsText, aliasesText, ...fields } = data;
      const split = (value: string) => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
      const patch = { ...fields, ...numbers, tags: split(tagsText), aliases: split(aliasesText), removeCover, expectedUpdatedAt: expectedUpdatedAt.current };
      const path = `/tracks/${encodeURIComponent(track.id)}`;
      let result: { track: Track };
      if (cover) {
        const form = new FormData(); form.append('metadata', JSON.stringify(patch)); form.append('file', cover);
        result = await request<{ track: Track }>(`${path}/cover`, { method: 'POST', body: form });
      } else result = await json<{ track: Track }>(path, 'PATCH', patch);
      expectedUpdatedAt.current = result.track.updatedAt;
      await onSaved(result.track); onClose();
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title="编辑曲目" wide onClose={close}><form onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="modal-body editor-body"><fieldset className="editor-fields" disabled={disabled}>
      <div className="editor-cover"><Artwork url={removeCover ? undefined : preview || track.coverUrl} /><div><strong>{track.originalName}</strong><p>{track.format?.toUpperCase()} · {bytes(track.size)} · {duration(track.duration)}</p><p>{[track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : '', track.bitDepth ? `${track.bitDepth} bit` : '', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '', track.channels ? `${track.channels} 声道` : ''].filter(Boolean).join(' · ')}</p>
        <div className="editor-cover-actions"><button type="button" className="button secondary" onClick={() => coverInput.current?.click()}>更换封面</button>{(cover || track.coverUrl) && <button type="button" className="text-button" onClick={() => { if (removeCover) setRemoveCover(false); else { setCover(undefined); setRemoveCover(true); } }}>{removeCover ? '恢复封面' : '移除封面'}</button>}{cover && <button type="button" className="text-button" onClick={() => setCover(undefined)}>撤销更换</button>}</div>
        {cover && <span className="file-selected">{cover.name}</span>}<input hidden type="file" ref={coverInput} accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setCover(file); setRemoveCover(false); setError(''); }} />
      </div></div>
      <div className="form-grid">{([['title', '曲名'], ['artist', '艺术家'], ['album', '专辑'], ['albumArtist', '专辑艺术家'], ['version', '版本'], ['genre', '风格']] as const).map(([key, label]) => <label className="field" key={key}>{label}<input value={data[key]} required={key === 'title'} maxLength={4096} onChange={event => setData(old => ({ ...old, [key]: event.target.value }))} /></label>)}
        {([['year', '年份', 9999], ['trackNumber', '曲序', 99999], ['discNumber', '碟号', 9999]] as const).map(([key, label, maximum]) => <label className="field" key={key}>{label}<input type="number" min={0} max={maximum} step={1} value={data[key]} onChange={event => setData(old => ({ ...old, [key]: event.target.value }))} /></label>)}
        <label className="field">BPM<input type="number" min={0} max={9999} step="any" value={data.bpm} onChange={event => setData(old => ({ ...old, bpm: event.target.value }))} /></label>
        {([['composer', '作曲'], ['lyricist', '作词'], ['copyright', '版权'], ['isrc', 'ISRC']] as const).map(([key, label]) => <label className="field" key={key}>{label}<input value={data[key]} maxLength={4096} onChange={event => setData(old => ({ ...old, [key]: event.target.value }))} /></label>)}
        <label className="field full">备注<textarea value={data.comment} maxLength={4096} rows={3} onChange={event => setData(old => ({ ...old, comment: event.target.value }))} /></label>
        <label className="field full">标签<input value={data.tagsText} onChange={event => setData(old => ({ ...old, tagsText: event.target.value }))} placeholder="用逗号分隔" /></label><label className="field full">搜索别名<input value={data.aliasesText} onChange={event => setData(old => ({ ...old, aliasesText: event.target.value }))} placeholder="用逗号分隔" /></label>
        <div className="field full"><div className="field-title"><label htmlFor="track-lyrics-editor">歌词</label><div className="editor-lyrics-actions"><button type="button" className="text-button" onClick={() => lyricsInput.current?.click()}>{readingLyrics ? '读取中…' : '导入 LRC / 文本'}</button>{data.lyricsText && <button type="button" className="text-button" onClick={() => setData(old => ({ ...old, lyricsText: '' }))}>清空</button>}</div></div><textarea id="track-lyrics-editor" className="lyrics-editor" value={data.lyricsText} onChange={event => setData(old => ({ ...old, lyricsText: event.target.value }))} rows={8} /><input hidden type="file" ref={lyricsInput} accept=".lrc,.txt" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importLyrics(file); }} /></div>
      </div>
    </fieldset>{error && <p className="error-text" role="alert">{error}</p>}</div>
    <footer className="modal-footer"><a className="text-button" href={trackURL(track.id, 'download')}><Download size={16} />下载音频</a><div className="editor-footer-actions"><button className="button secondary" type="button" disabled={disabled} onClick={close}>取消</button><button className="button primary" type="submit" disabled={disabled}>{busy ? '写回中…' : '保存并写回'}</button></div></footer>
  </form></Modal>;
}

const bulkFields = [['artist', '艺术家'], ['album', '专辑'], ['albumArtist', '专辑艺术家'], ['genre', '风格'], ['year', '年份']] as const;
type BulkField = typeof bulkFields[number][0];
type BulkMode = 'keep' | 'set' | 'clear';
export function BulkEditor({ tracks, onClose, onRefresh, onSaved }: { tracks: Track[]; onClose: () => void; onRefresh: () => Promise<void>; onSaved: () => void }) {
  const [modes, setModes] = useState<Record<BulkField, BulkMode>>({ artist: 'keep', album: 'keep', albumArtist: 'keep', genre: 'keep', year: 'keep' });
  const [values, setValues] = useState<Record<BulkField, string>>(() => {
    const common = (key: BulkField) => tracks.every(track => track[key] === tracks[0]?.[key]) ? String(tracks[0]?.[key] || '') : '';
    return { artist: common('artist'), album: common('album'), albumArtist: common('albumArtist'), genre: common('genre'), year: common('year') };
  });
  const [tagMode, setTagMode] = useState<'keep' | 'append' | 'replace' | 'clear'>('keep');
  const [tagsText, setTagsText] = useState('');
  const [coverMode, setCoverMode] = useState<BulkMode>('keep');
  const [cover, setCover] = useState<File>();
  const [coverPreview, setCoverPreview] = useState('');
  const coverInput = useRef<HTMLInputElement>(null);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const completed = useRef(new Set<string>());
  const running = useRef(false);
  const changed = bulkFields.filter(([key]) => modes[key] !== 'keep').length + (tagMode !== 'keep' ? 1 : 0) + (coverMode !== 'keep' ? 1 : 0);
  const locked = busy || progress > 0;
  const tags = [...new Set(tagsText.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  const covers = tracks.filter(track => track.coverUrl).length;

  useEffect(() => {
    if (!cover) { setCoverPreview(''); return; }
    const url = URL.createObjectURL(cover); setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function close() {
    if (!running.current && (!changed || progress === tracks.length || window.confirm(progress ? `已保存 ${progress} 首曲目。退出后，其余曲目将不再修改。` : '放弃未保存的修改？'))) onClose();
  }
  function currentValue(key: BulkField) {
    const distinct = [...new Set(tracks.map(track => String(track[key] || '')))];
    return distinct.length > 1 ? `多个值 · ${distinct.length} 种` : distinct[0] || '未填写';
  }
  const currentTags = [...new Set(tracks.flatMap(track => track.tags || []))];

  async function save() {
    if (running.current || !changed || !tracks.length) return;
    if (coverMode === 'set' && !cover) { setError('请选择封面图片，或选择「保持原封面」。'); return; }
    const year = Number(values.year || 0);
    if (modes.year === 'set' && (!Number.isInteger(year) || year < 1 || year > 9999)) { setError('年份应为 1 至 9999 的整数；移除年份请选择「清空」。'); return; }
    for (const [key, label] of bulkFields) {
      if (modes[key] === 'set' && !values[key].trim()) { setError(`请输入${label}，或选择「清空」。`); return; }
    }
    if ((tagMode === 'append' || tagMode === 'replace') && !tags.length) { setError('请输入标签，或选择「清空标签」。'); return; }
    running.current = true; setBusy(true); setError('');
    let current: Track | undefined;
    try {
      for (const track of tracks) {
        if (completed.current.has(track.id)) continue;
        current = track;
        const path = `/tracks/${encodeURIComponent(track.id)}`;
        const latest = (await request<{ track: Track }>(path)).track;
        if (latest.deletedAt) throw new Error('曲目已移入回收站，请关闭后重新选择。');
        const patch: Record<string, unknown> = { expectedUpdatedAt: latest.updatedAt };
        for (const [key] of bulkFields) {
          if (modes[key] === 'set') patch[key] = key === 'year' ? year : values[key].trim();
          else if (modes[key] === 'clear') patch[key] = key === 'year' ? 0 : '';
        }
        if (tagMode !== 'keep') patch.tags = tagMode === 'clear' ? [] : tagMode === 'append' ? [...new Set([...(latest.tags || []), ...tags])] : tags;
        if (coverMode === 'clear') patch.removeCover = true;
        if (coverMode === 'set' && cover) {
          const form = new FormData(); form.append('file', cover); form.append('metadata', JSON.stringify(patch));
          await request<{ track: Track }>(`${path}/cover`, { method: 'POST', body: form });
        } else await json(path, 'PATCH', patch);
        completed.current.add(track.id); setProgress(completed.current.size);
      }
    } catch (error) {
      setError(`${current ? `「${current.title}」保存失败。` : ''}${messageOf(error)}`);
    } finally {
      try { if (completed.current.size) await onRefresh(); }
      finally { running.current = false; setBusy(false); }
    }
    if (completed.current.size === tracks.length) { onSaved(); onClose(); }
  }
  return <Modal title="批量编辑" className="bulk-editor-modal" onClose={close}><form onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="bulk-editor-body">
      <aside className={`bulk-selection ${selectionOpen ? 'expanded' : ''}`} aria-label="所选曲目">
        <header><h3>所选曲目</h3><span>{tracks.length} 首</span><button className="icon-button" type="button" aria-label={selectionOpen ? '收起所选曲目' : '展开所选曲目'} aria-expanded={selectionOpen} aria-controls="bulk-track-list" onClick={() => setSelectionOpen(old => !old)}><ChevronDown size={17} /></button></header>
        <ol className="bulk-track-list" id="bulk-track-list">{tracks.map((track, index) => <li key={track.id}>
          <span className="bulk-track-number">{completed.current.has(track.id) ? <Check size={13} aria-label="已保存" /> : index + 1}</span><Artwork url={track.coverUrl} />
          <div><strong title={track.title}>{track.title || track.originalName}</strong><span title={track.artist}>{track.artist || '未知艺术家'}{track.version && ` · ${track.version}`}</span></div>
        </li>)}</ol>
      </aside>
      <div className="bulk-edit-fields">
        <header className="bulk-edit-intro"><h3>修改信息</h3><p>未修改的字段保留原值</p></header>
        <fieldset disabled={locked}>
          <div className="bulk-field bulk-cover-field" data-mode={coverMode}>
            <div className="bulk-field-heading"><div><span className="bulk-field-label">封面</span><p>{covers ? `${covers} / ${tracks.length} 首有封面` : '无封面'}</p></div>
              <select aria-label="封面修改方式" value={coverMode} onChange={event => { setCoverMode(event.target.value as BulkMode); setError(''); }}><option value="keep">保持原封面</option><option value="set">更换封面</option><option value="clear">移除封面</option></select>
            </div>
            {coverMode === 'set' && <div className="bulk-cover-editor"><Artwork url={coverPreview} /><div><button type="button" className="button secondary" onClick={() => coverInput.current?.click()}><ImagePlus size={15} />{cover ? '更换图片' : '选择图片'}</button>{cover && <p className="bulk-cover-filename">{cover.name}</p>}<p className="bulk-cover-note">{cover ? `将替换所选 ${tracks.length} 首曲目的封面` : 'PNG / JPEG / GIF / WebP'}</p></div></div>}
            <input hidden type="file" ref={coverInput} aria-label="选择批量封面图片" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (!file || locked) return;
              if (!file.size) { setError('请选择有效封面图片'); return; }
              setCover(file); setError('');
            }} />
            {coverMode === 'clear' && <p className="bulk-clear-note">所选曲目的封面将被移除</p>}
          </div>
          {bulkFields.map(([key, label]) => <div className="bulk-field" data-mode={modes[key]} key={key}>
            <div className="bulk-field-heading"><div><label htmlFor={`bulk-${key}`}>{label}</label><p title={[...new Set(tracks.map(track => String(track[key] || '未填写')))].join('、')}>{currentValue(key)}</p></div>
              <select aria-label={`${label}修改方式`} value={modes[key]} onChange={event => { setModes(old => ({ ...old, [key]: event.target.value as BulkMode })); setError(''); }}><option value="keep">保持原值</option><option value="set">修改为</option><option value="clear">{key === 'artist' || key === 'album' || key === 'albumArtist' ? '重置' : '清空'}</option></select>
            </div>
            {modes[key] === 'set' && <input id={`bulk-${key}`} aria-label={`批量编辑${label}`} type={key === 'year' ? 'number' : 'text'} min={key === 'year' ? 1 : undefined} max={key === 'year' ? 9999 : undefined} maxLength={4096} step={key === 'year' ? 1 : undefined} required value={values[key]} placeholder={`输入新的${label}`} onChange={event => setValues(old => ({ ...old, [key]: event.target.value }))} />}
            {modes[key] === 'clear' && <p className="bulk-clear-note">{key === 'artist' ? '艺术家将设为「未知歌手」' : key === 'album' ? '专辑将设为「未归属专辑」' : key === 'albumArtist' ? '专辑艺术家将使用各曲目的艺术家' : `${label}将从所选曲目中移除`}</p>}
          </div>)}
          <div className="bulk-field bulk-tag-field" data-mode={tagMode}>
            <div className="bulk-field-heading"><div><label htmlFor="bulk-tags">标签</label><p title={currentTags.join('、')}>{currentTags.length ? currentTags.join('、') : '无标签'}</p></div>
              <select aria-label="批量标签操作" value={tagMode} onChange={event => { setTagMode(event.target.value as typeof tagMode); setError(''); }}><option value="keep">保持原值</option><option value="append">追加标签</option><option value="replace">替换全部</option><option value="clear">清空标签</option></select>
            </div>
            {(tagMode === 'append' || tagMode === 'replace') && <><input id="bulk-tags" aria-label="批量编辑标签" required value={tagsText} placeholder="输入标签，用逗号分隔" onChange={event => setTagsText(event.target.value)} /><p className="bulk-tag-note">{tagMode === 'append' ? '保留每首曲目的原有标签' : '所选曲目仅保留这些标签'}</p>{tags.length > 0 && <div className="bulk-tag-preview" aria-label="待保存标签">{tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</>}
            {tagMode === 'clear' && <p className="bulk-clear-note">所选曲目的全部标签将被移除</p>}
          </div>
        </fieldset>
      </div>
    </div>
    <footer className="modal-footer bulk-editor-footer">
      {error && <div className="bulk-save-error" role="alert"><CircleAlert size={17} /><div><p>{error}</p>{progress > 0 && <span>已保存的修改保留，继续保存其余曲目</span>}</div></div>}
      <div className="bulk-save-summary" role="status">{busy || progress > 0 ? <><span>{busy ? '正在保存' : '已保存'} <strong>{progress} / {tracks.length}</strong> 首</span><div className="upload-meter" role="progressbar" aria-label="批量保存进度" aria-valuemin={0} aria-valuemax={tracks.length} aria-valuenow={progress}><i style={{ width: `${progress / tracks.length * 100}%` }} /></div></> : <span>{changed ? <><strong>{changed} 项修改</strong> · {tracks.length} 首曲目</> : '选择需要修改的字段'}</span>}</div>
      <div className="bulk-footer-actions"><button className="button secondary" type="button" disabled={busy} onClick={close}>{progress > 0 ? '关闭' : '取消'}</button><button className="button primary" type="submit" disabled={busy || !changed || !tracks.length || (coverMode === 'set' && !cover)}>{busy ? '保存中…' : progress > 0 ? '继续保存' : '保存并写回'}</button></div>
    </footer>
  </form></Modal>;
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
