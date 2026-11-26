import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, Check, Disc3, GripVertical, Heart, ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Pencil, Play, Plus, Settings2, Trash2, X } from 'lucide-react';
import type { Player } from './player';
import type { PlaylistMemberships } from './playlist-memberships';
import { PLAYLIST_KINDS, PLAYLIST_LABELS } from './playlist-kinds';
import type { FilterColumn } from './library-filters';
import type { Album, Playlist, Track } from './types';
import { AlbumLink, hasTrackCredits, TrackCredits, type CollectionNavigation } from './track-links';
import { duration } from './utils';
import { useReorder, type Reorder } from './reorder';

export function Artwork({ url, title, className = '', size = 160 }: { url?: string; title?: string; className?: string; size?: 160 | 480 }) {
  const [failed, setFailed] = useState('');
  const thumbnail = url?.startsWith('/lilt/api/tracks/') ? `${url}${url.includes('?') ? '&' : '?'}size=${size}` : url;
  return <div className={`artwork ${className}`}>
    {thumbnail && failed !== thumbnail ? <img src={thumbnail} alt={title || ''} loading="lazy" decoding="async" fetchPriority="low" draggable={false} onError={() => setFailed(thumbnail)} /> : <div className="artwork-empty"><Disc3 strokeWidth={1} /></div>}
  </div>;
}

export function Modal({ title, children, onClose, wide = false, className = '', isolate = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; isolate?: boolean }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (isolate) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const all = Array.from(document.querySelectorAll<HTMLElement>('.modal-backdrop'));
      let top: HTMLElement | undefined;
      let topZ = -Infinity;
      for (const element of all) {
        const z = Number(getComputedStyle(element).zIndex) || 0;
        if (z >= topZ) { top = element; topZ = z; }
      }
      if (top !== backdropRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [isolate]);
  useLayoutEffect(() => {
    if (!isolate) return;
    const root = document.getElementById('root');
    if (!root) return;
    const inert = root.inert;
    root.inert = true;
    return () => { root.inert = inert; };
  }, [isolate]);
  // Portal events still bubble through the underlying React page.
  const stop = isolate ? (event: SyntheticEvent) => event.stopPropagation() : undefined;
  return createPortal(<div ref={backdropRef} className={`modal-backdrop${isolate ? ' modal-backdrop-isolated' : ''}`} onClick={stop} onWheel={stop} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onPointerCancel={stop} onMouseDown={event => { stop?.(event); if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? 'modal-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={21} /></button></header>
      {children}
    </section>
  </div>, document.body);
}

export function Empty({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Music2 size={32} strokeWidth={1.25} /></div><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>;
}

export function AlbumCards({ albums, onOpen, onPlay }: { albums: Album[]; onOpen: (album: Album) => void; onPlay: (ids: string[]) => void }) {
  return <div className="album-grid">{albums.map(album => <article className="album-card" key={album.id}>
    <div className="album-art"><button className="art-open" onClick={() => onOpen(album)} aria-label={`查看专辑 ${album.title}`}><Artwork url={album.coverUrl} title={album.title} size={480} /></button><button className="art-play" onClick={() => onPlay(album.trackIds)} aria-label={`播放专辑 ${album.title}`}><Play size={21} fill="currentColor" /></button></div>
    <button className="album-title" onClick={() => onOpen(album)}>{album.title || '未命名专辑'}</button><p>{album.artist || '未知艺术家'}</p><span>{album.year ? `${album.year} · ` : ''}{album.trackCount} 首</span>
  </article>)}</div>;
}

export function PlaylistCards({ playlists, onOpen, empty = '还没有歌单，请新建歌单' }: { playlists: Playlist[]; onOpen: (playlist: Playlist) => void; empty?: string }) {
  const groups = PLAYLIST_KINDS.map(kind => ({ kind, items: playlists.filter(playlist => playlist.kind === kind) })).filter(group => group.items.length > 0);
  if (!groups.length) return <Empty title={empty} />;
  return <div className="playlist-groups">{groups.map(({ kind, items }) => <section className="playlist-section" key={kind} aria-labelledby={`playlist-kind-${kind}`}>
    <div className="section-heading"><h2 id={`playlist-kind-${kind}`}>{PLAYLIST_LABELS[kind]}</h2><span className="muted">{items.length} 个歌单</span></div>
    <div className="playlist-grid">{items.map(playlist => <button key={playlist.id} className="playlist-card" onClick={() => onOpen(playlist)}><Artwork url={playlist.coverUrl} title={playlist.name} /><div className="playlist-card-meta"><h3>{playlist.name}</h3><span className="playlist-card-count">{playlist.trackIds.length} 首</span>{playlist.description && <p className="playlist-card-desc">{playlist.description}</p>}</div></button>)}</div>
  </section>)}</div>;
}

export function TrackPlaylists({ playlists = [], onOpen }: { playlists?: Playlist[]; onOpen: () => void }) {
  if (!playlists.length) return null;
  const names = playlists.map(playlist => `${playlist.name}${playlist.kind !== 'manual' ? `（${PLAYLIST_LABELS[playlist.kind]}）` : ''}`).join('、');
  return <button className="playlist-memberships" title={names} aria-label={`查看所属歌单：${names}`} aria-haspopup="dialog" onClick={onOpen}>
    <span className="playlist-chips">{playlists.slice(0, 2).map(playlist => <span className={`playlist-chip ${playlist.kind === 'smart' ? 'smart' : ''}`} key={playlist.id}>{playlist.kind === 'smart' && <Settings2 size={11} aria-hidden="true" />}<span>{playlist.name}</span></span>)}</span>
    {playlists.length > 2 && <span className="playlist-overflow">+{playlists.length - 2}</span>}
  </button>;
}

export type BulkTrackAction = 'favorite' | 'unfavorite' | 'instrumental' | 'trash';

type TrackTableProps = {
  tracks: Track[]; player: Player; favorite: (track: Track) => void; edit: (track: Track) => void; actions: (track: Track) => void;
  playlistMemberships: PlaylistMemberships; showPlaylists: (track: Track) => void;
  addToPlaylist: (ids: string[]) => void;
  bulkEdit: (tracks: Track[]) => void;
  sync: (tracks: readonly [Track, Track]) => void;
  selectionAction: (tracks: Track[], action: BulkTrackAction) => Promise<void>;
  removeFromPlaylist?: (ids: string[]) => Promise<void>;
  collectionNavigation: CollectionNavigation;
  filterColumns?: FilterColumn[];
  compact?: boolean; albumTracks?: boolean; onReorder?: Reorder; empty?: string;
  hideArtist?: string; hideAlbum?: boolean; excludePlaylistId?: string;
};
export function TrackTable({ tracks, player, favorite, edit, actions, playlistMemberships, showPlaylists, addToPlaylist, bulkEdit, sync, selectionAction, removeFromPlaylist, collectionNavigation, filterColumns = [], compact = false, albumTracks = false, onReorder, empty = '没有曲目', hideArtist, hideAlbum, excludePlaylistId }: TrackTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const reorder = useReorder(tracks, onReorder);
  const ids = tracks.map(track => track.id);
  const selectedTracks = tracks.filter(track => selected.has(track.id));
  const selectedIds = selectedTracks.map(track => track.id);
  function replaceSelection(next: Set<string>) {
    setSelected(next);
    setSelectionAnchor(null);
  }
  function select(id: string, shiftKey: boolean) {
    const anchorIndex = selectionAnchor === null ? -1 : ids.indexOf(selectionAnchor);
    const index = ids.indexOf(id);
    setSelected(old => {
      const next = new Set(old);
      if (shiftKey && anchorIndex >= 0) {
        ids.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1).forEach(trackId => next.add(trackId));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectionAnchor(id);
  }
  async function applySelection(action: BulkTrackAction | 'remove') {
    if (selectionBusy) return;
    if (action === 'trash' && !window.confirm(`将所选 ${selectedTracks.length} 首曲目移入回收站？可在回收站恢复。`)) return;
    if (action === 'remove' && !window.confirm(`从此歌单移除所选 ${selectedTracks.length} 首曲目？音乐库中的曲目不会删除。`)) return;
    setSelectionMenu(false);
    setSelectionBusy(true);
    try {
      if (action === 'remove') await removeFromPlaylist?.(selectedIds);
      else await selectionAction(selectedTracks, action);
    } finally { setSelectionBusy(false); }
  }
  if (!tracks.length) return <Empty title={empty} />;
  const rows = <>
    <div className="track-heading"><label className="check-cell"><input type="checkbox" checked={selectedTracks.length === tracks.length} disabled={selectionBusy} aria-label="选择全部曲目" onChange={event => replaceSelection(event.target.checked ? new Set(ids) : new Set())} /></label><span className="number-cell">#</span><span>曲目</span>{!albumTracks && <span className="album-cell">专辑</span>}<span className="playlist-cell">歌单</span>{filterColumns.map(column => <span className="filter-column-heading" key={column.key}>{column.label}</span>)}<span className="time-cell">时长</span><span className="track-actions" /></div>
    {tracks.map((track, index) => {
      const current = player.trackId === track.id;
      const pausable = current && player.playRequested;
      return <div key={track.id} {...reorder.rowProps(index)} className={`track-row ${current ? 'current' : ''} ${selected.has(track.id) ? 'selected' : ''} ${reorder.rowProps(index).className}`}>
      <label className="check-cell" onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}><input type="checkbox" checked={selected.has(track.id)} disabled={selectionBusy} aria-label={`选择 ${track.title}`} onChange={event => select(track.id, (event.nativeEvent as MouseEvent).shiftKey)} /></label>
      {onReorder ? <span className="number-cell reorder-grip" {...reorder.handleProps(index)}>{reorder.saving === index ? <LoaderCircle size={15} className="spin" /> : <GripVertical size={16} />}</span> : <button className="number-cell row-play" onClick={() => {
        if (!current) player.begin(ids, index);
        else if (pausable) player.pause();
        else player.play();
      }} aria-label={`${pausable ? '暂停' : '播放'} ${track.title}`}>{pausable ? <><span className="playing-bars"><i /><i /><i /></span><Pause size={15} fill="currentColor" /></> : <><span>{albumTracks ? track.trackNumber || index + 1 : index + 1}</span><Play size={15} fill="currentColor" /></>}</button>}
      <div className="track-name">{!albumTracks && <Artwork url={track.coverUrl} />}<div><button onClick={() => player.begin(ids, index)}>{track.title || track.originalName}</button>{(hasTrackCredits(track, hideArtist, hideAlbum) || !!track.version) && <p><TrackCredits track={track} navigation={collectionNavigation} albumClassName={albumTracks ? undefined : 'inline-album'} hideArtist={hideArtist} hideAlbum={hideAlbum} />{track.version && <span className="version">{track.version}</span>}</p>}</div></div>
      {!albumTracks && <div className="album-cell"><span><AlbumLink track={track} navigation={collectionNavigation} /></span>{track.tags?.length > 0 && <small>{track.tags.slice(0, 2).join(' · ')}</small>}</div>}
      <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={excludePlaylistId ? (playlistMemberships.get(track.id) || []).filter(item => item.id !== excludePlaylistId) : playlistMemberships.get(track.id)} onOpen={() => showPlaylists(track)} /></div>
      {filterColumns.map(column => {
        const value = column.value(track, playlistMemberships.get(track.id)?.length || 0);
        return <span className="filter-column-value" key={column.key} data-filter={column.key} title={value}>{value}</span>;
      })}
      <span className="time-cell">{duration(track.duration)}</span>
      <div className="track-actions"><button className={`icon-button ${track.favorite ? 'accent' : ''}`} aria-label={track.favorite ? `取消收藏 ${track.title}` : `收藏 ${track.title}`} onClick={() => favorite(track)}><Heart size={17} fill={track.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" aria-label={`编辑 ${track.title}`} title="编辑曲目" aria-haspopup="dialog" onClick={() => edit(track)}><Pencil size={16} /></button><button className="icon-button" aria-label={`${track.title} 更多操作`} onClick={() => actions(track)}><MoreHorizontal size={19} /></button></div>
    </div>;
    })}
  </>;
  return <div ref={reorder.root} {...reorder.listProps} className={`track-list ${onReorder ? 'reorderable' : ''} ${compact ? 'compact' : ''} ${albumTracks ? 'album-tracks' : ''} ${selecting ? 'selecting' : ''} ${filterColumns.length ? 'filtering' : ''} ${reorder.listProps.className}`} style={filterColumns.length ? { '--filter-column-count': filterColumns.length } as CSSProperties : undefined}>
    <div className="mobile-selection-control"><button className="text-button" disabled={selectionBusy} onClick={() => { setSelecting(old => !old); if (selecting) replaceSelection(new Set()); }}>{selecting ? '完成' : '选择'}</button></div>
    {selectedTracks.length > 0 && <div className="selection-bar" role="toolbar" aria-label="所选曲目操作" aria-busy={selectionBusy}>
      <span className="selection-count" role="status">{selectionBusy && <LoaderCircle size={14} className="spin" />}{selectedTracks.length} 首已选{selectionBusy && ' · 处理中'}</span>
      <div className="selection-buttons">
        <button className="selection-play" disabled={selectionBusy} onClick={() => player.begin(selectedIds)}><Play size={14} fill="currentColor" />播放</button>
        <button disabled={selectionBusy} onClick={() => bulkEdit(selectedTracks)}><Pencil size={14} />批量编辑</button>
        <button disabled={selectionBusy || selectedTracks.length !== 2} title={selectedTracks.length === 2 ? '同步歌曲信息' : '请选择两首歌曲'} aria-haspopup="dialog" onClick={() => { if (selectedTracks.length === 2) sync([selectedTracks[0], selectedTracks[1]]); }}><ArrowRightLeft size={14} />同步信息</button>
        <button disabled={selectionBusy} onClick={() => addToPlaylist(selectedIds)}><Plus size={15} />加入歌单</button>
        <button disabled={selectionBusy} aria-haspopup="dialog" aria-expanded={selectionMenu} onClick={() => setSelectionMenu(true)}><MoreHorizontal size={17} />更多</button>
      </div>
      <button className="icon-button selection-cancel" disabled={selectionBusy} aria-label="取消选择" onClick={() => { replaceSelection(new Set()); setSelectionMenu(false); }}><X size={16} /></button>
    </div>}
    {selectionMenu && selectedTracks.length > 0 && <Modal title={`${selectedTracks.length} 首已选 · 更多操作`} onClose={() => setSelectionMenu(false)}><div className="modal-body track-action-menu">
      <button onClick={() => { player.enqueue(selectedIds, true); setSelectionMenu(false); }}><Play size={18} />接下来播放</button>
      <button onClick={() => { player.enqueue(selectedIds); setSelectionMenu(false); }}><ListMusic size={18} />加入播放队列</button>
      <button disabled={selectedTracks.every(track => track.favorite)} onClick={() => { void applySelection('favorite'); }}><Heart size={18} />收藏所选</button>
      <button disabled={selectedTracks.every(track => !track.favorite)} onClick={() => { void applySelection('unfavorite'); }}><Heart size={18} fill="currentColor" />取消收藏</button>
      <button disabled={selectedTracks.every(track => track.hasLyrics)} onClick={() => { void applySelection('instrumental'); }}><Music2 size={18} />设为纯音乐</button>
      <button disabled={selectedTracks.length === tracks.length} onClick={() => { replaceSelection(new Set(ids)); setSelectionMenu(false); }}><Check size={18} />全选当前列表</button>
      <button onClick={() => { replaceSelection(new Set(ids.filter(id => !selected.has(id)))); setSelectionMenu(false); }}><Check size={18} />反选当前列表</button>
      {removeFromPlaylist && <button onClick={() => { void applySelection('remove'); }}><X size={18} />从歌单移除</button>}
      <button className="danger" onClick={() => { void applySelection('trash'); }}><Trash2 size={18} />移入回收站</button>
    </div></Modal>}
    {filterColumns.length ? <div className="filter-table-scroll"><div className="filter-table-content">{rows}</div></div> : rows}
  </div>;
}

export function Pill({ children, active = false, onClick }: { children: ReactNode; active?: boolean; onClick: () => void }) { return <button className={`pill ${active ? 'active' : ''}`} onClick={onClick}>{active && <Check size={13} />}{children}</button>; }
