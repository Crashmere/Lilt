package music

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db       *sql.DB
	dir      string
	prefix   string
	mu       sync.Mutex
	encodeMu sync.Mutex
}

const schema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key,value) VALUES ('schemaVersion','1');
CREATE TABLE IF NOT EXISTS tracks (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, original_path TEXT NOT NULL,
 document TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS tracks_fingerprint ON tracks(fingerprint);
CREATE TABLE IF NOT EXISTS revisions (
 id INTEGER PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id), fingerprint TEXT NOT NULL,
 original_path TEXT NOT NULL, document TEXT NOT NULL, replaced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artwork (
 id INTEGER PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id), fingerprint TEXT NOT NULL,
 original_path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
 id TEXT PRIMARY KEY, filename TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
 fingerprint TEXT NOT NULL, status TEXT NOT NULL, track_id TEXT NOT NULL DEFAULT '',
 duplicate INTEGER NOT NULL DEFAULT 0, relative_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_fingerprint ON uploads(fingerprint,size,status);
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (
 session_id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id),
 seconds REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_track ON history(track_id);
CREATE TABLE IF NOT EXISTS history_metrics (
 session_id TEXT PRIMARY KEY REFERENCES history(session_id), threshold REAL NOT NULL,
 counted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS player_states (
 device_id TEXT PRIMARY KEY, label TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
`

func Open(dir, prefix string) (*Store, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	for _, name := range []string{"originals", "uploads", "covers", "playback"} {
		path := filepath.Join(abs, name)
		if info, e := os.Lstat(path); e == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
			return nil, fmt.Errorf("data directory is not an owned directory: %s", name)
		}
		if err = os.MkdirAll(path, 0700); err != nil {
			return nil, err
		}
	}
	dbPath := filepath.Join(abs, "lilt.sqlite")
	if info, e := os.Lstat(dbPath); e == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("catalog must be a regular file")
	}
	dsn := (&url.URL{Scheme: "file", Path: dbPath}).String() + "?_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	tx, err := db.Begin()
	if err != nil {
		db.Close()
		return nil, err
	}
	if _, err = tx.Exec(schema); err != nil {
		tx.Rollback()
		db.Close()
		return nil, err
	}
	var version string
	if err = tx.QueryRow("SELECT value FROM settings WHERE key='schemaVersion'").Scan(&version); err != nil || version != "1" {
		tx.Rollback()
		db.Close()
		return nil, fmt.Errorf("unsupported catalog schema: %s", version)
	}
	// Additive qualification snapshots leave existing listening sessions and their timestamps intact.
	if _, err = tx.Exec(`INSERT OR IGNORE INTO history_metrics (session_id,threshold,counted)
SELECT h.session_id,MIN(30.0,json_extract(t.document,'$.duration')/2.0),
 CASE WHEN h.completed=1 OR h.seconds>=MIN(30.0,json_extract(t.document,'$.duration')/2.0) THEN 1 ELSE 0 END
FROM history h JOIN tracks t ON t.id=h.track_id;
UPDATE history_metrics SET counted=1 WHERE counted=0 AND EXISTS (
 SELECT 1 FROM history h WHERE h.session_id=history_metrics.session_id
 AND (h.completed=1 OR h.seconds>=history_metrics.threshold)
);`); err != nil {
		tx.Rollback()
		db.Close()
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(dbPath, 0600); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, dir: abs, prefix: prefix}
	if err = s.reconcileUploads(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func Check(ctx context.Context, dir string) (map[string]any, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(abs, "lilt.sqlite")
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("existing catalog required: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("invalid catalog path")
	}
	dsn := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(10000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var result, version string
	if err = db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return nil, err
	}
	if result != "ok" {
		return nil, fmt.Errorf("catalog integrity: %s", result)
	}
	if err = db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='schemaVersion'").Scan(&version); err != nil || version != "1" {
		return nil, fmt.Errorf("unsupported catalog schema")
	}
	rows, err := db.QueryContext(ctx, "SELECT original_path, document FROM tracks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var relative, document string
		if err = rows.Scan(&relative, &document); err != nil {
			return nil, err
		}
		var track Track
		if err = json.Unmarshal([]byte(document), &track); err != nil {
			return nil, err
		}
		if !safeRelative(relative) {
			return nil, fmt.Errorf("invalid original path")
		}
		object, err := os.Stat(filepath.Join(abs, relative))
		if err != nil || !object.Mode().IsRegular() || object.Size() != track.Size {
			return nil, fmt.Errorf("missing or inconsistent original for %s", track.ID)
		}
		count++
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"status": "ok", "db": "ok", "schemaVersion": version, "tracks": count}, nil
}

func (s *Store) Health(ctx context.Context) error { return s.db.PingContext(ctx) }

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func newID(prefix string) (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(bytes[:]), nil
}

func stableID(prefix, value string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(value))))
	return prefix + hex.EncodeToString(h[:12])
}

func validID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func safeRelative(path string) bool {
	clean := filepath.Clean(path)
	return path != "" && !filepath.IsAbs(path) && clean == path && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

func (s *Store) objectPath(relative string) (string, error) {
	if !safeRelative(relative) {
		return "", ErrInvalid
	}
	return filepath.Join(s.dir, relative), nil
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func writeJSONFile(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".lilt-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, err = temp.Write(data); err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
