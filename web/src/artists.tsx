import { ListMusic, MoreHorizontal, Play, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Artwork, Empty, Pill } from './components';
import type { Album, Artist, Library, Track } from './types';
import { longDuration, matches } from './utils';

type ArtistBrowserProps = {
  library: Library; artistId?: string; query: string; tag: string; loading: boolean;
  onSelect: (artist: Artist) => void; onTag: (tag: string) => void; onRefresh: () => void;
  onPlay: (tracks: Track[]) => void; onEnqueue: (ids: string[]) => void;
  onOpenAlbum: (album: Album) => void; onAlbumActions: (album: Album) => void;
  renderTracks: (tracks: Track[]) => ReactNode;
};

export function ArtistBrowser({ library, artistId, query, tag, loading, onSelect, onTag, onRefresh, onPlay, onEnqueue, onOpenAlbum, onAlbumActions, renderTracks }: ArtistBrowserProps) {
  const trackIndex = new Map(library.tracks.map(track => [track.id, track]));
  const artists = library.artists.filter(artist => !query || artist.trackIds.some(id => {
    const track = trackIndex.get(id);
    return track && matches(track, query);
  }));
  const artist = artistId ? library.artists.find(item => item.id === artistId) : artists[0];
  const artistIds = new Set(artist?.trackIds);
  const groups = library.albums
    .map(album => ({ album, tracks: album.trackIds.map(id => trackIndex.get(id)).filter((track): track is Track => !!track && artistIds.has(track.id) && matches(track, query) && (!tag || track.tags?.includes(tag))) }))
    .filter(group => group.tracks.length)
    .sort((a, b) => b.album.year - a.album.year || a.album.title.localeCompare(b.album.title, 'zh-CN') || a.album.id.localeCompare(b.album.id));
  const tracks = groups.flatMap(group => group.tracks);

  return <div className="artist-browser">
    <aside className="artist-directory" aria-label="艺术家列表">
      <header><h2>艺术家</h2><span>{artists.length} 位</span></header>
      <div className="artist-directory-scroll">
        {artists.map(item => <button key={item.id} className={`artist-entry ${artist?.id === item.id ? 'active' : ''}`} aria-current={artist?.id === item.id ? 'true' : undefined} onClick={() => onSelect(item)}>
          <Artwork url={item.coverUrl} className="round" /><span><strong>{item.name}</strong><small>{item.albumCount} 张专辑 · {item.trackCount} 首</small></span>
        </button>)}
        {!artists.length && <Empty title={query ? '没有匹配的艺术家' : '还没有艺术家'} text={query ? '试试其他关键词' : '上传音乐后即可查看'} />}
      </div>
    </aside>
    <section className="artist-discography" key={artist?.id || 'empty'} aria-label={artist ? `${artist.name}的专辑和歌曲` : '专辑和歌曲'}>
      {artist ? <>
        <header className="artist-detail-heading">
          <div><h1>{artist.name}</h1><p>{groups.length} 张专辑 · {tracks.length} 首 · {longDuration(tracks.reduce((sum, track) => sum + track.duration, 0))}</p></div>
          <div className="heading-actions">
            <button className="button primary" disabled={!tracks.length} onClick={() => onPlay(tracks)}><Play size={17} fill="currentColor" />播放</button>
            <button className="icon-button" aria-label="加入队列" title="加入队列" disabled={!tracks.length} onClick={() => onEnqueue(tracks.map(track => track.id))}><ListMusic size={19} /></button>
            <button className="icon-button" aria-label="刷新音乐库" onClick={onRefresh} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button>
          </div>
        </header>
        {library.tags.length > 0 && <div className="library-tools"><div className="tag-filters"><Pill active={!tag} onClick={() => onTag('')}>全部</Pill>{library.tags.map(item => <Pill key={item} active={tag === item} onClick={() => onTag(tag === item ? '' : item)}>{item}</Pill>)}</div></div>}
        {groups.map(({ album, tracks }) => <article className="artist-album" key={album.id}>
          <Artwork url={album.coverUrl} title={album.title} className="artist-album-cover" />
          <div className="artist-album-content">
            <header className="artist-album-heading">
              <div><div className="artist-album-title"><h2>{album.title || '未命名专辑'}</h2><button className="icon-button album-page-link" aria-label={`查看专辑 ${album.title}`} title="查看专辑" onClick={() => onOpenAlbum(album)}><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false"><path d="M6.5 3.75 11.75 9 6.5 14.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div><p>{album.year || '年份未填写'} · {tracks.length} 首</p></div>
              <div className="artist-album-actions"><button className="icon-button" aria-label={`播放专辑 ${album.title}`} onClick={() => onPlay(tracks)}><Play size={18} fill="currentColor" /></button><button className="icon-button" aria-label={`${album.title} 专辑操作`} aria-haspopup="dialog" title="专辑操作" onClick={() => onAlbumActions(album)}><MoreHorizontal size={20} /></button></div>
            </header>
            {renderTracks(tracks)}
          </div>
        </article>)}
        {!groups.length && <Empty title="没有匹配的曲目" text="试试其他关键词或标签" />}
      </> : <Empty title={artistId ? '此艺术家已不存在' : '选择艺术家查看专辑'} text={artists.length ? '从艺术家列表中选择' : '上传音乐或更换搜索关键词'} />}
    </section>
  </div>;
}
