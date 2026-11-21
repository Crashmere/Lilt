import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BarChart3, Check, ChevronRight, Clock3, Disc3, Download, Heart, House, LibraryBig, ListMusic, LoaderCircle, Menu, MoreHorizontal, Music2, Play, Plus, RefreshCw, Search, Settings2, Trash2, Upload, UsersRound, WifiOff, X } from 'lucide-react';
import { ApiError, json, messageOf, request, trackURL, API } from './api';
import { AlbumCards, ArtistCards, Artwork, Empty, Modal, Pill, PlaylistCards, TrackTable } from './components';
import { BulkEditor, LyricsPanel, PlayerBar, PlaylistEditor, QueuePanel, TrackEditor, UploadModal } from './panels';
import { usePlayer } from './player';
import { flushHistory, listCached, loadLibrary, putCached, removeCached, saveLibrary } from './storage';
import type { Album, Artist, CacheInfo, HistoryEntry, Library, Playlist, Track, View } from './types';
import { useUploads } from './upload';
import { bytes, date, duration, longDuration, matches, readLocal, writeLocal } from './utils';

const EMPTY_LIBRARY: Library = { tracks: [], albums: [], artists: [], playlists: [], tags: [], stats: { totalTracks: 0, totalAlbums: 0, totalArtists: 0, totalDuration: 0, totalBytes: 0, favoriteTracks: 0, playedSeconds: 0, playCount: 0 } };
const navigation = [
  { kind: 'home', label: '首页', icon: House }, { kind: 'library', label: '音乐库', icon: LibraryBig },
  { kind: 'albums', label: '专辑', icon: Disc3 }, { kind: 'artists', label: '艺术家', icon: UsersRound },
  { kind: 'favorites', label: '收藏', icon: Heart }, { kind: 'playlists', label: '歌单', icon: ListMusic },
  { kind: 'history', label: '最近播放', icon: Clock3 }, { kind: 'stats', label: '听歌统计', icon: BarChart3 },
  { kind: 'offline', label: '离线音乐', icon: Download }, { kind: 'trash', label: '回收站', icon: Trash2 },
] as const;
function currentView(): View {
  const [kind, id] = location.hash.slice(1).split('/');
  return [...navigation.map(item => item.kind), 'album', 'artist', 'playlist'].includes(kind) ? { kind: kind as View['kind'], id: id ? decodeURIComponent(id) : undefined } : { kind: 'home' };
}

export default function App() {
  const [library, setLibrary] = useState<Library>(EMPTY_LIBRARY);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [view, setView] = useState<View>(currentView);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('added');
  const [sidebar, setSidebar] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [panel, setPanel] = useState<'queue' | 'lyrics' | null>(null);
  const [editing, setEditing] = useState<Track>();
  const [bulkEditing, setBulkEditing] = useState<Track[]>();
  const [trackActions, setTrackActions] = useState<Track>();
  const [playlistEditor, setPlaylistEditor] = useState<{ playlist?: Playlist; ids?: string[] }>();
  const [addPlaylistIds, setAddPlaylistIds] = useState<string[]>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [trash, setTrash] = useState<Track[]>([]);
  const [cached, setCached] = useState<CacheInfo[]>([]);
  const [cacheBusy, setCacheBusy] = useState('');
  const [capacity, setCapacity] = useState<number>(() => readLocal('lilt.cache-capacity', 1024 ** 3));
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  function notify(text: string) { setToast(text); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4500); }
  const player = usePlayer([...library.tracks, ...cached.filter(item => !library.tracks.some(track => track.id === item.id)).map(item => item.track)], notify);

  async function refresh() {
    setLoading(true);
    try {
      const result = await request<Library>('/library');
      const next = { ...result, tracks: result.tracks || [], albums: result.albums || [], artists: result.artists || [], playlists: result.playlists || [], tags: result.tags || [] };
      startTransition(() => setLibrary(next)); setError(''); setLoaded(true);
      void saveLibrary(next).catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setLibrary(EMPTY_LIBRARY); setError(messageOf(error)); }
      else {
        const saved = await loadLibrary().catch(() => undefined);
        if (saved) { setLibrary(saved); setLoaded(true); setError('当前无法连接，已显示此浏览器保存的音乐库。'); }
        else setError(messageOf(error));
      }
    } finally { setLoading(false); }
  }
  const uploader = useUploads(refresh, notify);
  function navigate(next: View) { setView(next); location.hash = `${next.kind}${next.id ? `/${encodeURIComponent(next.id)}` : ''}`; setSidebar(false); setQuery(''); setTag(''); }
  useEffect(() => {
    void refresh(); void listCached().then(setCached).catch(() => undefined); void flushHistory();
    const hash = () => { setView(currentView()); setSidebar(false); };
    const connected = () => { setOnline(true); void refresh(); void flushHistory(); };
    const disconnected = () => setOnline(false);
    window.addEventListener('hashchange', hash); window.addEventListener('online', connected); window.addEventListener('offline', disconnected);
    return () => { window.removeEventListener('hashchange', hash); window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, []);
  useEffect(() => {
    if (view.kind === 'history' || view.kind === 'stats') {
      void request<{ history: HistoryEntry[] }>('/history').then(result => { setHistory(result.history || []); writeLocal('lilt.history', result.history || []); }).catch(error => { setHistory(readLocal('lilt.history', [])); if (online) notify(messageOf(error)); });
    }
    if (view.kind === 'trash') void request<{ tracks: Track[] }>('/tracks?trash=true').then(result => setTrash(result.tracks || [])).catch(error => notify(messageOf(error)));
  }, [view.kind]);

  async function run(action: () => Promise<void>) { try { await action(); } catch (error) { notify(messageOf(error)); } }
  async function favorite(track: Track) { await run(async () => { const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { favorite: !track.favorite }); setLibrary(old => ({ ...old, tracks: old.tracks.map(item => item.id === track.id ? result.track : item) })); await refresh(); }); }
  async function openEditor(track: Track) { await run(async () => { const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`); setEditing(result.track); setTrackActions(undefined); }); }
  async function locateUpload(id: string) {
    await run(async () => {
      const track = library.tracks.find(item => item.id === id) || (await request<{ track: Track }>(`/tracks/${encodeURIComponent(id)}`)).track;
      setUploadOpen(false);
      navigate({ kind: track.deletedAt ? 'trash' : 'library' });
      if (!track.deletedAt) { if (!library.tracks.some(item => item.id === id)) await refresh(); setQuery(track.title); }
    });
  }
  async function moveToTrash(track: Track) {
    await run(async () => {
      await request(`/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE' });
      const index = player.snapshot.queueIds.indexOf(track.id);
      if (index >= 0) player.remove(index);
      if (cached.some(item => item.id === track.id)) { await removeCached(track.id); setCached(old => old.filter(item => item.id !== track.id)); }
      setTrackActions(undefined); await refresh(); notify('已移入回收站');
    });
  }
  async function restoreTrack(track: Track) { await run(async () => { await json(`/tracks/${encodeURIComponent(track.id)}/restore`, 'POST'); setTrash(old => old.filter(item => item.id !== track.id)); await refresh(); notify('已恢复曲目'); }); }
  async function cacheTracks(tracks: Track[]) {
    if (cacheBusy) return;
    let saved = 0;
    try {
      for (const track of tracks) {
        setCacheBusy(track.title);
        const info = await listCached();
        const existing = info.find(item => item.id === track.id);
        if (existing?.track.updatedAt === track.updatedAt && existing.quality === 'original') continue;
        const used = info.filter(item => item.id !== track.id).reduce((sum, item) => sum + item.size, 0);
        const response = await fetch(trackURL(track.id, 'stream?quality=original'), { credentials: 'same-origin' });
        if (!response.ok) throw new Error(response.status === 401 ? '设备授权已失效，请重新打开服务。' : '离线音乐下载失败，请重试。');
        const size = Number(response.headers.get('Content-Length'));
        if (size && used + size > capacity) { void response.body?.cancel(); throw new Error('离线空间已满，请移除部分离线音乐或提高容量。'); }
        const blob = await response.blob();
        if (used + blob.size > capacity) throw new Error('离线空间已满，请移除部分离线音乐或提高容量。');
        const fullTrack = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`).then(result => result.track).catch(() => track);
        await putCached({ id: track.id, track: fullTrack, blob, quality: 'original', bitrate: Number(response.headers.get('X-Lilt-Bitrate')) || track.bitrate, size: blob.size, cachedAt: new Date().toISOString() });
        saved++;
      }
      if (navigator.storage?.persist) void navigator.storage.persist().catch(() => undefined);
      notify(saved ? `已保存 ${saved} 首离线音乐` : '所选曲目已保存离线');
    } catch (error) { notify(messageOf(error)); }
    finally { setCacheBusy(''); setCached(await listCached().catch(() => [])); }
  }
  async function removeOffline(id: string) { await run(async () => { await removeCached(id); setCached(old => old.filter(item => item.id !== id)); notify('已移除离线文件，原音乐保留'); }); }
  function playTracks(tracks: Track[] | string[]) { player.begin(tracks.map(item => typeof item === 'string' ? item : item.id)); }
  function showPanel(next: 'queue' | 'lyrics') { setPanel(old => old === next ? null : next); }

  const album = library.albums.find(item => item.id === view.id);
  const artist = library.artists.find(item => item.id === view.id);
  const playlist = library.playlists.find(item => item.id === view.id);
  let visibleTracks = view.kind === 'favorites' ? library.tracks.filter(item => item.favorite) : view.kind === 'album' ? (album?.trackIds || []).map(id => library.tracks.find(item => item.id === id)).filter((item): item is Track => !!item) : view.kind === 'artist' ? library.tracks.filter(item => artist?.trackIds.includes(item.id)) : view.kind === 'playlist' ? (playlist?.trackIds || []).map(id => library.tracks.find(item => item.id === id)).filter((item): item is Track => !!item) : view.kind === 'offline' ? cached.map(item => item.track) : library.tracks;
  visibleTracks = visibleTracks.filter(item => matches(item, deferredQuery) && (!tag || item.tags?.includes(tag)));
  if (!['album', 'playlist', 'offline'].includes(view.kind)) visibleTracks = [...visibleTracks].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'artist' ? a.artist.localeCompare(b.artist, 'zh-CN') : sort === 'album' ? a.album.localeCompare(b.album, 'zh-CN') : sort === 'played' ? b.playCount - a.playCount : sort === 'duration' ? b.duration - a.duration : new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  const table = (tracks: Track[], compact = false, onReorder?: (from: number, to: number) => void) => <TrackTable key={`${view.kind}-${view.id || ''}`} tracks={tracks} player={player} favorite={track => { void favorite(track); }} actions={setTrackActions} addToPlaylist={setAddPlaylistIds} cache={tracks => { void cacheTracks(tracks); }} bulkEdit={setBulkEditing} compact={compact} onReorder={onReorder} empty={deferredQuery || tag ? '没有匹配的曲目' : '没有曲目'} />;
  const openedAlbum = (item: Album) => navigate({ kind: 'album', id: item.id });
  const openedArtist = (item: Artist) => navigate({ kind: 'artist', id: item.id });
  const pageName = navigation.find(item => item.kind === view.kind)?.label || (view.kind === 'album' ? '专辑' : view.kind === 'artist' ? '艺术家' : '歌单');
  const cacheBytes = cached.reduce((sum, item) => sum + item.size, 0);
  const isTrackView = ['library', 'favorites', 'album', 'artist', 'playlist', 'offline'].includes(view.kind);
  const recentAlbums = [...library.albums].sort((a, b) => Math.max(...b.trackIds.map(id => new Date(library.tracks.find(item => item.id === id)?.addedAt || 0).getTime())) - Math.max(...a.trackIds.map(id => new Date(library.tracks.find(item => item.id === id)?.addedAt || 0).getTime()))).slice(0, 8);
  const unplayed = library.tracks.filter(item => !item.playCount && !item.playedSeconds);
  const unheard = library.tracks.filter(item => (item.playedSeconds > 0 || item.playCount > 0) && !!item.lastPlayedAt && Date.now() - new Date(item.lastPlayedAt).getTime() > 30 * 86400000);
  const topArtists = library.artists.map(item => ({ ...item, count: library.tracks.filter(track => item.trackIds.includes(track.id)).reduce((sum, track) => sum + track.playCount, 0) })).filter(item => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);

  return <div className="app-shell">
    {sidebar && <div className="sidebar-scrim" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <button className="brand" onClick={() => navigate({ kind: 'home' })}><img src="/lilt/favicon.svg" alt="" /><span>Lilt</span></button>
      <div className="sidebar-scroll">
        <nav>{navigation.map((item, index) => <button key={item.kind} className={`${view.kind === item.kind || view.kind === 'album' && item.kind === 'albums' || view.kind === 'artist' && item.kind === 'artists' || view.kind === 'playlist' && item.kind === 'playlists' ? 'active' : ''} ${index === 6 ? 'nav-separated' : ''}`} onClick={() => navigate({ kind: item.kind })}><item.icon size={19} strokeWidth={1.6} /><span>{item.label}</span>{item.kind === 'favorites' && library.stats.favoriteTracks > 0 && <small>{library.stats.favoriteTracks}</small>}</button>)}</nav>
        <div className="sidebar-playlists"><div><span>我的歌单</span><button aria-label="新建歌单" className="icon-button" onClick={() => setPlaylistEditor({})}><Plus size={17} /></button></div>{library.playlists.slice(0, 8).map(item => <button key={item.id} className={view.id === item.id ? 'active' : ''} onClick={() => navigate({ kind: 'playlist', id: item.id })}>{item.kind === 'smart' ? <Settings2 size={14} /> : <ListMusic size={14} />}<span>{item.name}</span></button>)}</div>
      </div>
      <div className="sidebar-bottom"><span className="connection-dot" data-online={online} title={online ? '在线' : '离线'} /><span>{library.stats.totalTracks} 首音乐</span><span className="sidebar-size" title="音乐库原文件总大小">{bytes(library.stats.totalBytes)}</span></div>
    </aside>
    <main className="main-content"><header className="topbar"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebar(true)}><Menu size={23} /></button><div className="breadcrumb"><span>Lilt</span><ChevronRight size={13} /><span>{pageName}</span></div><div className="search-box"><Search size={18} /><input ref={searchRef} aria-label="搜索音乐" placeholder="搜索曲名、艺术家、专辑" value={query} onChange={event => { setQuery(event.target.value); if (view.kind === 'home' || view.kind === 'stats' || view.kind === 'history' || view.kind === 'trash') { setView({ kind: 'library' }); location.hash = 'library'; } }} />{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><button className="button primary upload-button" onClick={() => setUploadOpen(true)}><Upload size={16} /><span>上传音乐</span>{uploader.running && <LoaderCircle className="spin" size={15} />}</button></header>
      {error && <div className={`status-banner ${online ? 'warning' : ''}`}><WifiOff size={16} /><span>{error}</span><button onClick={() => { void refresh(); }} disabled={loading}>重试</button></div>}
      {!loaded && loading ? <div className="loading-state"><LoaderCircle size={28} className="spin" /><span>正在载入音乐库</span></div> : !loaded ? <Empty title="音乐库暂时无法载入"><button className="button secondary" onClick={() => { void refresh(); }}>重试</button></Empty> : <div className="page-content" key={`${view.kind}-${view.id || ''}`}>
      {!['album', 'artist', 'playlist'].includes(view.kind) && <div className="page-heading"><div><h1>{view.kind === 'home' ? '音乐' : pageName}</h1>{view.kind === 'library' && <p>{library.tracks.length} 首 · {longDuration(library.stats.totalDuration)}</p>}{view.kind === 'favorites' && <p>{library.stats.favoriteTracks} 首</p>}</div><div className="heading-actions">{isTrackView && visibleTracks.length > 0 && <button className="button primary" onClick={() => playTracks(visibleTracks)}><Play size={17} fill="currentColor" />播放</button>}{view.kind === 'playlists' && <button className="button primary" onClick={() => setPlaylistEditor({})}><Plus size={17} />新建歌单</button>}{view.kind === 'stats' && <a className="button secondary" href={`${API}/export`}><Download size={16} />导出收藏数据</a>}<button className="icon-button" aria-label="刷新音乐库" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div></div>}
      {view.kind === 'home' && (library.tracks.length === 0 ? <Empty title="还没有音乐"><button className="button primary" onClick={() => setUploadOpen(true)}><Upload size={17} />上传音乐</button></Empty> : <>
        {player.track && !player.playing && player.position > 2 && <section className="resume-card"><Artwork url={player.track.coverUrl} /><div><span className="eyebrow">继续上次播放</span><h3>{player.track.title}</h3><p>{player.track.artist} · {duration(player.position)}</p></div><button className="round-play" aria-label="继续上次播放" onClick={() => player.play()}><Play size={22} fill="currentColor" /></button></section>}
        <section className="home-section"><div className="section-heading"><h2>最近加入</h2><button className="text-button" onClick={() => navigate({ kind: 'albums' })}>全部专辑<ChevronRight size={15} /></button></div>{recentAlbums.length ? <AlbumCards albums={recentAlbums} onOpen={openedAlbum} onPlay={playTracks} /> : table(visibleTracks.slice(0, 6), true)}</section>
        <div className="discovery-grid"><button className="discovery-card favorites-discovery" disabled={!library.stats.favoriteTracks} onClick={() => playTracks(library.tracks.filter(item => item.favorite))}><Heart size={31} strokeWidth={1.3} /><div><h3>收藏常听</h3><p>{library.stats.favoriteTracks} 首收藏</p></div><Play size={19} fill="currentColor" /></button><button className="discovery-card" disabled={!unplayed.length} onClick={() => playTracks(unplayed)}><Disc3 size={31} strokeWidth={1.3} /><div><h3>尚未播放</h3><p>{unplayed.length} 首待听</p></div><Play size={19} fill="currentColor" /></button><button className="discovery-card" disabled={!unheard.length} onClick={() => playTracks(unheard)}><Clock3 size={31} strokeWidth={1.3} /><div><h3>久未重听</h3><p>超过 30 天未听 · {unheard.length} 首</p></div><Play size={19} fill="currentColor" /></button></div>
        <section className="home-section"><div className="section-heading"><h2>最近曲目</h2><button className="text-button" onClick={() => navigate({ kind: 'library' })}>音乐库<ChevronRight size={15} /></button></div>{table([...library.tracks].sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()).slice(0, 8), true)}</section>
      </>)}
      {view.kind === 'albums' && (library.albums.length ? <AlbumCards albums={library.albums.filter(item => !deferredQuery || item.trackIds.some(id => library.tracks.some(track => track.id === id && matches(track, deferredQuery))))} onOpen={openedAlbum} onPlay={playTracks} /> : <Empty title="没有专辑" />)}
      {view.kind === 'artists' && (library.artists.length ? <ArtistCards artists={library.artists.filter(item => !deferredQuery || item.trackIds.some(id => library.tracks.some(track => track.id === id && matches(track, deferredQuery))))} onOpen={openedArtist} /> : <Empty title="没有艺术家" />)}
      {view.kind === 'playlists' && <PlaylistCards playlists={library.playlists.filter(item => !deferredQuery || item.name.toLocaleLowerCase().includes(deferredQuery.toLocaleLowerCase()))} onOpen={item => navigate({ kind: 'playlist', id: item.id })} onCreate={() => setPlaylistEditor({})} />}
      {['album', 'artist', 'playlist'].includes(view.kind) && <><button className="back-button" onClick={() => navigate({ kind: view.kind === 'album' ? 'albums' : view.kind === 'artist' ? 'artists' : 'playlists' })}><ArrowLeft size={16} />{pageName}</button>{(album && view.kind === 'album' || artist && view.kind === 'artist' || playlist && view.kind === 'playlist') ? <div className="collection-header"><Artwork url={view.kind === 'album' ? album?.coverUrl : view.kind === 'artist' ? artist?.coverUrl : playlist?.coverUrl} className={view.kind === 'artist' ? 'round' : ''} /><div><span className="eyebrow">{view.kind === 'playlist' && playlist?.kind === 'smart' ? '智能歌单' : pageName}</span><h1>{view.kind === 'album' ? album?.title : view.kind === 'artist' ? artist?.name : playlist?.name}</h1><p>{view.kind === 'album' ? `${album?.artist} · ${album?.year ? `${album.year} · ` : ''}` : ''}{visibleTracks.length} 首 · {longDuration(visibleTracks.reduce((sum, item) => sum + item.duration, 0))}</p>{playlist?.description && view.kind === 'playlist' && <p>{playlist.description}</p>}<div className="collection-actions"><button className="button primary" disabled={!visibleTracks.length} onClick={() => playTracks(visibleTracks)}><Play size={17} fill="currentColor" />播放</button><button className="button secondary" disabled={!visibleTracks.length} onClick={() => player.enqueue(visibleTracks.map(item => item.id))}><ListMusic size={17} />加入队列</button>{playlist && view.kind === 'playlist' && <><button className="button secondary" onClick={() => setPlaylistEditor({ playlist })}>编辑歌单</button><a className="icon-button" aria-label="导出歌单" href={`${API}/playlists/${encodeURIComponent(playlist.id)}/export`}><Download size={19} /></a><button className="icon-button" aria-label="删除歌单" onClick={() => { if (window.confirm(`删除歌单「${playlist.name}」？音乐文件不会删除。`)) void run(async () => { await request(`/playlists/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' }); await refresh(); navigate({ kind: 'playlists' }); notify('已删除歌单'); }); }}><Trash2 size={18} /></button></>}</div></div></div> : <Empty title="此收藏已不存在" />}{view.kind === 'artist' && artist && library.albums.some(item => item.trackIds.some(id => artist.trackIds.includes(id))) && <section className="artist-albums"><h2>专辑</h2><AlbumCards albums={library.albums.filter(item => item.trackIds.some(id => artist.trackIds.includes(id)))} onOpen={openedAlbum} onPlay={playTracks} /></section>}</>}
      {isTrackView && <><div className="library-tools">{library.tags.length > 0 && <div className="tag-filters"><Pill active={!tag} onClick={() => setTag('')}>全部</Pill>{library.tags.map(item => <Pill key={item} active={tag === item} onClick={() => setTag(tag === item ? '' : item)}>{item}</Pill>)}</div>}{!['album', 'playlist', 'offline'].includes(view.kind) && <select aria-label="曲目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="added">最近加入</option><option value="title">曲名</option><option value="artist">艺术家</option><option value="album">专辑</option><option value="played">播放次数</option><option value="duration">时长</option></select>}</div>{view.kind === 'offline' && <><div className="offline-summary"><div><Download size={20} /><strong>{cached.length} 首已保存</strong><span>{bytes(cacheBytes)} / {bytes(capacity)}</span></div><label>容量<select value={capacity} onChange={event => { const value = Number(event.target.value); setCapacity(value); writeLocal('lilt.cache-capacity', value); }}><option value={512 * 1024 ** 2}>512 MB</option><option value={1024 ** 3}>1 GB</option><option value={2 * 1024 ** 3}>2 GB</option><option value={4 * 1024 ** 3}>4 GB</option></select></label></div><p className="offline-note">离线文件保存在此浏览器中，系统清理浏览器数据时可能被移除。</p></>}{table(visibleTracks, false, playlist?.kind === 'manual' && view.kind === 'playlist' && !query && !tag ? (from, to) => { void run(async () => { const ids = [...playlist.trackIds]; const [id] = ids.splice(from, 1); ids.splice(to, 0, id); await json(`/playlists/${encodeURIComponent(playlist.id)}`, 'PUT', { name: playlist.name, description: playlist.description, trackIds: ids }); await refresh(); }); } : undefined)}</>}
      {view.kind === 'history' && (history.length ? <div className="history-list">{history.map(entry => { const track = library.tracks.find(item => item.id === entry.trackId); return <article key={entry.id}><Artwork url={track?.coverUrl} /><button onClick={() => { if (track) player.begin([track.id]); }} disabled={!track}><strong>{track?.title || '曲目已移入回收站'}</strong><span>{track?.artist || ''}</span></button><span>{longDuration(entry.seconds)}</span><time>{new Date(entry.playedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>{entry.completed && <Check size={16} className="muted" />}</article>; })}</div> : <Empty title="还没有听歌记录" />)}
      {view.kind === 'stats' && <><div className="stats-grid"><article><span>音乐收藏</span><strong>{library.stats.totalTracks}<small> 首</small></strong><p>{library.stats.totalAlbums} 张专辑 · {library.stats.totalArtists} 位艺术家</p></article><article><span>累计聆听</span><strong>{(library.stats.playedSeconds / 3600).toFixed(1)}<small> 小时</small></strong><p>{library.stats.playCount} 次播放</p></article><article><span>收藏时长</span><strong>{(library.stats.totalDuration / 3600).toFixed(1)}<small> 小时</small></strong><p>原文件 {bytes(library.stats.totalBytes)}</p></article><article><span>喜欢的音乐</span><strong>{library.stats.favoriteTracks}<small> 首</small></strong><p>{cached.length} 首离线保存</p></article></div><section className="home-section"><div className="section-heading"><h2>常听艺术家</h2></div>{topArtists.length ? <div className="artist-ranking">{topArtists.map((item, index) => <button key={item.id} onClick={() => openedArtist(item)}><span>{String(index + 1).padStart(2, '0')}</span><Artwork url={item.coverUrl} className="round" /><div><strong>{item.name}</strong><div className="ranking-bar"><i style={{ width: `${item.count / topArtists[0].count * 100}%` }} /></div></div><small>{item.count} 次</small></button>)}</div> : <Empty title="还没有听歌统计" />}</section></>}
      {view.kind === 'trash' && (trash.length ? <div className="trash-list">{trash.map(track => <article key={track.id}><Artwork url={track.coverUrl} /><div><strong>{track.title}</strong><p>{track.artist} · {track.album}</p><small>{date(track.deletedAt || '')} 移入</small></div><button className="button secondary" onClick={() => { void restoreTrack(track); }}>恢复</button></article>)}</div> : <Empty title="回收站为空" />)}
      </div>}
    </main>
    <PlayerBar player={player} panel={panel} onQueue={() => showPanel('queue')} onLyrics={() => showPanel('lyrics')} onMore={setTrackActions} />
    {panel === 'queue' && <QueuePanel player={player} onClose={() => setPanel(null)} onSave={ids => setPlaylistEditor({ ids })} />}
    {panel === 'lyrics' && <LyricsPanel player={player} onClose={() => setPanel(null)} onEdit={track => { void openEditor(track); }} />}
    {uploadOpen && <UploadModal uploader={uploader} tracks={library.tracks} onClose={() => setUploadOpen(false)} onLocate={id => { void locateUpload(id); }} />}
    {editing && <TrackEditor track={editing} onClose={() => setEditing(undefined)} onSaved={async () => { await refresh(); notify('曲目信息已保存'); }} />}
    {bulkEditing && <BulkEditor tracks={bulkEditing} onClose={() => setBulkEditing(undefined)} onRefresh={refresh} onSaved={() => notify(`已更新 ${bulkEditing.length} 首曲目`)} />}
    {playlistEditor && <PlaylistEditor playlist={playlistEditor.playlist} initialIds={playlistEditor.ids} onClose={() => setPlaylistEditor(undefined)} onSaved={async playlist => { await refresh(); navigate({ kind: 'playlist', id: playlist.id }); notify('歌单已保存'); }} />}
    {addPlaylistIds && <Modal title="加入歌单" onClose={() => setAddPlaylistIds(undefined)}><div className="modal-body add-playlist-list">{library.playlists.filter(item => item.kind === 'manual').map(item => <button key={item.id} onClick={() => { void run(async () => { await json(`/playlists/${encodeURIComponent(item.id)}`, 'PUT', { name: item.name, description: item.description, trackIds: [...item.trackIds, ...addPlaylistIds.filter(id => !item.trackIds.includes(id))] }); await refresh(); setAddPlaylistIds(undefined); notify('已加入歌单'); }); }}><ListMusic size={18} /><span>{item.name}</span><Plus size={17} /></button>)}<button onClick={() => { setPlaylistEditor({ ids: addPlaylistIds }); setAddPlaylistIds(undefined); }}><Plus size={19} /><span>新建歌单</span></button></div></Modal>}
    {trackActions && <Modal title={`${trackActions.title} · 更多功能`} onClose={() => setTrackActions(undefined)}><div className="modal-body track-action-menu"><button onClick={() => { void favorite(trackActions); setTrackActions(undefined); }}><Heart size={18} fill={trackActions.favorite ? 'currentColor' : 'none'} />{trackActions.favorite ? '取消收藏' : '收藏'}</button><button onClick={() => { player.enqueue([trackActions.id], true); setTrackActions(undefined); }}><Play size={18} />下一首播放</button><button onClick={() => { player.enqueue([trackActions.id]); setTrackActions(undefined); }}><ListMusic size={18} />加入播放队列</button><button onClick={() => { setAddPlaylistIds([trackActions.id]); setTrackActions(undefined); }}><Plus size={18} />加入歌单</button>{view.kind === 'playlist' && playlist?.kind === 'manual' && <button onClick={() => { void run(async () => { await json(`/playlists/${encodeURIComponent(playlist.id)}`, 'PUT', { name: playlist.name, description: playlist.description, trackIds: playlist.trackIds.filter(id => id !== trackActions.id) }); setTrackActions(undefined); await refresh(); notify('已从歌单移除'); }); }}><X size={18} />从歌单移除</button>}<button onClick={() => { void openEditor(trackActions); }}><Settings2 size={18} />编辑曲目</button><a href={trackURL(trackActions.id, 'download')}><Download size={18} />下载原文件</a><button onClick={() => { void cacheTracks([trackActions]); setTrackActions(undefined); }}><Download size={18} />{cached.some(item => item.id === trackActions.id) ? '更新离线文件' : '保存离线'}</button>{cached.some(item => item.id === trackActions.id) && <button onClick={() => { void removeOffline(trackActions.id); setTrackActions(undefined); }}><X size={18} />移除离线文件</button>}<button className="danger" onClick={() => { void moveToTrash(trackActions); }}><Trash2 size={18} />移入回收站</button></div></Modal>}
    {player.conflict && <Modal title="其他标签页正在播放" onClose={() => player.setConflict(false)}><div className="modal-body"><p>在此标签页播放，将暂停另一个标签页。</p></div><footer className="modal-footer"><button className="button secondary" onClick={() => player.setConflict(false)}>取消</button><button className="button primary" onClick={() => player.play(true)}>在此播放</button></footer></Modal>}
    {cacheBusy && <div className="cache-progress"><LoaderCircle size={16} className="spin" />正在保存：{cacheBusy}</div>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>;
}
