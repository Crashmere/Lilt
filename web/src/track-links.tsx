import { Fragment, type ReactNode } from 'react';
import type { Track, View } from './types';

export type CollectionNavigation = {
  artistIds: Map<string, string>;
  albumIds: Map<string, string>;
  open: (view: View) => void;
};

function CollectionLink({ kind, id, label, children, navigation }: { kind: 'artist' | 'album'; id?: string; label: string; children: ReactNode; navigation: CollectionNavigation }) {
  if (!id) return <span>{children}</span>;
  return <a className="metadata-link" href={`#${kind}/${encodeURIComponent(id)}`} aria-label={label} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigation.open({ kind, id });
  }}>{children}</a>;
}

export function ArtistLinks({ credit, navigation }: { credit: string; navigation: CollectionNavigation }) {
  const names = credit.split('/').map(name => name.trim()).filter(Boolean);
  if (!names.length) return <span>未知艺术家</span>;
  return <span className="artist-links">{names.map((name, index) => <Fragment key={`${name}-${index}`}>
    {index > 0 && ' / '}
    <CollectionLink kind="artist" id={navigation.artistIds.get(name)} label={`查看艺术家 ${name}`} navigation={navigation}>{name}</CollectionLink>
  </Fragment>)}</span>;
}

export function AlbumLink({ track, navigation }: { track: Track; navigation: CollectionNavigation }) {
  const title = track.album || '未归入专辑';
  return <CollectionLink kind="album" id={navigation.albumIds.get(track.id)} label={`查看专辑 ${title}`} navigation={navigation}>{title}</CollectionLink>;
}

function omitsArtist(track: Track, hideArtist?: string): boolean {
  if (!hideArtist) return false;
  const names = track.artist.split('/').map(name => name.trim()).filter(Boolean);
  return names.length === 1 && names[0] === hideArtist;
}

export function hasTrackCredits(track: Track, hideArtist?: string, hideAlbum?: boolean): boolean {
  return !omitsArtist(track, hideArtist) || !hideAlbum;
}

export function TrackCredits({ track, navigation, albumClassName, hideArtist, hideAlbum }: { track: Track; navigation: CollectionNavigation; albumClassName?: string; hideArtist?: string; hideAlbum?: boolean }) {
  const showArtist = !omitsArtist(track, hideArtist);
  const showAlbum = !hideAlbum;
  if (!showArtist && !showAlbum) return null;
  if (showArtist && !showAlbum) return <ArtistLinks credit={track.artist} navigation={navigation} />;
  if (!showArtist) return <span className={albumClassName}><AlbumLink track={track} navigation={navigation} /></span>;
  return <><ArtistLinks credit={track.artist} navigation={navigation} /><span className={albumClassName}> · <AlbumLink track={track} navigation={navigation} /></span></>;
}
