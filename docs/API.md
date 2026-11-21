# Lilt Browser API

All production business routes are under `/lilt/api/` and protected by shared device authentication. The program also exposes direct `/healthz`. Timestamps are RFC 3339 strings, identifiers are opaque strings and JSON fields use camelCase. Mutating routes reject untrusted cross-origin requests. Error responses use `{ "error": "message" }`.

## Data Shapes

`Track`: `id`, `title`, `artist`, `album`, `albumArtist`, `genre`, `year`, `trackNumber`, `discNumber`, `duration`, `size`, `format` (audio codec), `container`, `mimeType` (original container MIME), optional generated `searchText` (normalized names, tags, aliases, full pinyin and initials), `bitrate`, `sampleRate`, `bitDepth`, `channels`, `originalName`, `version`, `tags: string[]`, `aliases: string[]`, `favorite`, `coverUrl`, `hasLyrics`, optional `lyricsText`, `playCount`, `playedSeconds`, `lastPlayedAt`, `addedAt`, `updatedAt`, optional `deletedAt`.

`Album`: `id`, `title`, `artist`, `year`, `coverUrl`, `trackCount`, `duration`, `trackIds: string[]`.

`Artist`: `id`, `name`, `coverUrl`, `trackCount`, `albumCount`, `trackIds: string[]`.

`Playlist`: `id`, `name`, `description`, `kind` (`manual` or `smart`), `rules`, `trackIds: string[]`, `coverUrl`, `createdAt`, `updatedAt`. Smart rules support optional `favorite`, `tags: string[]`, `artist`, `genre`, `yearFrom`, `yearTo`, `unplayed`, `unheardDays`, `limit`.

`Stats`: `totalTracks`, `totalAlbums`, `totalArtists`, `totalDuration`, `totalBytes`, `favoriteTracks`, `playedSeconds`, `playCount`.

`Upload`: `id`, `filename`, `size`, `offset`, `fingerprint`, `status`, optional `trackId`, optional `duplicate`.

`PlayerState`: `deviceId`, `label`, `trackId`, `position`, `queueIds: string[]`, `queueIndex`, `shuffle`, `repeat` (`off`, `all`, `one`), `volume`, `updatedAt`.

## Library and Media

- `GET /api/library` returns `{ tracks, albums, artists, playlists, tags, stats }` for non-deleted tracks.
- `GET /api/tracks` returns `{ tracks }`, with optional `q`, `favorite`, `tag`, `album`, `artist`, `trash` filters.
- `GET /api/tracks/{id}` returns `{ track }`, including `lyricsText`.
- `PATCH /api/tracks/{id}` accepts editable metadata, `tags`, `aliases`, `favorite`, `version` and `lyricsText`; returns `{ track }`.
- `DELETE /api/tracks/{id}` moves the track to trash. `POST /api/tracks/{id}/restore` restores it.
- `GET /api/tracks/{id}/stream?quality=original|standard|compact` serves range-capable audio and supports `HEAD`. Compatible playback is generated separately from originals. `X-Lilt-Quality`, `X-Lilt-Format`, `X-Lilt-Bitrate` (bits per second), `X-Lilt-Sample-Rate` and `X-Lilt-Channels` describe the selected playback output rather than the source when encoded. The first compatible `HEAD` or `GET` can trigger generation.
- `GET /api/tracks/{id}/download` downloads original bytes.
- `GET /api/tracks/{id}/cover` serves safe cover artwork. `POST` accepts a multipart file field `file` to replace artwork.
- `GET /api/albums/{id}` returns `{ album, tracks }`.
- `GET /api/artists/{id}` returns `{ artist, tracks, albums }`.
- `GET /api/export` downloads catalog metadata, playlists and listening history as JSON; it is a portability export, not a backup/restore service.

## Resumable Audio Uploads

- `GET /api/uploads` returns `{ uploads }` for retained incomplete sessions.
- `POST /api/uploads` accepts `{ filename, size, fingerprint, relativePath? }`. The fingerprint is the complete SHA-256 hex. Existing exact files, including tracks in trash, return an upload with `duplicate: true` and the existing `trackId`; an active track is preferred when several tracks reference those bytes. This does not restore a trashed track or create a second logical copy. Retained incomplete sessions return the authoritative offset.
- `PATCH /api/uploads/{id}` accepts at most 32 MiB of raw bytes with `Upload-Offset`. It returns `{ upload }` only after durable acknowledgment. A stale offset returns 409 with `{ error, offset, upload }` containing the authoritative offset.
- `POST /api/uploads/{id}/complete` accepts optional `{ replaceTrackId }`, verifies the complete SHA-256, reads local metadata, checks initial audio decodability and returns `{ track, duplicate }`. Invalid files retain acknowledged staging for cancellation or retry. Duplicate sessions also have a completion endpoint; a returned duplicate track can have `deletedAt`. Replacement is explicit and preserves the target ID, metadata, artwork, favorites, playlist membership and listening history while retaining previous immutable original objects.
- `DELETE /api/uploads/{id}` cancels an incomplete upload and its temporary bytes only.

The browser uploads audio first and associates manually supplied artwork/lyrics through the track endpoints. Directory structure and filenames are fallback metadata, never external lookup keys.

## Playlists, History and Player State

- `POST /api/playlists` accepts `{ name, description?, kind?, rules?, trackIds? }`; returns `{ playlist }`.
- `GET /api/playlists/{id}` returns `{ playlist, tracks }`.
- `PUT /api/playlists/{id}` updates name, description, rules and ordered track IDs; returns `{ playlist }`.
- `DELETE /api/playlists/{id}` removes the playlist, not its tracks.
- `GET /api/playlists/{id}/export` downloads an M3U playlist using original filenames.
- `POST /api/history` accepts `{ trackId, sessionId, seconds, completed? }`. Seconds are cumulative actual listening time for that session; repeated updates are idempotent. Each session contributes one `playCount` after completion or listening for `min(30 seconds, half the source duration at the session's first accepted update)`. Qualification is durable and monotonic: audio replacement cannot remove an already-counted play, and later cumulative updates can qualify an initially short session. Any positive listening time excludes a track from the smart `unplayed` rule.
- `GET /api/history` returns `{ history }` with recent listening sessions. Each entry contains `id`, `trackId`, `sessionId`, `seconds`, `completed`, `playedAt` (session start), and `updatedAt`.
- `GET /api/player-states` returns `{ states }`.
- `PUT /api/player-states/{deviceId}` stores the browser's player snapshot and returns `{ state }`.

API routes are implemented and documented together. Extend this contract only when the corresponding server and browser behavior is present.
