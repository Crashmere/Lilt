import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react';
import { Download, Heart, LoaderCircle, Maximize, Music2, Pause, Pencil, PictureInPicture2, Play, RotateCcw, SkipBack, SkipForward, Trash2, Video, Volume2, VolumeX } from 'lucide-react';
import { API, json, messageOf, request } from './api';
import { Artwork, Empty, Modal } from './components';
import type { MV, Track } from './types';
import { bytes, duration, identity, readLocal, writeLocal } from './utils';
import './mvs.css';

type Lease = { tabId: string; updatedAt: number; playing: boolean };
type Playback = { status: 'missing' | 'processing' | 'ready' | 'error'; url?: string; error?: string };
type AudioExtraction = { status: Playback['status']; track?: Track; duplicate?: boolean; error?: string };
type VideoElement = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
const url = (mv: MV, suffix: string) => `${API}/mvs/${encodeURIComponent(mv.id)}/${suffix}`;

export function MVLibrary({ mvs, query, onPlay, onEdit, onExtract, onFavorite, onTrash, onUpload }: {
  mvs: MV[]; query: string; onPlay: (mv: MV) => void; onEdit: (mv: MV) => void;
  onExtract: (mv: MV) => void;
  onFavorite: (mv: MV) => void; onTrash: (mv: MV) => void; onUpload: () => void;
}) {
  const [favorites, setFavorites] = useState(false);
  const visible = mvs.filter(mv => (!favorites || mv.favorite) && `${mv.title} ${mv.artist} ${mv.originalName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <><div className="library-tools"><button className={`button secondary ${favorites ? 'accent' : ''}`} onClick={() => setFavorites(old => !old)}><Heart size={16} fill={favorites ? 'currentColor' : 'none'} />{favorites ? '仅收藏' : '全部 MV'}</button><span className="muted">{visible.length} 个 · {bytes(visible.reduce((sum, mv) => sum + mv.size, 0))}</span></div>
    {visible.length ? <div className="mv-grid">{visible.map(mv => <article className="mv-card" key={mv.id}>
      <button className="mv-poster" onClick={() => onPlay(mv)} aria-label={`播放 MV ${mv.title}`}><Artwork url={mv.coverUrl} title={mv.title} /><span className="mv-card-play"><Play size={25} fill="currentColor" /></span><small>{duration(mv.duration)}</small></button>
      <div className="mv-card-title"><button onClick={() => onPlay(mv)} title={mv.title}>{mv.title}</button><button className={`icon-button ${mv.favorite ? 'accent' : ''}`} aria-label={mv.favorite ? '取消收藏 MV' : '收藏 MV'} onClick={() => onFavorite(mv)}><Heart size={16} fill={mv.favorite ? 'currentColor' : 'none'} /></button></div>
      <p>{mv.artist || '未知艺术家'}</p><footer><button className="text-button" disabled={!mv.audioCodec} title={mv.audioCodec ? '提取完整音频并创建新歌' : '此 MV 没有音轨'} onClick={() => onExtract(mv)}><Music2 size={15} />提取音频</button><div><button className="icon-button" aria-label={`编辑 MV ${mv.title}`} onClick={() => onEdit(mv)}><Pencil size={15} /></button><a className="icon-button" aria-label={`下载 MV ${mv.title}`} href={url(mv, 'download')}><Download size={15} /></a><button className="icon-button" aria-label={`移除 MV ${mv.title}`} onClick={() => onTrash(mv)}><Trash2 size={15} /></button></div></footer>
    </article>)}</div> : <Empty title={query || favorites ? '没有匹配的 MV' : '还没有 MV'}>{!query && !favorites && <button className="button primary" onClick={onUpload}><Video size={16} />上传 MV</button>}</Empty>}
  </>;
}

export function MVAudioExtractor({ mv, visible, onClose, onCreated, onProcessing, onEdit }: { mv: MV; visible: boolean; onClose: () => void; onCreated: () => void; onProcessing: (processing: boolean) => void; onEdit: (track: Track) => void }) {
  const [job, setJob] = useState<AudioExtraction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const delivered = useRef(false);
  const mounted = useRef(true);
  const path = `/mvs/${encodeURIComponent(mv.id)}/audio`;
  const receive = useEffectEvent((result: AudioExtraction) => {
    setJob(result); setError(result.error || '');
    if (result.status === 'ready' && !delivered.current) { delivered.current = true; onCreated(); }
  });
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const result = await request<AudioExtraction>(path, { signal: abort.signal });
        if (abort.signal.aborted) return;
        receive(result);
        if (result.status === 'processing') timer = setTimeout(() => { void read(); }, 1000);
      } catch (error) { if (!abort.signal.aborted) setError(messageOf(error)); }
    }
    void read();
    return () => { mounted.current = false; abort.abort(); clearTimeout(timer); };
  }, [path, retry]);
  async function start() {
    if (busy || job?.status === 'processing') return;
    setBusy(true); setError('');
    try {
      const result = await request<AudioExtraction>(path, { method: 'POST' });
      if (!mounted.current) return;
      setJob(result); setRetry(old => old + 1);
    } catch (error) { if (mounted.current) setError(messageOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const processing = busy || job?.status === 'processing';
  const reportProcessing = useEffectEvent(onProcessing);
  useEffect(() => { reportProcessing(processing); }, [processing]);
  const track = job?.track;
  if (!visible) return null;
  return <Modal title="提取音频" className="mv-audio-extractor" onClose={onClose}><div className="modal-body">
    <div className="mv-audio-source"><Artwork url={mv.coverUrl} title={mv.title} /><div><strong>{mv.title}</strong><p className="muted">{mv.artist || '未知艺术家'}</p><p className="muted">MV 时长 · {duration(mv.duration)}</p></div></div>
    {processing && <p className="mv-audio-status" role="status"><LoaderCircle size={17} className="spin" />正在提取完整音频并创建歌曲…</p>}
    {track && <p role="status">{track.deletedAt ? '歌曲已在回收站，请先恢复。' : job.duplicate ? `歌曲已存在：${track.title}` : `已创建歌曲：${track.title}`}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>{track ? '完成' : '关闭'}</button>
    {track ? !track.deletedAt && <button className="button primary" onClick={() => onEdit(track)}><Pencil size={15} />编辑歌曲</button> : error && job?.status !== 'error' ? <button className="button primary" disabled={busy} onClick={() => { setError(''); setRetry(old => old + 1); }}>查询状态</button> : <button className="button primary" disabled={!job || processing || !mv.audioCodec} onClick={() => { void start(); }}><Music2 size={16} />{processing ? '提取中…' : job?.status === 'error' ? '重试提取' : '提取并创建新歌'}</button>}
  </footer></Modal>;
}

export function MVEditor({ mv, onClose, onSaved }: { mv: MV; onClose: () => void; onSaved: (mv: MV) => void }) {
  const [title, setTitle] = useState(mv.title);
  const [artist, setArtist] = useState(mv.artist);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function close() { if (!busy && (title === mv.title && artist === mv.artist || window.confirm('放弃未保存的修改？'))) onClose(); }
  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await json<{ mv: MV }>(`/mvs/${encodeURIComponent(mv.id)}`, 'PATCH', { title, artist, expectedUpdatedAt: mv.updatedAt }); onSaved(result.mv); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <Modal title="编辑 MV" onClose={close}><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-body"><label className="field">名称<input value={title} disabled={busy} required onChange={event => setTitle(event.target.value)} /></label><label className="field">艺术家<input value={artist} disabled={busy} onChange={event => setArtist(event.target.value)} /></label>{error && <p className="error-text" role="alert">{error}</p>}</div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></footer></form></Modal>;
}

export function MVPlayer({ mv, onClose, onExtract }: { mv: MV; onClose: () => void; onExtract: (mv: MV) => void }) {
  const videoRef = useRef<VideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'original' | 'compatible'>('original');
  const [sourceURL, setSourceURL] = useState('');
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(mv.duration);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState(0);
  const [volume, setVolume] = useState(() => readLocal('lilt.mv-volume', 0.8));
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [hovered, setHovered] = useState(false);
  const storageKey = `lilt.mv-position.${mv.fingerprint}`;
  const targetTime = useRef(readLocal(storageKey, 0));
  const intent = useRef(false);
  const changing = useRef(true);
  const owner = useRef(identity());
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  function savePosition() { if (videoRef.current?.readyState) writeLocal(storageKey, videoRef.current.currentTime); }
  function release() {
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.tabId === owner.current) writeLocal('lilt.playback-lease', { ...lease, playing: false, updatedAt: Date.now() });
  }
  function pause() { intent.current = false; videoRef.current?.pause(); setPlaying(false); setWaiting(false); savePosition(); release(); }
  function claim(takeover = false) {
    window.dispatchEvent(new Event('lilt-video-claim'));
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (!takeover && lease?.playing && lease.tabId !== owner.current && Date.now() - lease.updatedAt < 9000) { setConflict(true); return false; }
    writeLocal('lilt.playback-lease', { tabId: owner.current, playing: true, updatedAt: Date.now() });
    setConflict(false); return true;
  }
  function fail(message: string) { pause(); setError(message); }
  function switchMode(next: typeof mode) {
    targetTime.current = videoRef.current?.currentTime || targetTime.current;
    changing.current = true; videoRef.current?.pause(); setPlaying(false); setWaiting(true); setError(''); setMode(next);
  }
  async function play(takeover = false) {
    if (!claim(takeover)) return;
    intent.current = true; setError('');
    const video = videoRef.current;
    if (!video || changing.current) return;
    if (video.error) { targetTime.current = video.currentTime || targetTime.current; setRetry(old => old + 1); return; }
    if (video.ended) video.currentTime = 0;
    try { await video.play(); }
    catch (error) {
      if (!mounted.current || !intent.current || error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof DOMException && error.name === 'NotSupportedError' && mode === 'original') switchMode('compatible');
      else fail(error instanceof DOMException && error.name === 'NotAllowedError' ? '点击播放以继续。' : '播放失败，请重试或下载原件。');
    }
  }
  function seek(value: number) {
    const time = Math.max(0, Math.min(total, value));
    targetTime.current = time; setPosition(time);
    if (videoRef.current?.readyState) videoRef.current.currentTime = time;
    writeLocal(storageKey, time);
  }
  function activity() {
    setHidden(false); clearTimeout(controlsTimer.current);
    if (playing && !waiting && !hovered) controlsTimer.current = setTimeout(() => setHidden(true), 2600);
  }
  useEffect(() => { activity(); return () => clearTimeout(controlsTimer.current); }, [playing, waiting, hovered]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume)); video.muted = muted; video.playbackRate = rate;
    writeLocal('lilt.mv-volume', volume);
  }, [volume, muted, rate]);

  useEffect(() => {
    const abort = new AbortController();
    const video = videoRef.current!;
    changing.current = true; video.pause(); setSourceURL(''); setError(''); setPlaying(false);
    if (mode === 'original' && (!video.canPlayType(mv.mimeType) || mv.audioCodec && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(mv.audioCodec))) { setMode('compatible'); return () => abort.abort(); }
    async function prepare() {
      let source = url(mv, `stream?quality=original&v=${mv.fingerprint}`);
      if (mode === 'compatible') {
        setWaiting(true);
        let status = await request<Playback>(`/mvs/${encodeURIComponent(mv.id)}/playback`, { method: 'POST', signal: abort.signal });
        while (status.status === 'processing') {
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 1000); abort.signal.addEventListener('abort', done, { once: true });
          });
          abort.signal.throwIfAborted();
          status = await request<Playback>(`/mvs/${encodeURIComponent(mv.id)}/playback`, { signal: abort.signal });
        }
        if (status.status !== 'ready' || !status.url) throw new Error(status.error || '兼容播放未就绪，请重试。');
        source = status.url;
      }
      abort.signal.throwIfAborted();
      setSourceURL(source); video.src = source; video.load();
    }
    void prepare().catch(error => { if (!abort.signal.aborted) { changing.current = false; fail(messageOf(error)); } });
    return () => { abort.abort(); };
  }, [mv.id, mv.fingerprint, mode, retry]);

  const onClaim = useEffectEvent(() => pause());
  const onStorage = useEffectEvent((event: StorageEvent) => {
    if (event.key !== 'lilt.playback-lease' || !intent.current) return;
    const lease = readLocal<Lease | null>('lilt.playback-lease', null);
    if (lease?.playing && lease.tabId !== owner.current) pause();
  });
  const heartbeat = useEffectEvent(() => {
    if (intent.current) {
      const lease = readLocal<Lease | null>('lilt.playback-lease', null);
      if (lease?.tabId === owner.current) writeLocal('lilt.playback-lease', { ...lease, updatedAt: Date.now() });
      else if (lease?.playing) pause();
    }
    savePosition();
  });
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,a,[contenteditable="true"]')) return;
    if (event.key === 'Escape') { if (!document.fullscreenElement) onClose(); return; }
    if (event.key === ' ') { event.preventDefault(); if (!event.repeat) { if (intent.current) pause(); else void play(); } }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek((videoRef.current?.currentTime || position) + (event.key === 'ArrowLeft' ? -5 : 5)); }
  });
  useEffect(() => {
    mounted.current = true;
    const video = videoRef.current;
    const timer = setInterval(heartbeat, 2000);
    window.addEventListener('lilt-audio-claim', onClaim); window.addEventListener('storage', onStorage); window.addEventListener('pagehide', onClaim); document.addEventListener('keydown', onKey);
    return () => {
      mounted.current = false; clearInterval(timer); clearTimeout(controlsTimer.current); savePosition(); intent.current = false; release();
      window.removeEventListener('lilt-audio-claim', onClaim); window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', onClaim); document.removeEventListener('keydown', onKey);
      video?.pause(); video?.removeAttribute('src'); video?.load();
      if (video && document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
    };
  }, []);

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageRef.current?.requestFullscreen) await stageRef.current.requestFullscreen();
      else videoRef.current?.webkitEnterFullscreen?.();
    } catch { setError('此浏览器无法进入全屏。'); }
  }
  async function pip() {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await videoRef.current?.requestPictureInPicture(); }
    catch { setError('画中画暂不可用，请开始播放后重试。'); }
  }
  return <Modal title={mv.title} wide isolate className="mv-player" onClose={onClose}><div className={`mv-stage ${hidden && playing ? 'controls-hidden' : ''}`} ref={stageRef} onPointerMove={activity} onPointerDown={activity}>
    <video ref={videoRef} playsInline preload="metadata" poster={mv.coverUrl} aria-label={mv.title}
      onClick={() => { activity(); if (intent.current) pause(); else void play(); }}
      onLoadedMetadata={() => { const video = videoRef.current!; setTotal(Number.isFinite(video.duration) ? video.duration : mv.duration); const at = targetTime.current >= video.duration - 1 ? 0 : Math.max(0, targetTime.current); video.currentTime = at; setPosition(at); video.playbackRate = rate; changing.current = false; setWaiting(false); if (intent.current) void play(); }}
      onPlay={() => { if (!intent.current) videoRef.current?.pause(); else { setPlaying(true); setWaiting(false); } }}
      onPause={() => { setPlaying(false); if (!changing.current) { intent.current = false; savePosition(); release(); } }}
      onTimeUpdate={() => { const video = videoRef.current!; setPosition(video.currentTime); if (mode === 'original' && video.currentTime > 0.2 && !video.videoWidth) switchMode('compatible'); }}
      onWaiting={() => { if (intent.current) setWaiting(true); }} onPlaying={() => setWaiting(false)} onSeeked={() => setWaiting(false)}
      onEnded={() => { pause(); targetTime.current = 0; writeLocal(storageKey, 0); }}
      onError={() => { if (mode === 'original') switchMode('compatible'); else fail('视频加载失败，请重试或下载原件。'); }} />
    {(waiting || !playing && !error) && <button className="mv-center-play" aria-label={waiting ? '正在准备播放' : '播放 MV'} disabled={waiting && !sourceURL} onClick={() => { void play(); }}>{waiting ? <LoaderCircle size={35} className="spin" /> : <Play size={35} fill="currentColor" />}</button>}
    {waiting && !sourceURL && <span className="mv-preparing" role="status">正在准备兼容播放…</span>}
    {error && <div className="mv-player-error" role="alert"><p>{error}</p><button className="button secondary" onClick={() => { targetTime.current = videoRef.current?.currentTime || targetTime.current; setRetry(old => old + 1); }}>重试</button><a className="button secondary" href={url(mv, 'download')}>下载原件</a></div>}
    {conflict && <div className="mv-player-error" role="alert"><p>另一标签页正在播放</p><button className="button secondary" onClick={() => { void play(true); }}>在此继续播放</button></div>}
    <div className="mv-controls" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <input type="range" className="mv-seek" aria-label="MV 播放进度" min="0" max={total || 1} step="0.1" value={Math.min(total, position)} disabled={!sourceURL} style={{ '--progress': `${total ? position / total * 100 : 0}%` } as CSSProperties} onChange={event => seek(Number(event.target.value))} />
      <div className="mv-control-row"><button className="icon-button" aria-label={playing ? '暂停 MV' : '播放 MV'} onClick={() => { if (intent.current) pause(); else void play(); }}>{playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button className="icon-button mv-skip" aria-label="后退 10 秒" onClick={() => seek(position - 10)}><SkipBack size={18} /></button><button className="icon-button mv-skip" aria-label="前进 10 秒" onClick={() => seek(position + 10)}><SkipForward size={18} /></button><span className="mv-clock">{duration(position)} / {duration(total)}</span><div className="mv-control-spacer" />
        <select aria-label="MV 播放方式" value={mode} onChange={event => switchMode(event.target.value as typeof mode)}><option value="original">原件</option><option value="compatible">兼容</option></select><select aria-label="MV 播放倍速" value={rate} onChange={event => setRate(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select>
        <button className="icon-button" aria-label={muted ? '取消静音' : '静音 MV'} onClick={() => setMuted(old => !old)}>{muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}</button><input className="mv-volume" type="range" aria-label="MV 音量" min="0" max="1" step="0.01" value={volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} />
        {document.pictureInPictureEnabled && <button className="icon-button" aria-label="MV 画中画" disabled={!sourceURL} onClick={() => { void pip(); }}><PictureInPicture2 size={19} /></button>}<button className="icon-button" aria-label="MV 全屏" onClick={() => { void fullscreen(); }}><Maximize size={19} /></button>
      </div>
    </div>
  </div><footer className="mv-player-footer"><span>{mv.artist || '未知艺术家'}</span><span>{mv.width} × {mv.height} · {bytes(mv.size)}</span><button className="text-button" onClick={() => seek(0)}><RotateCcw size={14} />从头播放</button><button className="text-button" disabled={!mv.audioCodec} onClick={() => onExtract(mv)}><Music2 size={15} />提取音频</button><a className="text-button" href={url(mv, 'download')}><Download size={15} />下载原件</a></footer></Modal>;
}
