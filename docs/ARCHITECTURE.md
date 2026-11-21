# Architecture

Lilt combines a manually supplied music library with a persistent browser player. A static Go program embeds the React frontend and uses one application-owned SQLite catalog. `nas` is the authoritative application and data host; `ali` and `vps` are authenticated gateways, not independent libraries.

## Original Preservation and Library State

Audio uploads are immutable, SHA-256-addressed objects. Display metadata, favorites, tags, lyrics, playlists and listening history live in the catalog rather than being written back into audio tags. Embedded artwork remains inside the uploaded audio. Accepted manual artwork is preserved separately under the original-object tree; the displayed cover is a sanitized JPEG derivative.

Exact bytes and musical versions have different meanings. Reuploading the same audio identifies an existing file without silently changing its metadata. A live recording, remaster or alternate mix can remain a separate track with its own version label. Explicit replacement changes the audio attached to an existing logical track while retaining its ID, favorites, playlist references and listening history. Previously accepted immutable objects are retained; replacement is not a storage purge.

Import reads local audio tags through FFprobe. Missing titles and track numbers may fall back to the filename; missing album and artist may fall back to supplied relative directory names. Album artist is distinct from track artist, so compilation albums can remain together. Browsing derives album and artist groups from catalog metadata and preserves disc/track order. Search includes descriptive fields, aliases and Chinese pinyin; no external source is consulted.

Manual playlists store ordered track IDs. Smart playlists evaluate catalog rules such as favorites, tags, artist, genre, year and listening recency. A playback queue is a snapshot independent of those collections: editing a playlist does not replace an already playing queue. Moving a track to trash changes catalog visibility and is reversible; it does not unlink its audio or artwork.

## Durable Uploads and Playback

Each upload has a retained session and acknowledged offset in SQLite, with partial bytes under `uploads/`. The server accepts at most 32 MiB per raw chunk, flushes accepted bytes before acknowledgment and checks the complete SHA-256 before publishing an original. Resume follows the server's offset rather than a browser estimate. Canceling an incomplete upload removes only that session's partial bytes. The [API](API.md#resumable-audio-uploads) defines request and conflict behavior.

The browser player streams accepted original audio bytes, with no playback-file selector or automatic transcoding fallback. Unsupported original formats require a browser that can decode them. Offline saves also retain originals; older compatible caches must be saved again while connected before offline playback. The API retains standard and compact requests for separate AAC/M4A derivatives at nominal 192 kbit/s and 96 kbit/s, respectively, with at most two channels and a 48 kHz sample-rate ceiling. Those outputs are reused by source fingerprint and quality. One CPU encoding operation runs at a time; FFmpeg probing and audio encoding do not require the shared NVIDIA image runtime.

Streams and original downloads support byte ranges. The response identifies the selected playback quality separately from the source audio's properties. Having a lossless original does not imply that a compatible AAC stream or the browser/device output path is lossless.

The first compatible request may wait for encoding. Uploaded files are constrained to locally decoded audio formats; media commands disable network protocols and do not execute user-selected commands. Safe static artwork is served in place of uploaded active content.

## Browser Continuity and Storage

The player remains mounted while library views, search results, dialogs and playlists update. Its queue, current track, position, repeat/shuffle preferences and volume are saved without requesting audible playback on page startup. Starting or continuing playback is an explicit user action and remains subject to browser autoplay rules.

The player and library-row ellipsis buttons open one shared song-specific More Features menu. Additional song operations belong in this menu.

Each browser maintains its own device identifier and player snapshot. Library data and playlists are shared through the server; another browser's saved snapshot is offered for explicit continuation rather than automatic takeover. Same-origin tabs coordinate playback locally. This does not create a guaranteed cross-Origin or cross-device remote-control channel.

Listening updates use a session identifier and cumulative actual listening time so retries do not add the same seconds again. Offline pending updates remain browser-local until they can be sent to the server. Saved browser state and offline audio are not part of NAS data recovery until their corresponding server records have synchronized.

Optional offline audio and the last saved library are stored in IndexedDB. A scoped service worker supports reopening the previously visited application shell; it does not intercept authenticated business APIs or create a public media endpoint. The browser or user can remove local storage, and another device does not automatically receive those files. Offline storage is a convenience, not a permanent recovery copy.

Media Session actions integrate with lock-screen and headset controls when supported. Home Screen installation changes the launch experience, not operating-system background execution guarantees. Background track changes and cross-tab coordination remain subject to browser suspension. Ordinary Tab/Shift+Tab traversal and focus-only decoration follow the user's shared keyboard policy while preserving text input, selections, carets, IME composition and modifier shortcuts.

## Access and Resource Ownership

ServerPortal protects production pages, scripts, APIs, streams and uploaded media. Lilt validates mutating browser requests against the privately configured HTTPS Origin set and the forwarded request Host. Nginx preserves the `/lilt/` prefix and full Host, including the VPS port, and inherits shared authentication/cookie-renewal headers.

Only exact GET/HEAD branding paths and the public manifest bypass authentication. The service has no separate account roles, social sharing or navigation back to Portal. `deploy/portal.json` declares the application-owned database, original objects, durable uploads, covers, playback derivatives and operational resources.

Full external backup and recovery belong to the server-operations agent. Rebuildable derivative labels in Portal do not exclude stored covers or playback files from that full scope. The current catalog check validates SQLite integrity/schema and referenced original existence and size; it is not a complete cryptographic rehash of the original tree.
