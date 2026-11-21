import { useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Disc3, GripVertical, Heart, MoreHorizontal, Music2, Play, Plus, Settings2, X } from 'lucide-react';
import type { Player } from './player';
import type { PlaylistMemberships } from './playlist-memberships';
import type { Album, Playlist, Track } from './types';
import { duration } from './utils';

export function Artwork({ url, title, className = '' }: { url?: string; title?: string; className?: string }) {
  const [failed, setFailed] = useState('');
  return <div className={`artwork ${className}`}>
    {url && failed !== url ? <img src={url} alt={title || ''} loading="lazy" onError={() => setFailed(url)} /> : <div className="artwork-empty"><Disc3 strokeWidth={1} /></div>}
  </div>;
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={21} /></button></header>
      {children}
    </section>
  </div>;
}

export function Empty({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Music2 size={32} strokeWidth={1.25} /></div><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>;
}

export function AlbumCards({ albums, onOpen, onPlay }: { albums: Album[]; onOpen: (album: Album) => void; onPlay: (ids: string[]) => void }) {
  return <div className="album-grid">{albums.map(album => <article className="album-card" key={album.id}>
    <div className="album-art"><button className="art-open" onClick={() => onOpen(album)} aria-label={`查看专辑 ${album.title}`}><Artwork url={album.coverUrl} title={album.title} /></button><button className="art-play" onClick={() => onPlay(album.trackIds)} aria-label={`播放专辑 ${album.title}`}><Play size={21} fill="currentColor" /></button></div>
    <button className="album-title" onClick={() => onOpen(album)}>{album.title || '未命名专辑'}</button><p>{album.artist || '未知艺术家'}</p><span>{album.year ? `${album.year} · ` : ''}{album.trackCount} 首</span>
  </article>)}</div>;
}

export function PlaylistCards({ playlists, onOpen, onCreate }: { playlists: Playlist[]; onOpen: (playlist: Playlist) => void; onCreate: () => void }) {
  return <div className="playlist-grid">{playlists.map(playlist => <button key={playlist.id} className="playlist-card" onClick={() => onOpen(playlist)}><Artwork url={playlist.coverUrl} title={playlist.name} /><div><span className="eyebrow">{playlist.kind === 'smart' ? '智能歌单' : '歌单'}</span><h3>{playlist.name}</h3><p>{playlist.trackIds.length} 首{playlist.description ? ` · ${playlist.description}` : ''}</p></div></button>)}<button className="playlist-create" onClick={onCreate}><Plus size={25} /><span>新建歌单</span></button></div>;
}

export function TrackPlaylists({ playlists = [], onOpen }: { playlists?: Playlist[]; onOpen: () => void }) {
  if (!playlists.length) return <span className="playlist-empty" aria-label="未加入歌单">未加入</span>;
  const names = playlists.map(playlist => `${playlist.name}${playlist.kind === 'smart' ? '（智能歌单）' : ''}`).join('、');
  return <button className="playlist-memberships" title={names} aria-label={`查看所属歌单：${names}`} aria-haspopup="dialog" onClick={onOpen}>
    <span className="playlist-chips">{playlists.slice(0, 2).map(playlist => <span className={`playlist-chip ${playlist.kind === 'smart' ? 'smart' : ''}`} key={playlist.id}>{playlist.kind === 'smart' && <Settings2 size={11} aria-hidden="true" />}<span>{playlist.name}</span></span>)}</span>
    {playlists.length > 2 && <span className="playlist-overflow">+{playlists.length - 2}</span>}
  </button>;
}

type TrackTableProps = {
  tracks: Track[]; player: Player; favorite: (track: Track) => void; actions: (track: Track) => void;
  playlistMemberships: PlaylistMemberships; showPlaylists: (track: Track) => void;
  addToPlaylist: (ids: string[]) => void;
  bulkEdit: (tracks: Track[]) => void;
  compact?: boolean; albumTracks?: boolean; onReorder?: (from: number, to: number) => void; empty?: string;
};
export function TrackTable({ tracks, player, favorite, actions, playlistMemberships, showPlaylists, addToPlaylist, bulkEdit, compact = false, albumTracks = false, onReorder, empty = '没有曲目' }: TrackTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const dragged = useRef(-1);
  const ids = tracks.map(track => track.id);
  const selectedTracks = tracks.filter(track => selected.has(track.id));
  function select(id: string) { setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  if (!tracks.length) return <Empty title={empty} />;
  return <div className={`track-list ${compact ? 'compact' : ''} ${albumTracks ? 'album-tracks' : ''} ${selecting ? 'selecting' : ''}`}>
    <div className="mobile-selection-control"><button className="text-button" onClick={() => { setSelecting(old => !old); if (selecting) setSelected(new Set()); }}>{selecting ? '完成' : '选择'}</button></div>
    {selectedTracks.length > 0 && <div className="selection-bar"><span>{selectedTracks.length} 首已选</span><button onClick={() => bulkEdit(selectedTracks)}>批量编辑</button><button onClick={() => player.enqueue(selectedTracks.map(track => track.id))}>加入队列</button><button onClick={() => addToPlaylist(selectedTracks.map(track => track.id))}>加入歌单</button><button className="icon-button" aria-label="取消选择" onClick={() => setSelected(new Set())}><X size={16} /></button></div>}
    <div className="track-heading"><label className="check-cell"><input type="checkbox" checked={selectedTracks.length === tracks.length} aria-label="选择全部曲目" onChange={event => setSelected(event.target.checked ? new Set(ids) : new Set())} /></label><span className="number-cell">#</span><span>曲目</span>{!albumTracks && <span className="album-cell">专辑</span>}<span className="playlist-cell">歌单</span><span className="time-cell">时长</span><span className="track-actions" /></div>
    {tracks.map((track, index) => <div key={`${track.id}-${index}`} className={`track-row ${player.trackId === track.id ? 'current' : ''} ${selected.has(track.id) ? 'selected' : ''}`} draggable={!!onReorder} onDragStart={() => { dragged.current = index; }} onDragOver={event => { if (onReorder) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (onReorder && dragged.current >= 0 && dragged.current !== index) onReorder(dragged.current, index); dragged.current = -1; }}>
      <label className="check-cell"><input type="checkbox" checked={selected.has(track.id)} aria-label={`选择 ${track.title}`} onChange={() => select(track.id)} /></label>
      <button className="number-cell row-play" onClick={() => player.begin(ids, index)} aria-label={`播放 ${track.title}`}>{player.trackId === track.id && player.playing ? <span className="playing-bars"><i /><i /><i /></span> : <><span>{onReorder ? <GripVertical size={16} /> : albumTracks ? track.trackNumber || index + 1 : index + 1}</span><Play size={15} fill="currentColor" /></>}</button>
      <div className="track-name">{!albumTracks && <Artwork url={track.coverUrl} />}<div><button onClick={() => player.begin(ids, index)}>{track.title || track.originalName}</button><p>{track.artist || '未知艺术家'}{track.version && <span className="version">{track.version}</span>}</p></div></div>
      {!albumTracks && <div className="album-cell"><span>{track.album || '未归入专辑'}</span>{track.tags?.length > 0 && <small>{track.tags.slice(0, 2).join(' · ')}</small>}</div>}
      <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={playlistMemberships.get(track.id)} onOpen={() => showPlaylists(track)} /></div>
      <span className="time-cell">{duration(track.duration)}</span>
      <div className="track-actions">{onReorder && <><button className="icon-button reorder-button" aria-label={`上移 ${track.title}`} disabled={index === 0} onClick={() => onReorder(index, index - 1)}><ArrowUp size={14} /></button><button className="icon-button reorder-button" aria-label={`下移 ${track.title}`} disabled={index === tracks.length - 1} onClick={() => onReorder(index, index + 1)}><ArrowDown size={14} /></button></>}<button className={`icon-button ${track.favorite ? 'accent' : ''}`} aria-label={track.favorite ? `取消收藏 ${track.title}` : `收藏 ${track.title}`} onClick={() => favorite(track)}><Heart size={17} fill={track.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" aria-label={`${track.title} 更多操作`} onClick={() => actions(track)}><MoreHorizontal size={19} /></button></div>
    </div>)}
  </div>;
}

export function Pill({ children, active = false, onClick }: { children: ReactNode; active?: boolean; onClick: () => void }) { return <button className={`pill ${active ? 'active' : ''}`} onClick={onClick}>{active && <Check size={13} />}{children}</button>; }
