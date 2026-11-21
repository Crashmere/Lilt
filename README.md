# Lilt

Lilt is a personal music library and player for ordinary desktop and mobile browsers. The owner supplies all audio, artwork and lyrics; the service has no external music catalog, runtime metadata lookup or social features.

The application target is `nas`. Authenticated entrances on `ali` and `vps` reach the same library through the existing ServerPortal device authentication.

## Features

- Batch and directory uploads with durable resume, full-file SHA-256 verification and exact-file duplicate detection.
- Editable track metadata, Chinese pinyin and alias search, album/disc ordering, favorites and tags.
- Manual and rule-based playlists, an independent playback queue and explicit continuation from another browser.
- Original audio or separately generated standard/compact AAC playback, with Range-capable streams and original downloads.
- Owner-supplied covers and plain-text or timestamped lyrics, listening history and portable metadata/playlist exports.
- Reversible trash, preserved original bytes and explicit track replacement that retains the logical track's collection state.
- Optional browser-local offline storage, Home Screen branding and supported system media controls.

Offline storage and background playback depend on the browser and operating system. Restoring a saved queue never starts audible playback automatically.

## Local Use

Use Go 1.26.8 as pinned in `.go-version`, Node/npm and installed FFmpeg/FFprobe. Build tools run on the maintenance computer, not on `nas`; `go.mod` records the minimum language version.

```sh
npm --prefix web ci --no-audit --no-fund
make build
bin/lilt serve --addr 127.0.0.1:18089 --data .local/data --prefix /lilt/
```

Open `http://127.0.0.1:18089/lilt/`. The command initializes the explicitly selected local data directory. Production trusted Origins belong in private runtime configuration, not in Git.

```sh
bin/lilt check --data .local/data
make release
make deploy
```

Releases export pushed, committed source and use the shared restricted NAS publication workflow. GitHub stores source and configuration only; full backup and recovery remain server-operations agent workflows.

Read [the documentation index](docs/README.md), [operations](docs/OPERATIONS.md) and [third-party notices](docs/THIRD_PARTY_NOTICES.md) before maintenance.
