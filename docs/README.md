# Lilt Documentation

Lilt manages a manually supplied personal music collection and plays it in ordinary desktop and mobile browsers. The active application target is `nas`; `ali` and `vps` provide authenticated public entrances.

- [API](API.md): application data shapes and browser-facing endpoints.
- [Architecture](ARCHITECTURE.md): audio metadata writeback, library organization, playback and browser state.
- [Lyrics](LYRICS.md): workbench editing, manual/model calibration, drafts and candidate review.
- [Operations](OPERATIONS.md): runtime, resources, restricted releases and Portal registration.

ServerPortal owns shared device authentication. The server-operations skill owns host inventory, shared forwarding and agent-only backup/recovery.
