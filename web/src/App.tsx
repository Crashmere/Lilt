import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BarChart3, Check, ChevronRight, Clock3, Disc3, Download, Heart, House, LibraryBig, ListMusic, LoaderCircle, Menu, MoreHorizontal, Music2, Play, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Trash2, Upload, UsersRound, WifiOff, X } from 'lucide-react';
import { ApiError, json, messageOf, readLibrary, request, trackURL, API } from './api';
import { AlbumCards, Artwork, Empty, Modal, Pill, PlaylistCards, TrackPlaylists, TrackTable } from './components';
import { ArtistBrowser } from './artists';
import { LibraryFilterModal } from './library-filter-modal';
import { activeFilterColumns, EMPTY_FILTERS, matchesFilters, type LibraryFilters } from './library-filters';
import { BulkEditor, LyricsPanel, PlayerBar, PlaylistEditor, QueuePanel, TrackEditor, UploadModal } from './panels';
import { usePlayer } from './player';
import { indexPlaylistMemberships } from './playlist-memberships';
import { TrackCredits, type CollectionNavigation } from './track-links';
import { flushHistory, loadLibrary, saveLibrary } from './storage';
import type { Album, Artist, HistoryEntry, Library, Playlist, Track, View } from './types';
import { useUploads, type UploadPlaylist } from './upload';
import { adjustLyricsOffset, bytes, date, duration, longDuration, matches, parseLyrics, readLocal, writeLocal } from './utils';

const EMPTY_LIBRARY: Library = { tracks: [], albums: [], artists: [], playlists: [], tags: [], stats: { totalTracks: 0, totalAlbums: 0, totalArtists: 0, totalDuration: 0, totalBytes: 0, favoriteTracks: 0, playedSeconds: 0, playCount: 0 } };
const navigation = [
  { kind: 'home', label: '首页', icon: House }, { kind: 'library', label: '音乐库', icon: LibraryBig },
  { kind: 'albums', label: '专辑', icon: Disc3 }, { kind: 'artists', label: '艺术家', icon: UsersRound },
  { kind: 'favorites', label: '收藏', icon: Heart }, { kind: 'playlists', label: '歌单', icon: ListMusic },
  { kind: 'history', label: '最近播放', icon: Clock3 }, { kind: 'stats', label: '听歌统计', icon: BarChart3 },
  { kind: 'trash', label: '回收站', icon: Trash2 },
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
  const [selectedTag, setSelectedTag] = useState('');
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilters>({ ...EMPTY_FILTERS });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const tag = view.kind === 'library' ? libraryFilters.tag : selectedTag;
  function setTag(next: string) {
    if (view.kind === 'library') setLibraryFilters(old => ({ ...old, tag: next, tagState: '' }));
    else setSelectedTag(next);
  }
  const [sort, setSort] = useState('added');
  const [sidebar, setSidebar] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadPlaylist, setUploadPlaylist] = useState<UploadPlaylist>();
  const [panel, setPanel] = useState<'queue' | 'lyrics' | null>(null);
  const [editing, setEditing] = useState<Track>();
  const [bulkEditing, setBulkEditing] = useState<Track[]>();
  const [trackActions, setTrackActions] = useState<Track>();
  const [albumActions, setAlbumActions] = useState<Album>();
  const [playlistEditor, setPlaylistEditor] = useState<{ playlist?: Playlist; ids?: string[] }>();
  const [addPlaylistIds, setAddPlaylistIds] = useState<string[]>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [trash, setTrash] = useState<Track[]>([]);
  const [trashPlaylists, setTrashPlaylists] = useState<Playlist[]>([]);
  const [playlistTrack, setPlaylistTrack] = useState<Track>();
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const refreshAbort = useRef<AbortController | undefined>(undefined);
  const hasLibrary = useRef(false);
  const cacheAllowed = useRef(true);
  const libraryEtag = useRef('');

  function notify(text: string) { setToast(text); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4500); }
  const player = usePlayer(library.tracks, notify);

  async function refresh() {
    refreshAbort.current?.abort();
    const abort = new AbortController();
    refreshAbort.current = abort;
    setLoading(true);
    try {
      const response = await readLibrary(abort.signal, hasLibrary.current ? libraryEtag.current : '');
      if (abort.signal.aborted) return;
      if (!response.library) { setError(''); setLoaded(true); return; }
      const result = response.library;
      if (!Array.isArray(result.tracks)) throw new TypeError('音乐库响应不完整，请重试。');
      const next = { ...result, tracks: result.tracks || [], albums: result.albums || [], artists: result.artists || [], playlists: result.playlists || [], tags: result.tags || [] };
      hasLibrary.current = true;
      libraryEtag.current = response.etag;
      startTransition(() => setLibrary(next)); setError(''); setLoaded(true);
      void saveLibrary(next, response.etag).catch(() => undefined);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { cacheAllowed.current = false; hasLibrary.current = false; libraryEtag.current = ''; setLibrary(EMPTY_LIBRARY); setLoaded(false); setError(messageOf(error)); }
      else {
        setError(hasLibrary.current ? '当前无法连接，已保留音乐库，请重试。' : messageOf(error));
      }
    } finally { if (!abort.signal.aborted) setLoading(false); }
  }
  const uploader = useUploads(refresh, notify);
  function openUpload() {
    const target = view.kind === 'playlist' ? library.playlists.find(item => item.id === view.id && item.kind === 'manual') : undefined;
    setUploadPlaylist(target ? { id: target.id, name: target.name } : undefined);
    setUploadOpen(true);
  }
  function navigate(next: View) { setView(next); location.hash = `${next.kind}${next.id ? `/${encodeURIComponent(next.id)}` : ''}`; setSidebar(false); setQuery(''); setSelectedTag(''); setFiltersOpen(false); }
  useEffect(() => {
    let active = true;
    void loadLibrary().then(saved => {
      if (!active || !cacheAllowed.current || hasLibrary.current || !saved) return;
      hasLibrary.current = true;
      libraryEtag.current = saved.etag;
      setLibrary(saved.library); setLoaded(true);
    }).catch(() => undefined).finally(() => { if (active) void refresh(); });
    void flushHistory();
    const hash = () => { setView(currentView()); setSidebar(false); setFiltersOpen(false); };
    const connected = () => { setOnline(true); void refresh(); void flushHistory(); };
    const disconnected = () => setOnline(false);
    window.addEventListener('hashchange', hash); window.addEventListener('online', connected); window.addEventListener('offline', disconnected);
    return () => { active = false; refreshAbort.current?.abort(); window.removeEventListener('hashchange', hash); window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, []);
  useEffect(() => {
    if (view.kind === 'history' || view.kind === 'stats') {
      void request<{ history: HistoryEntry[] }>('/history').then(result => { setHistory(result.history || []); writeLocal('lilt.history', result.history || []); }).catch(error => { setHistory(readLocal('lilt.history', [])); if (online) notify(messageOf(error)); });
    }
  }, [view.kind]);
  useEffect(() => {
    if (view.kind === 'trash') void request<{ tracks: Track[]; playlists: Playlist[] }>('/tracks?trash=true').then(result => { setTrash(result.tracks || []); setTrashPlaylists(result.playlists || []); }).catch(error => notify(messageOf(error)));
  }, [view.kind, library.playlists]);

  async function run(action: () => Promise<void>) { try { await action(); } catch (error) { notify(messageOf(error)); } }
  async function favorite(track: Track) { await run(async () => { const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`, 'PATCH', { favorite: !track.favorite }); setLibrary(old => ({ ...old, tracks: old.tracks.map(item => item.id === track.id ? result.track : item) })); await refresh(); }); }
  async function openEditor(track: Track) { await run(async () => { const result = await request<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}`); setEditing(result.track); setTrackActions(undefined); }); }
  async function adjustLyrics(track: Track, seconds: number) {
    const path = `/tracks/${encodeURIComponent(track.id)}`;
    const current = await request<{ lyricsText: string; updatedAt: string }>(`${path}/lyrics`);
    if (!parseLyrics(current.lyricsText).lines.length) {
      void refresh();
      throw new Error('歌词已变更，请刷新后重试。');
    }
    const result = await json<{ track: Track }>(path, 'PATCH', {
      lyricsText: adjustLyricsOffset(current.lyricsText, seconds), expectedUpdatedAt: current.updatedAt,
    });
    setLibrary(old => ({ ...old, tracks: old.tracks.map(item => item.id === track.id ? result.track : item) }));
    void refresh();
    notify('歌词调整已写回歌曲文件');
  }
  async function locateUpload(id: string) {
    await run(async () => {
      const track = library.tracks.find(item => item.id === id) || (await request<{ track: Track }>(`/tracks/${encodeURIComponent(id)}`)).track;
      setUploadOpen(false);
      navigate({ kind: track.deletedAt ? 'trash' : 'library' });
      if (!track.deletedAt) { if (!library.tracks.some(item => item.id === id)) await refresh(); setLibraryFilters({ ...EMPTY_FILTERS }); setQuery(track.title); }
    });
  }
  async function moveToTrash(track: Track) {
    await run(async () => {
      await request(`/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE' });
      const index = player.snapshot.queueIds.indexOf(track.id);
      if (index >= 0) player.remove(index);
      setTrackActions(undefined); await refresh(); notify('已移入回收站');
    });
  }
  async function restoreTrack(track: Track) { await run(async () => { await json(`/tracks/${encodeURIComponent(track.id)}/restore`, 'POST'); setTrash(old => old.filter(item => item.id !== track.id)); await refresh(); notify('已恢复曲目'); }); }
  function playTracks(tracks: Track[] | string[]) { player.begin(tracks.map(item => typeof item === 'string' ? item : item.id)); }
  function showPanel(next: 'queue' | 'lyrics') { setPanel(old => old === next ? null : next); }

  const album = library.albums.find(item => item.id === view.id);
  const playlist = library.playlists.find(item => item.id === view.id);
  const playlistMemberships = indexPlaylistMemberships(library.playlists);
  const collectionNavigation: CollectionNavigation = {
    artistIds: new Map(library.artists.map(artist => [artist.name, artist.id])),
    albumIds: new Map(library.albums.flatMap(album => album.trackIds.map(id => [id, album.id] as const))),
    open: next => { setPanel(null); navigate(next); },
  };
  const trashMemberships = indexPlaylistMemberships(trashPlaylists);
  const joinedPlaylists = playlistTrack ? (playlistTrack.deletedAt ? trashMemberships : playlistMemberships).get(playlistTrack.id) || [] : [];
  const albumActionTracks = (albumActions?.trackIds || []).map(id => library.tracks.find(track => track.id === id)).filter((track): track is Track => !!track);
  let visibleTracks = view.kind === 'favorites' ? library.tracks.filter(item => item.favorite) : view.kind === 'album' ? (album?.trackIds || []).map(id => library.tracks.find(item => item.id === id)).filter((item): item is Track => !!item) : view.kind === 'playlist' ? (playlist?.trackIds || []).map(id => library.tracks.find(item => item.id === id)).filter((item): item is Track => !!item) : library.tracks;
  const libraryFilterColumns = activeFilterColumns(libraryFilters);
  const activeFilterCount = libraryFilterColumns.length;
  visibleTracks = visibleTracks.filter(item => matches(item, deferredQuery) && (view.kind === 'library' ? matchesFilters(item, libraryFilters, playlistMemberships.get(item.id)?.length || 0) : !tag || item.tags?.includes(tag)));
  if (!['album', 'playlist'].includes(view.kind)) visibleTracks = [...visibleTracks].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'artist' ? a.artist.localeCompare(b.artist, 'zh-CN') : sort === 'album' ? a.album.localeCompare(b.album, 'zh-CN') : sort === 'played' ? b.playCount - a.playCount : sort === 'duration' ? b.duration - a.duration : new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  const table = (tracks: Track[], compact = false, onReorder?: (from: number, to: number) => void, albumTracks = false) => {
    if (!tracks.length && view.kind === 'library' && activeFilterCount) return <Empty title="没有匹配的曲目"><button className="button secondary" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={16} />调整筛选</button></Empty>;
    return <TrackTable key={`${view.kind}-${view.id || ''}`} tracks={tracks} player={player} favorite={track => { void favorite(track); }} actions={setTrackActions} playlistMemberships={playlistMemberships} showPlaylists={setPlaylistTrack} addToPlaylist={setAddPlaylistIds} bulkEdit={setBulkEditing} collectionNavigation={collectionNavigation} filterColumns={view.kind === 'library' ? libraryFilterColumns : undefined} compact={compact} albumTracks={albumTracks} onReorder={onReorder} empty={deferredQuery || tag ? '没有匹配的曲目' : '没有曲目'} />;
  };
  const openedAlbum = (item: Album) => navigate({ kind: 'album', id: item.id });
  const openedArtist = (item: Artist) => navigate({ kind: 'artist', id: item.id });
  const pageName = navigation.find(item => item.kind === view.kind)?.label || (view.kind === 'album' ? '专辑' : view.kind === 'artist' ? '艺术家' : '歌单');
  const isTrackView = ['library', 'favorites', 'album', 'playlist'].includes(view.kind);
  const isArtistView = view.kind === 'artists' || view.kind === 'artist';
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
    <main className={`main-content ${isArtistView ? 'artist-main' : ''}`}><header className="topbar"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebar(true)}><Menu size={23} /></button><div className="breadcrumb"><span>Lilt</span><ChevronRight size={13} /><span>{pageName}</span></div><div className="search-box"><Search size={18} /><input ref={searchRef} aria-label="搜索音乐" placeholder="搜索曲名、艺术家、专辑" value={query} onChange={event => { setQuery(event.target.value); if (view.kind === 'home' || view.kind === 'stats' || view.kind === 'history' || view.kind === 'trash') { setView({ kind: 'library' }); location.hash = 'library'; } }} />{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><button className="button primary upload-button" onClick={openUpload}><Upload size={16} /><span>上传音乐</span>{uploader.running && <LoaderCircle className="spin" size={15} />}</button></header>
      {error && <div className={`status-banner ${online ? 'warning' : ''}`}><WifiOff size={16} /><span>{error}</span><button onClick={() => { void refresh(); }} disabled={loading}>重试</button></div>}
      {!loaded && loading ? <div className="loading-state"><LoaderCircle size={28} className="spin" /><span>正在载入音乐库</span></div> : !loaded ? <Empty title="音乐库暂时无法载入"><button className="button secondary" onClick={() => { void refresh(); }}>重试</button></Empty> : <div className={`page-content ${isArtistView ? 'artist-page' : ''}`} key={isArtistView ? 'artists' : `${view.kind}-${view.id || ''}`}>
      {!isArtistView && !['album', 'playlist'].includes(view.kind) && <div className="page-heading"><div><h1>{view.kind === 'home' ? '音乐' : pageName}</h1>{view.kind === 'library' && <p>{activeFilterCount || deferredQuery ? `${visibleTracks.length} / ${library.tracks.length}` : library.tracks.length} 首 · {longDuration(library.stats.totalDuration)}</p>}{view.kind === 'favorites' && <p>{library.stats.favoriteTracks} 首</p>}</div><div className="heading-actions">{view.kind === 'library' && <button className={`button secondary library-filter-trigger ${activeFilterCount ? 'active' : ''}`} aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={16} /><span>筛选</span>{activeFilterCount > 0 && <small>{activeFilterCount}</small>}</button>}{isTrackView && visibleTracks.length > 0 && <button className="button primary" onClick={() => playTracks(visibleTracks)}><Play size={17} fill="currentColor" />播放</button>}{view.kind === 'playlists' && <button className="button primary" onClick={() => setPlaylistEditor({})}><Plus size={17} />新建歌单</button>}{view.kind === 'stats' && <a className="button secondary" href={`${API}/export`}><Download size={16} />导出收藏数据</a>}<button className="icon-button" aria-label="刷新音乐库" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div></div>}
      {view.kind === 'home' && (library.tracks.length === 0 ? <Empty title="还没有音乐"><button className="button primary" onClick={openUpload}><Upload size={17} />上传音乐</button></Empty> : <>
        {player.track && !player.playRequested && player.position > 2 && <section className="resume-card"><Artwork url={player.track.coverUrl} /><div><span className="eyebrow">继续上次播放</span><h3>{player.track.title}</h3><p>{player.track.artist} · {duration(player.position)}</p></div><button className="round-play" aria-label="继续上次播放" onClick={() => player.play()}><Play size={22} fill="currentColor" /></button></section>}
        <section className="home-section"><div className="section-heading"><h2>最近加入</h2><button className="text-button" onClick={() => navigate({ kind: 'albums' })}>全部专辑<ChevronRight size={15} /></button></div>{recentAlbums.length ? <AlbumCards albums={recentAlbums} onOpen={openedAlbum} onPlay={playTracks} /> : table(visibleTracks.slice(0, 6), true)}</section>
        <div className="discovery-grid"><button className="discovery-card favorites-discovery" disabled={!library.stats.favoriteTracks} onClick={() => playTracks(library.tracks.filter(item => item.favorite))}><Heart size={31} strokeWidth={1.3} /><div><h3>收藏常听</h3><p>{library.stats.favoriteTracks} 首收藏</p></div><Play size={19} fill="currentColor" /></button><button className="discovery-card" disabled={!unplayed.length} onClick={() => playTracks(unplayed)}><Disc3 size={31} strokeWidth={1.3} /><div><h3>尚未播放</h3><p>{unplayed.length} 首待听</p></div><Play size={19} fill="currentColor" /></button><button className="discovery-card" disabled={!unheard.length} onClick={() => playTracks(unheard)}><Clock3 size={31} strokeWidth={1.3} /><div><h3>久未重听</h3><p>超过 30 天未听 · {unheard.length} 首</p></div><Play size={19} fill="currentColor" /></button></div>
        <section className="home-section"><div className="section-heading"><h2>最近曲目</h2><button className="text-button" onClick={() => navigate({ kind: 'library' })}>音乐库<ChevronRight size={15} /></button></div>{table([...library.tracks].sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()).slice(0, 8), true)}</section>
      </>)}
      {view.kind === 'albums' && (library.albums.length ? <AlbumCards albums={library.albums.filter(item => !deferredQuery || item.trackIds.some(id => library.tracks.some(track => track.id === id && matches(track, deferredQuery))))} onOpen={openedAlbum} onPlay={playTracks} /> : <Empty title="没有专辑" />)}
      {isArtistView && <ArtistBrowser library={library} artistId={view.kind === 'artist' ? view.id : undefined} query={deferredQuery} tag={tag} loading={loading} onSelect={item => { startTransition(() => setView({ kind: 'artist', id: item.id })); location.hash = `artist/${encodeURIComponent(item.id)}`; }} onTag={setTag} onRefresh={() => { void refresh(); }} onPlay={playTracks} onEnqueue={ids => player.enqueue(ids)} onOpenAlbum={openedAlbum} onAlbumActions={setAlbumActions} renderTracks={tracks => table(tracks, false, undefined, true)} />}
      {view.kind === 'playlists' && <PlaylistCards playlists={library.playlists.filter(item => !deferredQuery || item.name.toLocaleLowerCase().includes(deferredQuery.toLocaleLowerCase()))} onOpen={item => navigate({ kind: 'playlist', id: item.id })} onCreate={() => setPlaylistEditor({})} />}
      {['album', 'playlist'].includes(view.kind) && <><button className="back-button" onClick={() => navigate({ kind: view.kind === 'album' ? 'albums' : 'playlists' })}><ArrowLeft size={16} />{pageName}</button>{(album && view.kind === 'album' || playlist && view.kind === 'playlist') ? <div className="collection-header"><Artwork url={view.kind === 'album' ? album?.coverUrl : playlist?.coverUrl} /><div><span className="eyebrow">{view.kind === 'playlist' && playlist?.kind === 'smart' ? '智能歌单' : pageName}</span><h1>{view.kind === 'album' ? album?.title : playlist?.name}</h1><p>{view.kind === 'album' ? `${album?.artist} · ${album?.year ? `${album.year} · ` : ''}` : ''}{visibleTracks.length} 首 · {longDuration(visibleTracks.reduce((sum, item) => sum + item.duration, 0))}</p>{playlist?.description && view.kind === 'playlist' && <p>{playlist.description}</p>}<div className="collection-actions"><button className="button primary" disabled={!visibleTracks.length} onClick={() => playTracks(visibleTracks)}><Play size={17} fill="currentColor" />播放</button><button className="button secondary" disabled={!visibleTracks.length} onClick={() => player.enqueue(visibleTracks.map(item => item.id))}><ListMusic size={17} />加入队列</button>{playlist && view.kind === 'playlist' && <><button className="button secondary" onClick={() => setPlaylistEditor({ playlist })}>编辑歌单</button><a className="icon-button" aria-label="导出歌单" href={`${API}/playlists/${encodeURIComponent(playlist.id)}/export`}><Download size={19} /></a><button className="icon-button" aria-label="删除歌单" onClick={() => { if (window.confirm(`删除歌单「${playlist.name}」？音乐文件不会删除。`)) void run(async () => { await request(`/playlists/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' }); await refresh(); navigate({ kind: 'playlists' }); notify('已删除歌单'); }); }}><Trash2 size={18} /></button></>}</div></div></div> : <Empty title="此收藏已不存在" />}</>}
      {isTrackView && <><div className="library-tools">{library.tags.length > 0 && <div className="tag-filters"><Pill active={!tag} onClick={() => setTag('')}>全部</Pill>{library.tags.map(item => <Pill key={item} active={tag === item} onClick={() => setTag(tag === item ? '' : item)}>{item}</Pill>)}</div>}{!['album', 'playlist'].includes(view.kind) && <select aria-label="曲目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="added">最近加入</option><option value="title">曲名</option><option value="artist">艺术家</option><option value="album">专辑</option><option value="played">播放次数</option><option value="duration">时长</option></select>}</div>{table(visibleTracks, false, playlist?.kind === 'manual' && view.kind === 'playlist' && !query && !tag ? (from, to) => { void run(async () => { const ids = [...playlist.trackIds]; const [id] = ids.splice(from, 1); ids.splice(to, 0, id); await json(`/playlists/${encodeURIComponent(playlist.id)}`, 'PUT', { name: playlist.name, description: playlist.description, trackIds: ids }); await refresh(); }); } : undefined)}</>}
      {view.kind === 'history' && (history.length ? <div className="history-list">
        <div className="history-heading"><span>曲目</span><span className="playlist-cell">歌单</span><span>聆听时长</span><span>播放时间</span><span /></div>
        {history.map(entry => {
          const track = library.tracks.find(item => item.id === entry.trackId);
          return <article key={entry.id}>
            <Artwork url={track?.coverUrl} />
            <div className="history-track"><button onClick={() => { if (track) player.begin([track.id]); }} disabled={!track}><strong>{track?.title || '曲目已移入回收站'}</strong></button>{track && <p><TrackCredits track={track} navigation={collectionNavigation} /></p>}</div>
            <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={playlistMemberships.get(entry.trackId)} onOpen={() => { if (track) setPlaylistTrack(track); }} /></div>
            <span>{longDuration(entry.seconds)}</span><time>{new Date(entry.playedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
            <span className="history-completed">{entry.completed && <Check size={16} className="muted" />}</span>
          </article>;
        })}
      </div> : <Empty title="还没有听歌记录" />)}
      {view.kind === 'stats' && <><div className="stats-grid"><article><span>音乐收藏</span><strong>{library.stats.totalTracks}<small> 首</small></strong><p>{library.stats.totalAlbums} 张专辑 · {library.stats.totalArtists} 位艺术家</p></article><article><span>累计聆听</span><strong>{(library.stats.playedSeconds / 3600).toFixed(1)}<small> 小时</small></strong><p>{library.stats.playCount} 次播放</p></article><article><span>收藏时长</span><strong>{(library.stats.totalDuration / 3600).toFixed(1)}<small> 小时</small></strong><p>原文件 {bytes(library.stats.totalBytes)}</p></article><article><span>喜欢的音乐</span><strong>{library.stats.favoriteTracks}<small> 首</small></strong></article></div><section className="home-section"><div className="section-heading"><h2>常听艺术家</h2></div>{topArtists.length ? <div className="artist-ranking">{topArtists.map((item, index) => <button key={item.id} onClick={() => openedArtist(item)}><span>{String(index + 1).padStart(2, '0')}</span><Artwork url={item.coverUrl} className="round" /><div><strong>{item.name}</strong><div className="ranking-bar"><i style={{ width: `${item.count / topArtists[0].count * 100}%` }} /></div></div><small>{item.count} 次</small></button>)}</div> : <Empty title="还没有听歌统计" />}</section></>}
      {view.kind === 'trash' && (trash.length ? <div className="trash-list">
        <div className="trash-heading"><span>曲目</span><span className="playlist-cell">歌单</span><span /></div>
        {trash.map(track => <article key={track.id}>
          <Artwork url={track.coverUrl} /><div className="trash-track"><strong>{track.title}</strong><p>{track.artist} · {track.album}</p><small>{date(track.deletedAt || '')} 移入</small></div>
          <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={trashMemberships.get(track.id)} onOpen={() => setPlaylistTrack(track)} /></div>
          <button className="button secondary" onClick={() => { void restoreTrack(track); }}>恢复</button>
        </article>)}
      </div> : <Empty title="回收站为空" />)}
      </div>}
    </main>
    <PlayerBar player={player} panel={panel} onQueue={() => showPanel('queue')} onLyrics={() => showPanel('lyrics')} onMore={setTrackActions} collectionNavigation={collectionNavigation} />
    {panel === 'queue' && <QueuePanel player={player} playlistMemberships={playlistMemberships} showPlaylists={setPlaylistTrack} onClose={() => setPanel(null)} onSave={ids => setPlaylistEditor({ ids })} onMore={setTrackActions} collectionNavigation={collectionNavigation} />}
    {panel === 'lyrics' && <LyricsPanel player={player} onClose={() => setPanel(null)} onEdit={track => { void openEditor(track); }} onAdjust={adjustLyrics} />}
    {filtersOpen && view.kind === 'library' && <LibraryFilterModal value={libraryFilters} tracks={library.tracks} playlistMemberships={playlistMemberships} query={query} onClose={() => setFiltersOpen(false)} onApply={setLibraryFilters} />}
    {uploadOpen && <UploadModal uploader={uploader} playlist={uploadPlaylist} onClose={() => setUploadOpen(false)} onLocate={id => { void locateUpload(id); }} />}
    {editing && <TrackEditor key={editing.id} track={editing} onClose={() => setEditing(undefined)} onSaved={async track => { setLibrary(old => ({ ...old, tracks: old.tracks.map(item => item.id === track.id ? track : item) })); await refresh(); notify('已写回音频文件'); }} />}
    {bulkEditing && <BulkEditor tracks={bulkEditing} onClose={() => setBulkEditing(undefined)} onRefresh={refresh} onSaved={() => notify(`已更新 ${bulkEditing.length} 首曲目`)} />}
    {playlistEditor && <PlaylistEditor playlist={playlistEditor.playlist} initialIds={playlistEditor.ids} onClose={() => setPlaylistEditor(undefined)} onSaved={async playlist => { await refresh(); navigate({ kind: 'playlist', id: playlist.id }); notify('歌单已保存'); }} />}
    {albumActions && <Modal title={`${albumActions.title} · 专辑操作`} onClose={() => setAlbumActions(undefined)}><div className="modal-body track-action-menu">
      <button disabled={!albumActionTracks.length} onClick={() => { player.enqueue(albumActionTracks.map(track => track.id), true); setAlbumActions(undefined); }}><Play size={18} />接下来播放</button>
      <button disabled={!albumActionTracks.length} onClick={() => { player.enqueue(albumActionTracks.map(track => track.id)); setAlbumActions(undefined); }}><ListMusic size={18} />加入播放队列</button>
      <button disabled={!albumActionTracks.length} onClick={() => { setAddPlaylistIds(albumActionTracks.map(track => track.id)); setAlbumActions(undefined); }}><Plus size={18} />加入歌单</button>
      <button disabled={!albumActionTracks.length} onClick={() => { setBulkEditing(albumActionTracks); setAlbumActions(undefined); }}><Settings2 size={18} />批量编辑</button>
      <button onClick={() => { openedAlbum(albumActions); setAlbumActions(undefined); }}><Disc3 size={18} />查看专辑</button>
    </div></Modal>}
    {playlistTrack && <Modal title="所属歌单" onClose={() => setPlaylistTrack(undefined)}><div className="modal-body joined-playlists">
      <div className="joined-track"><Artwork url={playlistTrack.coverUrl} /><div><strong>{playlistTrack.title}</strong><p>{playlistTrack.artist}</p></div><span>{joinedPlaylists.length} 个歌单</span></div>
      {joinedPlaylists.length ? joinedPlaylists.map(item => <button key={item.id} onClick={() => { setPlaylistTrack(undefined); setPanel(null); navigate({ kind: 'playlist', id: item.id }); }}>
        {item.kind === 'smart' ? <Settings2 size={18} /> : <ListMusic size={18} />}<span>{item.name}<small>{item.kind === 'smart' ? '智能歌单' : '普通歌单'}</small></span><ChevronRight size={16} />
      </button>) : <p className="muted">未加入歌单</p>}
    </div></Modal>}
    {addPlaylistIds && <Modal title="加入歌单" onClose={() => setAddPlaylistIds(undefined)}><div className="modal-body add-playlist-list">{library.playlists.filter(item => item.kind === 'manual').map(item => <button key={item.id} onClick={() => { void run(async () => { await json(`/playlists/${encodeURIComponent(item.id)}`, 'PUT', { name: item.name, description: item.description, trackIds: [...item.trackIds, ...addPlaylistIds.filter(id => !item.trackIds.includes(id))] }); await refresh(); setAddPlaylistIds(undefined); notify('已加入歌单'); }); }}><ListMusic size={18} /><span>{item.name}</span><Plus size={17} /></button>)}<button onClick={() => { setPlaylistEditor({ ids: addPlaylistIds }); setAddPlaylistIds(undefined); }}><Plus size={19} /><span>新建歌单</span></button></div></Modal>}
    {trackActions && <Modal title={`${trackActions.title} · 更多功能`} onClose={() => setTrackActions(undefined)}><div className="modal-body track-action-menu"><button onClick={() => { void favorite(trackActions); setTrackActions(undefined); }}><Heart size={18} fill={trackActions.favorite ? 'currentColor' : 'none'} />{trackActions.favorite ? '取消收藏' : '收藏'}</button><button onClick={() => { player.enqueue([trackActions.id], true); setTrackActions(undefined); }}><Play size={18} />下一首播放</button><button onClick={() => { player.enqueue([trackActions.id]); setTrackActions(undefined); }}><ListMusic size={18} />加入播放队列</button><button onClick={() => { setAddPlaylistIds([trackActions.id]); setTrackActions(undefined); }}><Plus size={18} />加入歌单</button>{view.kind === 'playlist' && playlist?.kind === 'manual' && <button onClick={() => { void run(async () => { await json(`/playlists/${encodeURIComponent(playlist.id)}`, 'PUT', { name: playlist.name, description: playlist.description, trackIds: playlist.trackIds.filter(id => id !== trackActions.id) }); setTrackActions(undefined); await refresh(); notify('已从歌单移除'); }); }}><X size={18} />从歌单移除</button>}<button onClick={() => { void openEditor(trackActions); }}><Settings2 size={18} />编辑曲目</button><a href={trackURL(trackActions.id, 'download')}><Download size={18} />下载原文件</a><button className="danger" onClick={() => { void moveToTrash(trackActions); }}><Trash2 size={18} />移入回收站</button></div></Modal>}
    {player.conflict && <Modal title="其他标签页正在播放" onClose={() => player.setConflict(false)}><div className="modal-body"><p>在此标签页播放，将暂停另一个标签页。</p></div><footer className="modal-footer"><button className="button secondary" onClick={() => player.setConflict(false)}>取消</button><button className="button primary" onClick={() => player.play(true)}>在此播放</button></footer></Modal>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>;
}
