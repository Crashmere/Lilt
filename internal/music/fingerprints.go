package music

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

func initializeFingerprintHistory(tx *sql.Tx) error {
	var version string
	err := tx.QueryRow("SELECT value FROM settings WHERE key='fingerprintHistoryVersion'").Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		// Legacy upload receipts identify original bytes only when no explicit replacement broke the lineage.
		if _, err = tx.Exec(`INSERT OR IGNORE INTO track_fingerprints (fingerprint,track_id,size)
SELECT u.fingerprint,u.track_id,u.size FROM uploads u JOIN tracks t ON t.id=u.track_id
WHERE u.status='complete' AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.track_id=t.id)`); err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO settings (key,value) VALUES ('fingerprintHistoryVersion','1')"); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if version != "1" {
		return fmt.Errorf("unsupported fingerprint history: %s", version)
	}
	_, err = tx.Exec(`INSERT OR IGNORE INTO track_fingerprints (fingerprint,track_id,size)
SELECT fingerprint,id,json_extract(document,'$.size') FROM tracks`)
	return err
}

func (s *Store) duplicateTrack(ctx context.Context, fingerprint string, size int64, includeHistory bool) (string, error) {
	var id string
	var matchedSize int64
	err := s.db.QueryRowContext(ctx, `SELECT id,size FROM (
 SELECT id,json_extract(document,'$.size') AS size,deleted_at,0 AS priority FROM tracks WHERE fingerprint=?
 UNION ALL
 SELECT t.id,f.size,t.deleted_at,1 FROM track_fingerprints f JOIN tracks t ON t.id=f.track_id
 WHERE f.fingerprint=? AND ?
) ORDER BY deleted_at IS NOT NULL,priority,id LIMIT 1`, fingerprint, fingerprint, includeHistory).Scan(&id, &matchedSize)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if matchedSize != size {
		return "", fmt.Errorf("文件大小与 SHA-256 对应的已有文件不一致：%w", ErrInvalid)
	}
	return id, nil
}
