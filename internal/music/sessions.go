package music

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func (s *Store) RecordHistory(ctx context.Context, in HistoryInput) error {
	if !validID(in.TrackID) || !validID(in.SessionID) || !finite(in.Seconds) || in.Seconds < 0 || in.Seconds > 31_536_000 {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var deleted sql.NullString
	var document string
	if err := s.db.QueryRowContext(ctx, "SELECT deleted_at,document FROM tracks WHERE id=?", in.TrackID).Scan(&deleted, &document); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if deleted.Valid {
		return fmt.Errorf("已删除的歌曲不能写入新的播放记录：%w", ErrConflict)
	}
	var existingTrack string
	var seconds float64
	var completed bool
	err := s.db.QueryRowContext(ctx, "SELECT track_id,seconds,completed FROM history WHERE session_id=?", in.SessionID).Scan(&existingTrack, &seconds, &completed)
	exists := err == nil
	if err == nil {
		if existingTrack != in.TrackID {
			return fmt.Errorf("播放会话对应的歌曲不一致：%w", ErrConflict)
		}
		if in.Seconds <= seconds && (!in.Completed || completed) {
			return nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var track Track
	if err = json.Unmarshal([]byte(document), &track); err != nil {
		return err
	}
	threshold := min(30.0, track.Duration/2)
	counted := false
	err = s.db.QueryRowContext(ctx, "SELECT threshold,counted FROM history_metrics WHERE session_id=?", in.SessionID).Scan(&threshold, &counted)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	seconds = max(seconds, in.Seconds)
	completed = completed || in.Completed
	counted = counted || completed || seconds >= threshold
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := now()
	if exists {
		_, err = tx.ExecContext(ctx, "UPDATE history SET seconds=?,completed=?,updated_at=? WHERE session_id=?", seconds, completed, stamp, in.SessionID)
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO history (session_id,track_id,seconds,completed,started_at,updated_at) VALUES (?,?,?,?,?,?)", in.SessionID, in.TrackID, seconds, completed, stamp, stamp)
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO history_metrics (session_id,threshold,counted) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET counted=MAX(history_metrics.counted,excluded.counted)", in.SessionID, threshold, counted)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) History(ctx context.Context, limit int) ([]HistoryEntry, error) {
	query := "SELECT session_id,track_id,seconds,completed,started_at,updated_at FROM history ORDER BY updated_at DESC"
	args := []any{}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		if err = rows.Scan(&h.SessionID, &h.TrackID, &h.Seconds, &h.Completed, &h.PlayedAt, &h.UpdatedAt); err != nil {
			return nil, err
		}
		h.ID = h.SessionID
		entries = append(entries, h)
	}
	return entries, rows.Err()
}
