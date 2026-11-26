import { useState } from 'react';
import { Check } from 'lucide-react';
import { Artwork, Empty, Pill, TrackPlaylists } from './components';
import type { PlaylistMemberships } from './playlist-memberships';
import { TrackCredits, type CollectionNavigation } from './track-links';
import type { Album, Artist, HistoryEntry, Library, Track } from './types';
import { bytes } from './utils';

const DAY = 86400000;

function formatListenSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
  }
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

function startOfDay(time: number): number { const value = new Date(time); value.setHours(0, 0, 0, 0); return value.getTime(); }

function groupLabel(playedAt: number, today: number): string {
  const day = startOfDay(playedAt);
  if (day >= today) return '今天';
  if (day >= today - DAY) return '昨天';
  if (day >= today - 6 * DAY) return '近 7 天';
  const value = new Date(playedAt);
  return `${value.getFullYear()} 年 ${value.getMonth() + 1} 月`;
}

function clock(time: number, label: string): string {
  const value = new Date(time);
  const hm = value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return label === '今天' || label === '昨天' ? hm : `${value.getMonth() + 1}月${value.getDate()}日 ${hm}`;
}

export function HistoryView({ history, tracks, playlistMemberships, collectionNavigation, onPlay, onShowPlaylists }: {
  history: HistoryEntry[]; tracks: Track[]; playlistMemberships: PlaylistMemberships; collectionNavigation: CollectionNavigation;
  onPlay: (track: Track) => void; onShowPlaylists: (track: Track) => void;
}) {
  const [hideShort, setHideShort] = useState(true);
  const [completedOnly, setCompletedOnly] = useState(false);
  if (!history.length) return <Empty title="还没有听歌记录" />;
  const trackMap = new Map(tracks.map(track => [track.id, track]));
  const visible = history.filter(entry => completedOnly ? entry.completed : !hideShort || entry.completed || entry.seconds >= 30);
  const today = startOfDay(Date.now());
  const groups: { label: string; items: { entry: HistoryEntry; time: number }[] }[] = [];
  for (const entry of visible) {
    const time = Date.parse(entry.playedAt);
    const label = groupLabel(time, today);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push({ entry, time });
    else groups.push({ label, items: [{ entry, time }] });
  }
  return <>
    <div className="library-tools history-tools">
      <div className="tag-filters">
        <Pill active={hideShort && !completedOnly} onClick={() => { setCompletedOnly(false); setHideShort(old => !old); }}>隐藏短播（&lt;30 秒）</Pill>
        <Pill active={completedOnly} onClick={() => setCompletedOnly(old => !old)}>仅看完整播放</Pill>
      </div>
      <span className="history-summary muted">显示 {visible.length} / {history.length} 条记录</span>
    </div>
    {visible.length ? <div className="history-groups">
      <div className="history-heading"><span>曲目</span><span className="playlist-cell">歌单</span><span>聆听时长</span><span>播放时间</span><span>完播</span></div>
      {groups.map(group => <section className="history-group" key={group.label}>
        <header className="history-group-head"><h3>{group.label}</h3><span>{group.items.length} 条</span></header>
        <div className="history-list">
          {group.items.map(({ entry, time }) => {
            const track = trackMap.get(entry.trackId);
            return <article key={entry.id} className={track ? '' : 'is-missing'}>
              <Artwork url={track?.coverUrl} />
              <div className="history-track"><button onClick={() => { if (track) onPlay(track); }} disabled={!track}><strong>{track?.title || '曲目已移入回收站'}</strong></button>{track && <p><TrackCredits track={track} navigation={collectionNavigation} /></p>}</div>
              <div className="playlist-cell" aria-label="歌单"><TrackPlaylists playlists={playlistMemberships.get(entry.trackId)} onOpen={() => { if (track) onShowPlaylists(track); }} /></div>
              <span>{formatListenSeconds(entry.seconds)}</span><time>{clock(time, group.label)}</time>
              <span className={`history-completed ${entry.completed ? 'is-done' : ''}`}>{entry.completed && <span title="完整播放"><Check size={16} /></span>}</span>
            </article>;
          })}
        </div>
      </section>)}
    </div> : <Empty title="没有符合条件的记录" text="试试关闭上方的筛选条件" />}
  </>;
}

type Range = 'all' | '30d' | '7d';
type Totals = { plays: number; seconds: number };

function percent(value: number, total: number): number { return total ? Math.round(value / total * 100) : 0; }

export function StatsView({ library, history, onOpenArtist, onOpenAlbum, onPlayTrack }: {
  library: Library; history: HistoryEntry[]; onOpenArtist: (artist: Artist) => void; onOpenAlbum: (album: Album) => void; onPlayTrack: (track: Track) => void;
}) {
  const [range, setRange] = useState<Range>('all');
  const { stats } = library;
  const trackMap = new Map(library.tracks.map(track => [track.id, track]));
  const totals = new Map<string, Totals>();
  if (range === 'all') {
    for (const track of library.tracks) if (track.playCount > 0 || track.playedSeconds > 0) totals.set(track.id, { plays: track.playCount, seconds: track.playedSeconds });
  } else {
    const since = Date.now() - (range === '30d' ? 30 : 7) * DAY;
    for (const entry of history) {
      if (Date.parse(entry.playedAt) < since) continue;
      const track = trackMap.get(entry.trackId);
      if (!track) continue;
      const item = totals.get(track.id) || { plays: 0, seconds: 0 };
      item.seconds += entry.seconds;
      if (entry.completed || entry.seconds >= Math.min(30, (track.duration || 60) / 2)) item.plays += 1;
      totals.set(track.id, item);
    }
  }
  const rangeSeconds = range === 'all' ? stats.playedSeconds : [...totals.values()].reduce((sum, item) => sum + item.seconds, 0);
  const rangePlays = range === 'all' ? stats.playCount : [...totals.values()].reduce((sum, item) => sum + item.plays, 0);
  const byScore = (a: Totals, b: Totals) => b.plays - a.plays || b.seconds - a.seconds;
  const topTracks = [...totals.entries()].filter(([, item]) => item.plays > 0).sort((a, b) => byScore(a[1], b[1])).slice(0, 10)
    .map(([id, item]) => ({ track: trackMap.get(id)!, ...item }));
  const artistTotals = new Map<string, Totals>();
  const albumTotals = new Map<string, Totals>();
  const albumOf = new Map(library.albums.flatMap(album => album.trackIds.map(id => [id, album.id] as const)));
  for (const [id, item] of totals) {
    const albumId = albumOf.get(id);
    if (albumId) { const old = albumTotals.get(albumId) || { plays: 0, seconds: 0 }; albumTotals.set(albumId, { plays: old.plays + item.plays, seconds: old.seconds + item.seconds }); }
  }
  for (const artist of library.artists) {
    let plays = 0; let seconds = 0;
    for (const id of artist.trackIds) { const item = totals.get(id); if (item) { plays += item.plays; seconds += item.seconds; } }
    if (plays > 0) artistTotals.set(artist.id, { plays, seconds });
  }
  const topArtists = library.artists.filter(item => artistTotals.has(item.id)).map(artist => ({ artist, ...artistTotals.get(artist.id)! })).sort(byScore).slice(0, 10);
  const topAlbums = library.albums.filter(item => (albumTotals.get(item.id)?.plays || 0) > 0).map(album => ({ album, ...albumTotals.get(album.id)! })).sort(byScore).slice(0, 6);
  const lyrics = { lrc: 0, txt: 0, none: 0 };
  const formats = new Map<string, number>();
  for (const track of library.tracks) {
    lyrics[track.lyricsType || (track.hasLyrics ? 'txt' : 'none')] += 1;
    const format = (track.format || '未知').toUpperCase();
    formats.set(format, (formats.get(format) || 0) + 1);
  }
  const sortedFormats = [...formats.entries()].sort((a, b) => b[1] - a[1]);
  const shownFormats = sortedFormats.slice(0, 5);
  const otherFormats = sortedFormats.slice(5).reduce((sum, [, count]) => sum + count, 0);
  if (otherFormats) shownFormats.push(['其他', otherFormats]);
  const total = library.tracks.length;
  const rangeName = range === 'all' ? '累计聆听' : range === '30d' ? '近 30 天聆听' : '近 7 天聆听';
  const mvCount = (library.mvs || []).length;
  const empty = <Empty title="还没有听歌统计" />;

  return <>
    <div className="stats-grid">
      <article><span>音乐收藏</span><strong>{stats.totalTracks}<small> 首</small></strong><p>{stats.totalAlbums} 张专辑 · {stats.totalArtists} 位艺术家{mvCount > 0 && ` · ${mvCount} MV`}</p></article>
      <article><span>{rangeName}</span><strong>{rangeSeconds >= 3600 ? (rangeSeconds / 3600).toFixed(1) : Math.round(rangeSeconds / 60)}<small>{rangeSeconds >= 3600 ? ' 小时' : ' 分钟'}</small></strong><p>{rangePlays} 次播放</p></article>
      <article><span>收藏时长</span><strong>{(stats.totalDuration / 3600).toFixed(1)}<small> 小时</small></strong><p>原文件 {bytes(stats.totalBytes)}</p></article>
      <article><span>喜欢的音乐</span><strong>{stats.favoriteTracks}<small> 首</small></strong><p>占曲库 {percent(stats.favoriteTracks, stats.totalTracks)}%</p></article>
    </div>
    <div className="library-tools stats-toolbar">
      <span className="muted">听歌排行范围</span>
      <div className="tag-filters">{([['all', '全部累计'], ['30d', '近 30 天'], ['7d', '近 7 天']] as const).map(([key, label]) => <Pill key={key} active={range === key} onClick={() => setRange(key)}>{label}</Pill>)}</div>
    </div>
    {topTracks.length ? <>
      <div className="stats-rankings">
        <section className="stats-card"><h2>常听艺术家</h2><div className="stats-rank-list">{topArtists.map(({ artist, plays }, index) => <button key={artist.id} className="stats-rank-row" onClick={() => onOpenArtist(artist)}>
          <span className="stats-rank-no">{String(index + 1).padStart(2, '0')}</span><Artwork url={artist.coverUrl} className="round" />
          <div><strong>{artist.name}</strong><div className="ranking-bar"><i style={{ width: `${plays / topArtists[0].plays * 100}%` }} /></div></div><small>{plays} 次</small>
        </button>)}</div></section>
        <section className="stats-card"><h2>常听曲目</h2><div className="stats-rank-list">{topTracks.map(({ track, plays }, index) => <button key={track.id} className="stats-rank-row" title="点击播放" onClick={() => onPlayTrack(track)}>
          <span className="stats-rank-no">{String(index + 1).padStart(2, '0')}</span><Artwork url={track.coverUrl} />
          <div><strong>{track.title}</strong><em>{track.artist}</em><div className="ranking-bar"><i style={{ width: `${plays / topTracks[0].plays * 100}%` }} /></div></div><small>{plays} 次</small>
        </button>)}</div></section>
      </div>
      {topAlbums.length > 0 && <section className="home-section"><div className="section-heading"><h2>常听专辑</h2></div><div className="stats-album-grid">{topAlbums.map(({ album, plays }) => <button key={album.id} className="stats-album" onClick={() => onOpenAlbum(album)}>
        <Artwork url={album.coverUrl} title={album.title} /><div><strong>{album.title || '未命名专辑'}</strong><em>{album.artist || '未知艺术家'}</em><small>{plays} 次播放</small></div>
      </button>)}</div></section>}
    </> : empty}
    <section className="home-section"><div className="section-heading"><h2>曲库分布</h2></div>
      <div className="stats-distribution">
        <div className="stats-card"><h3>歌词覆盖</h3>
          <div className="stats-stacked-bar" role="img" aria-label={`LRC ${lyrics.lrc}，文本 ${lyrics.txt}，无歌词 ${lyrics.none}`}><i className="lrc" style={{ width: `${percent(lyrics.lrc, total)}%` }} /><i className="txt" style={{ width: `${percent(lyrics.txt, total)}%` }} /><i className="none" style={{ flex: 1 }} /></div>
          <ul className="stats-legend">
            <li><i className="lrc" />逐行时间轴<span>{lyrics.lrc} 首 · {percent(lyrics.lrc, total)}%</span></li>
            <li><i className="txt" />纯文本歌词<span>{lyrics.txt} 首 · {percent(lyrics.txt, total)}%</span></li>
            <li><i className="none" />没有歌词<span>{lyrics.none} 首 · {percent(lyrics.none, total)}%</span></li>
          </ul>
        </div>
        <div className="stats-card"><h3>音频格式</h3>
          <div className="stats-format-list">{shownFormats.map(([format, count]) => <div className="stats-format-row" key={format}><span>{format}</span><div className="ranking-bar"><i style={{ width: `${percent(count, total)}%` }} /></div><small>{count} 首 · {percent(count, total)}%</small></div>)}</div>
        </div>
      </div>
    </section>
  </>;
}
