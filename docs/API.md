# Lilt Browser API

All production business routes are under `/lilt/api/` and protected by shared device authentication. The program also exposes direct `/healthz`. Timestamps are RFC 3339 strings, identifiers are opaque strings and JSON fields use camelCase. Mutating routes reject untrusted cross-origin requests. Error responses use `{ "error": "message" }`.

## Data Shapes

`Track`: `id`, `title`, `artist`, `album`, `albumArtist`, `genre`, `composer`, `lyricist`, `comment`, `copyright`, `isrc`, `bpm`, `year`, `trackNumber`, `discNumber`, `duration`, `size`, `format` (audio codec), `container`, `mimeType` (current audio container MIME), optional generated `searchText` (normalized names, credits, tags, aliases, full pinyin and initials), `bitrate`, `sampleRate`, `bitDepth`, `channels`, `originalName`, `version`, `tags: string[]`, `aliases: string[]`, `favorite`, `coverUrl`, `hasLyrics`, optional `lyricsText`, `playCount`, `playedSeconds`, `lastPlayedAt`, `addedAt`, `updatedAt`, optional `deletedAt`.

`Album`: `id`, `title`, `artist`, `year`, `coverUrl`, `trackCount`, `duration`, `trackIds: string[]`.

`Artist`: `id`, `name`, `coverUrl`, `trackCount`, `albumCount`, `trackIds: string[]`.

Artist groups split both `Track.artist` and `Track.albumArtist` on ASCII `/`, trim names and ignore empty or duplicate names per track. Original credit strings and album grouping remain unchanged. Artist filters and smart rules accept individual artist names/IDs as well as the original combined credits.

`Playlist`: `id`, `name`, `description`, `kind` (`manual` or `smart`), `rules`, `trackIds: string[]`, `coverUrl`, `createdAt`, `updatedAt`. Smart rules support optional `favorite`, `tags: string[]`, `artist`, `genre`, `yearFrom`, `yearTo`, `unplayed`, `unheardDays`, `limit`.

`Stats`: `totalTracks`, `totalAlbums`, `totalArtists`, `totalDuration`, `totalBytes`, `favoriteTracks`, `playedSeconds`, `playCount`. `totalBytes` sums current original-file sizes for non-deleted tracks.

`Upload`: `id`, `filename`, `size`, `offset`, `fingerprint`, `status`, optional `trackId`, optional `duplicate`.

## Library and Media

- `GET /api/library` returns `{ tracks, albums, artists, playlists, tags, stats }` for non-deleted tracks.
- `GET /api/tracks` returns `{ tracks }`, with optional `q`, `favorite`, `tag`, `album`, `artist`, `trash` filters. With `trash=true` or `trash=1`, it also returns `playlists`: ordinary playlists with `trackIds` resolved against all trashed tracks, preserving their retained membership. Smart playlists apply only to the active library and are omitted from this field.
- `GET /api/tracks/{id}` returns `{ track }`, including `lyricsText`.
- `PATCH /api/tracks/{id}` accepts `title`, `artist`, `album`, `albumArtist`, `genre`, `composer`, `lyricist`, `comment`, `copyright`, `isrc`, `bpm`, `year`, `trackNumber`, `discNumber`, `version`, `tags`, `aliases`, `lyricsText`, `removeCover` and `favorite`; returns `{ track }`. Metadata, lyrics and cover changes write back to the current audio without re-encoding its audio stream or creating edit revisions. Empty strings/arrays and numeric zero clear optional fields; title is required, and empty artist/album credits receive the library defaults. Year/disc number range is 0-9999, track number 0-99999, BPM 0-9999 and lyrics at most 1 MiB. `expectedUpdatedAt`, when supplied, must match the latest track timestamp; stale edits return 409. A favorite-only patch updates the catalog without rewriting audio. Files that cannot roundtrip all requested fields return 400 without replacing the current audio.
- `DELETE /api/tracks/{id}` moves the track to trash. `POST /api/tracks/{id}/restore` restores it.
- `GET /api/tracks/{id}/stream?quality=original|standard|compact` serves range-capable audio and supports `HEAD`. Compatible playback is generated separately from originals. `X-Lilt-Quality`, `X-Lilt-Format`, `X-Lilt-Bitrate` (bits per second), `X-Lilt-Sample-Rate` and `X-Lilt-Channels` describe the selected playback output rather than the source when encoded. The first compatible `HEAD` or `GET` can trigger generation.
- `GET /api/tracks/{id}/download` downloads the current audio, including saved tags, lyrics and artwork, using its supplied filename.
- `GET /api/tracks/{id}/cover` serves safe cover artwork. `POST` accepts a multipart file field `file` without a file-size or input-pixel ceiling and optional JSON text field `metadata` (at most 2 MiB) containing the same track patch. Supported images are JPEG, PNG, GIF and WebP. The server validates and proportionally downsizes artwork to at most 1600 pixels per side, applies image orientation, and does not upscale small images. Animated images supply their first frame. Both artwork and metadata are validated and written together; `removeCover` cannot accompany a replacement file. The cover becomes an embedded JPEG and a display derivative, without a separate retained upload copy. Uploads retain the 600-second body deadline; image normalization has a 90-second processing deadline.
- `GET /api/albums/{id}` returns `{ album, tracks }`.
- `GET /api/artists/{id}` returns `{ artist, tracks, albums }`.
- `GET /api/export` downloads catalog metadata, playlists and listening history as JSON; it is a portability export, not a backup/restore service.

## Resumable Audio Uploads

- `GET /api/uploads` returns `{ uploads }` for retained incomplete sessions.
- `POST /api/uploads` accepts `{ filename, size, fingerprint, relativePath?, replaceTrackId? }`. The fingerprint is the complete SHA-256 hex. A known current or pre-edit file hash, including a track in trash, returns an upload with `duplicate: true` and the existing `trackId` without transferring audio. An active track is preferred; within the same visibility state, a current-file match precedes a historical match. Duplicate uploads preserve the current audio and edited metadata, skip supplied cover/lyrics sidecars, and do not restore a trashed track or create a second logical copy. Historical hashes retain their own file sizes for validation, not old audio copies. Retained incomplete sessions return the authoritative offset. Supplying `replaceTrackId` prepares an explicit replacement using current-file matches only, so a removed historical file does not prevent transferring the selected replacement bytes.
- `PATCH /api/uploads/{id}` accepts at most 32 MiB of raw bytes with `Upload-Offset`. It returns `{ upload }` only after durable acknowledgment. A stale offset returns 409 with `{ error, offset, upload }` containing the authoritative offset.
- `POST /api/uploads/{id}/complete` accepts optional `{ replaceTrackId }`, verifies transferred bytes' complete SHA-256 and repeats current/historical duplicate detection; otherwise it reads local metadata and checks initial audio decodability before publishing audio. It returns `{ track, duplicate }`. A duplicate found at completion discards that session's partial file and returns the existing track unchanged. Invalid files retain acknowledged staging for cancellation or retry. Duplicate sessions also have a completion endpoint; a returned duplicate track can have `deletedAt`. Replacement is explicit and preserves the target ID, metadata, artwork, favorites, playlist membership and listening history while retaining previous immutable original objects. It starts a new hash-recognition lineage, so the retired audio and its metadata variants can still be uploaded as a separate version.
- `DELETE /api/uploads/{id}` cancels an incomplete upload and its temporary bytes only.

The browser reads complete file hashes in a worker and sends audio sequentially in chunks of up to 32 MiB with a 660-second request timeout. The queue accepts additional files during a batch and supports per-file pause, resume, retry and removal. Removing a queue item retains acknowledged server bytes; discarding a retained session requires confirmation. Reselecting a retained original verifies its expected hash before sending. Folder selection and supported directory drops preserve relative paths for metadata and sidecar matching.

Browser send progress is distinct from the server's acknowledged byte count. Transfer progress stops below 100% until complete-file verification, publication and sidecar writes finish. Transient chunk failures receive up to three retries with bounded backoff and a fresh authoritative session; failed or paused files can also be continued individually. Closing the panel does not stop the queue, and navigating away during active work prompts the browser's unload warning.

Opening uploads from a manual playlist binds that playlist to each newly selected or dropped audio file. After publication or active-library duplicate recognition, the browser appends the track to that playlist before applying sidecars. Closing the panel or changing views does not change queued destinations. Repeated selection of the same file for a different playlist creates a separate queue item without creating another library track. A failed playlist append retains the track receipt for an in-page retry without retransferring audio. Playlist destinations and completion receipts are browser-memory state and do not survive a page reload; reselecting an incomplete original from a playlist binds it to that playlist. Trash duplicates stay in trash and are not appended. Uploads outside manual playlist pages only enter the library; smart playlists continue to evaluate their rules.

The browser uploads audio first, then writes supplied lyrics and artwork together through the existing cover endpoint when both are present. It retains the published track receipt for an unfinished sidecar write, so an in-page retry completes those sidecars without reuploading or creating another track. Closing the panel retains that receipt; reloading the page loses it. The published audio remains in the library and sidecars can be added through its editor. Ordinary duplicates still skip sidecars. Directory structure and filenames are fallback metadata, never external lookup keys.

## Playlists and History

- `POST /api/playlists` accepts `{ name, description?, kind?, rules?, trackIds? }`; returns `{ playlist }`.
- `GET /api/playlists/{id}` returns `{ playlist, tracks }`.
- `PUT /api/playlists/{id}` updates supplied name, description, kind, rules and ordered `trackIds`; returns `{ playlist }`. Alternatively, `addTrackIds: string[]` appends only IDs not already present to an existing manual playlist, preserving current order, metadata and retained trash membership under the playlist-write lock. It cannot be combined with `trackIds` and is rejected for smart playlists. Repeated appends are membership-idempotent.
- `DELETE /api/playlists/{id}` removes the playlist, not its tracks.
- `GET /api/playlists/{id}/export` downloads an M3U playlist using original filenames.
- `POST /api/history` accepts `{ trackId, sessionId, seconds, completed? }`. Seconds are cumulative actual listening time for that session; repeated updates are idempotent. Each session contributes one `playCount` after completion or listening for `min(30 seconds, half the source duration at the session's first accepted update)`. Qualification is durable and monotonic: audio replacement cannot remove an already-counted play, and later cumulative updates can qualify an initially short session. Any positive listening time excludes a track from the smart `unplayed` rule.
- `GET /api/history` returns `{ history }` with recent listening sessions. Each entry contains `id`, `trackId`, `sessionId`, `seconds`, `completed`, `playedAt` (session start), and `updatedAt`.

API routes are implemented and documented together. Extend this contract only when the corresponding server and browser behavior is present.
