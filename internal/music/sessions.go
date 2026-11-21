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

func (s *Store) PlayerStates(ctx context.Context) ([]PlayerState, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT state_json FROM player_states ORDER BY updated_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := []PlayerState{}
	for rows.Next() {
		var data string
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		var state PlayerState
		if err = json.Unmarshal([]byte(data), &state); err != nil {
			return nil, err
		}
		if state.QueueIDs == nil {
			state.QueueIDs = []string{}
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

func (s *Store) SavePlayerState(ctx context.Context, id string, state PlayerState) (PlayerState, error) {
	if !validID(id) || state.TrackID != "" && !validID(state.TrackID) || len(state.Label) > 256 || !finite(state.Position) || state.Position < 0 || state.Position > 31_536_000 || !finite(state.Volume) || state.Volume < 0 || state.Volume > 1 || len(state.QueueIDs) > 10000 {
		return PlayerState{}, ErrInvalid
	}
	if state.Repeat == "" {
		state.Repeat = "off"
	}
	if state.Repeat != "off" && state.Repeat != "all" && state.Repeat != "one" {
		return PlayerState{}, ErrInvalid
	}
	if len(state.QueueIDs) > 0 && (state.QueueIndex < 0 || state.QueueIndex >= len(state.QueueIDs)) {
		return PlayerState{}, fmt.Errorf("播放队列位置无效：%w", ErrInvalid)
	}
	if len(state.QueueIDs) == 0 && state.QueueIndex != 0 && state.QueueIndex != -1 {
		return PlayerState{}, ErrInvalid
	}
	for _, trackID := range state.QueueIDs {
		if !validID(trackID) {
			return PlayerState{}, ErrInvalid
		}
	}
	state.DeviceID = id
	state.Label = tidy(state.Label, 256)
	if state.QueueIDs == nil {
		state.QueueIDs = []string{}
	}
	state.UpdatedAt = now()
	data, err := json.Marshal(state)
	if err != nil {
		return PlayerState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.ExecContext(ctx, "INSERT INTO player_states (device_id,label,state_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET label=excluded.label,state_json=excluded.state_json,updated_at=excluded.updated_at", id, state.Label, string(data), state.UpdatedAt)
	return state, err
}
