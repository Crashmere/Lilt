import type { Playlist } from './types';

export type PlaylistMemberships = Map<string, Playlist[]>;

export function indexPlaylistMemberships(playlists: Playlist[]): PlaylistMemberships {
  const memberships: PlaylistMemberships = new Map();
  for (const playlist of playlists) {
    for (const id of playlist.trackIds) {
      const joined = memberships.get(id);
      if (joined) joined.push(playlist);
      else memberships.set(id, [playlist]);
    }
  }
  return memberships;
}
