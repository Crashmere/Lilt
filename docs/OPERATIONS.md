# Operations

Lilt's application target is `nas`, at `/lilt/` on `127.0.0.1:18089`. `vps` provides the primary public HTTPS 8443 entrance and `ali` provides compatibility HTTPS 443; both forward to this same NAS instance. NAS LAN access uses the existing local-CA HTTPS entrance. Shared server-operations current-state owns production activation.

The runtime identity is `lilt`; local publication uses the restricted `lilt-deploy` identity. Source repository: `Crashmere/Lilt`. Keep actual addresses, credentials, music, catalogs, browser exports and backups outside Git.

## Runtime and Data

| Path | Responsibility |
| --- | --- |
| `/opt/lilt/bin/lilt` | Static Linux amd64 Go program with embedded web assets |
| `/opt/lilt/bin/deploy-{ssh,release}.sh` | Root-owned fixed publication entry points |
| `/opt/lilt/config/` | systemd unit, application Nginx location, private runtime environment, Portal declaration and source receipt |
| `/opt/lilt/data/lilt.sqlite` | Tracks, metadata, file-hash recognition history, lyrics, playlists, uploads, listening sessions, retained legacy player snapshots and artwork ownership |
| `/opt/lilt/data/originals/` | Current SHA-256-addressed audio, retained explicit upload replacements and transient journal-owned metadata staging |
| `/opt/lilt/data/originals/artwork/` | Legacy manually uploaded artwork retained by existing ownership records; new edits embed artwork in audio |
| `/opt/lilt/data/uploads/` | Durable incomplete audio upload files |
| `/opt/lilt/data/covers/` | Sanitized static JPEG artwork, including extracted embedded covers |
| `/opt/lilt/data/playback/` | Source/quality-addressed compatible AAC/M4A files and descriptors |
| `/opt/lilt/releases/` | Uploaded programs, previous programs, hashes, acceptance and rollback records |
| `/opt/lilt/docs/` | Controlled maintenance documentation and provenance |

Production reuses NAS's installed FFmpeg and FFprobe. Go, Node/npm and graphics tools are maintenance-computer build dependencies only. The service performs bounded CPU audio encoding and does not select Aura/Curio's NVIDIA image runtime. `lilt.service` permits writes to Lilt's private data directory, sets a 512 MiB memory limit and allows 128 tasks. It creates no backup, purge or retention timer.

The unit runs:

```sh
/opt/lilt/bin/lilt serve --addr 127.0.0.1:18089 --data /opt/lilt/data --prefix /lilt/
```

The CLI also accepts `LILT_ADDR`, `LILT_DATA_DIR` and `LILT_PREFIX` defaults. Production flags fix those values. Root-owned mode-0600 `/opt/lilt/config/lilt.env` supplies comma-separated `LILT_ORIGINS`; initial installation derives it from NAS's existing private Portal configuration. If the shared Origin set changes, regenerate this application configuration and restart only Lilt under the shared access-change workflow.

Startup initializes the explicitly selected new data directory and opens the supported catalog schema. Never redirect a failed production start to an empty directory. Candidate checks require an existing database and open it read-only.

Metadata writeback uses the existing NAS FFmpeg/FFprobe runtime and native container-tag writers without new packages or services. A `pendingMetadataWrite` settings receipt links validated staging, the new audio fingerprint, catalog metadata and cover changes. Startup completes that receipt before serving requests and removes abandoned edit staging. Read-only candidate checks reject an unfinished receipt; recover it with a compatible program before release or rollback. Existing audio is not rewritten in bulk on startup. New cover edits retain the embedded JPEG and display derivative, not another artwork upload object. Historical artwork ownership and explicit upload revisions remain intact.

File-hash recognition uses the additive `track_fingerprints` table in the same catalog, covered by complete SQLite recovery. First history-aware startup seeds current hashes and backfills completed upload receipts only for tracks without explicit replacement revisions, where those receipts still identify the same audio lineage. It records `fingerprintHistoryVersion=1`; later starts do not repeat the legacy backfill. Existing track documents and audio files are unchanged by initialization. Unrecorded intermediate pre-upgrade metadata hashes cannot be reconstructed. Metadata publication maintains hash records atomically; explicit audio replacement resets only that track's recognition history. Older compatible programs can open the additive schema but do not maintain these mappings.

## Uploads, Media and Browser Access

Raw upload chunks contain at most 32 MiB; exact upload-session paths have a 33 MiB Nginx request limit. Exact track-cover paths have no configured request-size ceiling. Both paths disable request buffering and retain a 600-second application body deadline and 660-second Nginx body/upstream idle timeouts. Covers stream into request-scoped temporary files rather than an upload-sized memory buffer; production's existing `PrivateTmp` isolates these files, and normal completion or failure removes them. Image validation retains the 25-million-pixel limit and produces JPEG artwork bounded to 1600 pixels per side. Multipart metadata remains limited to 2 MiB. Ordinary application requests retain a 2 MiB proxy limit.

Audio stream and original-download responses disable Nginx response buffering and support Range/HEAD. Standard/compact files are separate nominal 192/96 kbit/s AAC/M4A derivatives with at most two channels and 48 kHz output. The first compatible request may encode before returning media. Preserve originals and stored derivatives during ordinary releases; no automatic file purge is installed.

The same application-owned Nginx source is installed on `nas`, `ali` and `vps`. It preserves `/lilt/`, full `$http_host`, forwarded protocol and inherited ServerPortal authentication/renewal headers. No application `add_header` overrides are used. The shared HTTPS receive-buffer policy remains unchanged.

Anonymous GET/HEAD is limited to `/lilt/favicon.svg`, `/lilt/apple-touch-icon.png`, `/lilt/icon-192.png`, `/lilt/icon-512.png` and `/lilt/manifest.webmanifest`. The opaque 180-by-180 Apple icon and manifest icons are generated from retained source by `scripts/icons.sh` on the maintenance Mac and included in the build. `/lilt/sw.js`, application code, business APIs and uploaded media remain authenticated.

Browser queues, progress and saved library metadata remain device/Origin-local. Audio loads from the server without application-managed offline audio caching. Clearing browser storage can remove browser-local state, and background execution depends on the platform. Same-origin tabs coordinate playback locally. Real mobile lock-screen playback, Home Screen installation and first-Origin login are device acceptance, separate from HTTP checks.

## Initial NAS Installation

Use server-operations and explicitly read `/opt/AGENTS.md` on each target before maintenance. Inspect the complete application inventory and actual listener 18089 on `nas`, `ali` and `vps`. This installation is for a selected new empty NAS-only library, not migration or restoration.

Register Lilt in the shared upgrade helper before its first restricted release, then synchronize that helper to NAS. Build from pushed committed source on the maintenance computer. Transfer the verified Linux program, committed `deploy/` sources and existing NAS deployment public key to private NAS staging, then run as administrator on `nas`:

```sh
bash deploy/install.sh ./lilt-linux-amd64 ./nas-deploy-public-key.pub
```

The installer rejects existing Lilt directories, units, registry entries, accounts and occupied ports. It reuses installed runtime tools, derives private Origins from Portal, creates only Lilt identities/data/configuration, starts the new empty instance and installs the application Nginx link after validation. It installs no packages or build environments and does not overwrite existing data. If installation fails after creating resources, inspect and fix that new state; do not rerun initialization over it.

Run the local integration entry points from the committed checkout:

```sh
python3 deploy/integrate.py gateways
make portal
python3 deploy/integrate.py recovery
```

Gateway integration uses trusted `nas`, `ali` and `vps` aliases, exact loopback forwarding 18089 and the application route source. It adds separate Lilt tunnel instances without restarting the original application/management tunnels. No new public application port or certificate is needed. Recovery integration appends the registered ID to the expected-app list while preserving existing private volume and host settings.

`make portal` validates and publishes the committed declaration through the actual ServerPortal protocol, creating the controlled registry link and verifying activation. It does not fabricate a registry receipt or restart Portal. Synchronize Lilt and changed shared documentation after pushing their managed sources; source documents and runtime deployment are separate steps.

## Release and Rollback

Validate affected behavior locally with synthetic audio and isolated data, commit and push `main`, then run:

```sh
make release
make deploy
```

`deploy/release.sh` invokes shared `scripts/release.py` from `SERVER_OPERATIONS_HOME` or `~/agent-config/skills/server-operations`. The driver exports pushed committed files, installs locked web dependencies, runs `make linux`, validates the Portal declaration and records artifacts under `.local/releases/<full-commit>/`. The default application version is `0.1.0`; source provenance uses the full commit independently of that display version.

Publication defaults to `nas` with the existing NAS deployment key; public rejection checks default to the `vps` HTTPS 8443 entrance. Custom trusted SSH aliases require explicit key and public-Origin inputs. See the shared [local release contract](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/release.md) for those settings.

The fixed root release holds the shared maintenance lock and Lilt deployment lock, checks the uploaded program's bounded size/hash, stops only Lilt, runs the candidate's read-only check, atomically replaces the executable and verifies direct/proxied health. It calls shared `upgrade-state.py` for conditional database-only protection and acceptance. Normal releases select no temporary database backup. Declare only an affected SQLite database when an authorized transition can delete or overwrite existing data; never temporarily copy originals, artwork, uploads or playback derivatives.

On failure, the fixed script attempts to restart the previous program and restores its source marker. Captured protection and failed release records remain for agent inspection; data is not rolled back. Schema compatibility must be established before choosing an older program.

```sh
make portal
make releases
make rollback COMMIT=<compatible-full-commit>
SYNC_HOST=nas ~/agent-config/skills/server-operations/scripts/sync-docs.sh Lilt
```

`make portal` publishes declaration-only changes without building or restarting. Program, declaration and documentation provenance are separate: `current-commit`, `config/portal-source.json` and `docs/SOURCE`. Program releases do not install changed units, Nginx locations, runtime environment or fixed release scripts; install their committed sources through authorized administrator maintenance.

## Recovery and Diagnosis

Full `nas`/`vps` external backup and recovery belong exclusively to the server-operations agent. Lilt's complete scope includes all SQLite records and the entire original, artwork, durable upload, cover and playback trees, even when derivatives have a cache display label. Browser-local data has a separate lifetime and is not captured by NAS backups. No web backup controls or internal backup schedules are added.

Choose and verify a real recovery point through the shared [backup and recovery runbook](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/backup-recovery.md). Restore into an isolated path first, validate the complete database and original mapping, then obtain confirmation before production replacement. Metadata JSON and M3U exports are portability tools, not complete recovery packages.

```sh
bin/lilt check --data /path/to/isolated-data
ssh nas 'systemctl status lilt'
ssh nas 'journalctl -u lilt --since today'
ssh nas 'curl --fail http://127.0.0.1:18089/healthz'
```

`check` validates SQLite quick integrity, schema and referenced originals' existence/sizes; it does not rehash every file. Use the shared read-only viewing tunnel for production browser inspection. Write checks use isolated synthetic data.

For quantified-ID route validation failures on `nas`, `ali` or `vps`, see the shared [Nginx regex quantifier quoting issue](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/common-issues.md#nginx-location-regex-quantifiers-require-quoting).

After publication, verify Portal declaration activation, anonymous business/media rejection, direct/prefixed health, representative upload/resume and audio Range behavior. Run shared `scripts/check-site-icons.py` against direct HTML and the selected authenticated entrance's public brand assets. Do not represent command-line acceptance as actual iPhone Home Screen or lock-screen acceptance.
