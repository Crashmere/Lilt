# Lilt Maintenance Entry Point

Lilt is a single-user, browser-only music library and player. All music, artwork, lyrics and descriptive content are supplied by the owner. The application runs on `nas`; `ali` and `vps` are authenticated gateways to the same data. The brand and source repository are `Lilt`; application paths, runtime identities and units use `lilt`.

Read `docs/README.md`, `docs/API.md` and `docs/OPERATIONS.md` as relevant. Use server-operations and explicitly read the target host's remote `/opt/AGENTS.md` before server work. Production activation is recorded in server-operations current-state.

- Metadata edits write tags, lyrics and artwork back into the current audio without re-encoding its sound or retaining edit revisions. Validate staged output before publication, recover interrupted publication and remove only superseded unreferenced audio. Display covers and compatible playback remain derivatives. Do not fetch music, artwork, lyrics, fonts or descriptive data from external services at runtime.
- Keep duplicate files separate from musical versions. Replacement is explicit and preserves the logical track's favorites, playlist membership and history.
- Use one SQLite catalog and application-owned data directories. Keep resumable uploads durable, reconcile authoritative offsets and verify the complete SHA-256 before publication.
- Keep the global player mounted during navigation and data updates. Playlists describe collections; the current queue is an independent snapshot. Restore browser state without automatic audible playback.
- Share library data and playlists across authorized devices; retain queues and progress in each browser. Same-origin tabs coordinate playback locally.
- Ordinary browser use is the baseline. Audio streams from the server; system media controls and shell caching are conditional enhancements. Do not claim permanent browser storage or unlimited background execution.
- Block ordinary Tab/Shift+Tab focus traversal and remove focus-only decoration. Preserve text input, carets, selections, IME composition and modifier shortcuts.
- Product UI is concise Chinese with the English Lilt brand. Do not add decorative explanatory copy, implementation notes, promotional slogans or links/actions returning to ServerPortal. Empty-state and error text must communicate an actionable state.
- Reuse the shared authentication, restricted release, Portal declaration and icon contracts. Public exceptions are limited to exact brand assets; media and business APIs remain authenticated.
- Build locally into a static Linux amd64 Go program with embedded frontend assets. Do not install build runtimes or containers on `nas`.
- Validate representative upload, playback, playlist and browser-state behavior in an isolated synthetic environment. Do not retain permanent test suites by default.
- Keep public GitHub source free of music, runtime databases, private configuration, credentials, production addresses and backups.
- Full backup and recovery belong to the server-operations agent, not to the player UI. Maintain complete resource declarations for originals, derivatives, uploads and the database.
- Write specifications, maintenance documents and script help in English. Preserve Chinese product labels and user content.

Remote entry points: `/opt/lilt/AGENTS.md`, `/opt/lilt/docs/README.md`, and `/opt/server-context/`.
