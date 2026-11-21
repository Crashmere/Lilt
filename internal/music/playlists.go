package music

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

type PlaylistInput struct {
	Name        *string     `json:"name"`
	Description *string     `json:"description"`
	Kind        *string     `json:"kind"`
	Rules       *SmartRules `json:"rules"`
	TrackIDs    *[]string   `json:"trackIds"`
}

func smartMatches(t Track, rules SmartRules, cutoff time.Time) bool {
	if rules.Favorite != nil && *rules.Favorite != t.Favorite {
		return false
	}
	for _, tag := range rules.Tags {
		found := false
		for _, value := range t.Tags {
			if strings.EqualFold(tag, value) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if rules.Artist != "" && !strings.EqualFold(rules.Artist, t.Artist) && !strings.EqualFold(rules.Artist, t.AlbumArtist) && rules.Artist != artistID(t.Artist) && rules.Artist != artistID(t.AlbumArtist) {
		return false
	}
	if rules.Genre != "" && !strings.EqualFold(rules.Genre, t.Genre) {
		return false
	}
	if rules.YearFrom > 0 && t.Year < rules.YearFrom {
		return false
	}
	if rules.YearTo > 0 && t.Year > rules.YearTo {
		return false
	}
	if rules.Unplayed && t.PlayedSeconds > 0 {
		return false
	}
	if rules.UnheardDays > 0 && t.LastPlayedAt != "" {
		played, err := time.Parse(time.RFC3339Nano, t.LastPlayedAt)
		if err == nil && played.After(cutoff) {
			return false
		}
	}
	return true
}

func resolvePlaylist(p Playlist, tracks []Track) Playlist {
	byID := map[string]Track{}
	for _, t := range tracks {
		byID[t.ID] = t
	}
	ids := []string{}
	if p.Kind == "smart" {
		cutoff := time.Now().UTC().AddDate(0, 0, -p.Rules.UnheardDays)
		for _, t := range tracks {
			if smartMatches(t, p.Rules, cutoff) {
				ids = append(ids, t.ID)
				if p.Rules.Limit > 0 && len(ids) >= p.Rules.Limit {
					break
				}
			}
		}
	} else {
		for _, id := range p.TrackIDs {
			if _, ok := byID[id]; ok {
				ids = append(ids, id)
			}
		}
	}
	p.TrackIDs = ids
	p.CoverURL = ""
	for _, id := range ids {
		if t := byID[id]; t.CoverURL != "" {
			p.CoverURL = t.CoverURL
			break
		}
	}
	return p
}

func (s *Store) Playlists(ctx context.Context, tracks []Track) ([]Playlist, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT document FROM playlists")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []Playlist{}
	for rows.Next() {
		var data string
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		var p Playlist
		if err = json.Unmarshal([]byte(data), &p); err != nil {
			return nil, err
		}
		all = append(all, resolvePlaylist(p, tracks))
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedAt > all[j].UpdatedAt })
	return all, rows.Err()
}

func (s *Store) playlist(ctx context.Context, id string) (Playlist, error) {
	var data string
	err := s.db.QueryRowContext(ctx, "SELECT document FROM playlists WHERE id=?", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return Playlist{}, ErrNotFound
	}
	if err != nil {
		return Playlist{}, err
	}
	var p Playlist
	err = json.Unmarshal([]byte(data), &p)
	if p.TrackIDs == nil {
		p.TrackIDs = []string{}
	}
	return p, err
}

func (s *Store) validatePlaylist(ctx context.Context, p *Playlist) error {
	p.Name = tidy(p.Name, 256)
	if p.Name == "" || len(p.Description) > 8192 {
		return fmt.Errorf("歌单名称或简介无效：%w", ErrInvalid)
	}
	if p.Kind != "manual" && p.Kind != "smart" {
		return ErrInvalid
	}
	if p.Rules.YearFrom < 0 || p.Rules.YearTo < 0 || p.Rules.YearFrom > 9999 || p.Rules.YearTo > 9999 || p.Rules.YearTo > 0 && p.Rules.YearFrom > p.Rules.YearTo || p.Rules.UnheardDays < 0 || p.Rules.UnheardDays > 36500 || p.Rules.Limit < 0 || p.Rules.Limit > 10000 || len(p.Rules.Artist) > 4096 || len(p.Rules.Genre) > 4096 {
		return fmt.Errorf("智能歌单条件无效：%w", ErrInvalid)
	}
	var err error
	p.Rules.Tags, err = cleanList(p.Rules.Tags)
	if err != nil {
		return err
	}
	if len(p.TrackIDs) > 10000 {
		return fmt.Errorf("歌单歌曲数量过多：%w", ErrInvalid)
	}
	if p.TrackIDs == nil {
		p.TrackIDs = []string{}
	}
	if p.Kind == "smart" {
		p.TrackIDs = []string{}
		return nil
	}
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM tracks")
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		known[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range p.TrackIDs {
		if !validID(id) || !known[id] {
			return fmt.Errorf("歌单包含不存在的歌曲：%w", ErrInvalid)
		}
	}
	return nil
}

func (s *Store) SavePlaylist(ctx context.Context, id string, in PlaylistInput) (Playlist, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := Playlist{Kind: "manual", TrackIDs: []string{}, CreatedAt: now()}
	var err error
	if id != "" {
		p, err = s.playlist(ctx, id)
		if err != nil {
			return Playlist{}, err
		}
	} else {
		p.ID, err = newID("p_")
		if err != nil {
			return Playlist{}, err
		}
	}
	if in.Name != nil {
		p.Name = *in.Name
	}
	if in.Description != nil {
		p.Description = *in.Description
	}
	if in.Kind != nil {
		p.Kind = *in.Kind
	}
	if in.Rules != nil {
		p.Rules = *in.Rules
	}
	if in.TrackIDs != nil {
		p.TrackIDs = *in.TrackIDs
	}
	if err = s.validatePlaylist(ctx, &p); err != nil {
		return Playlist{}, err
	}
	p.UpdatedAt = now()
	data, err := json.Marshal(p)
	if err != nil {
		return Playlist{}, err
	}
	if id == "" {
		_, err = s.db.ExecContext(ctx, "INSERT INTO playlists (id,document) VALUES (?,?)", p.ID, string(data))
	} else {
		_, err = s.db.ExecContext(ctx, "UPDATE playlists SET document=? WHERE id=?", string(data), p.ID)
	}
	if err != nil {
		return Playlist{}, err
	}
	tracks, err := s.Tracks(ctx, false)
	if err != nil {
		return Playlist{}, err
	}
	return resolvePlaylist(p, tracks), nil
}

func tracksByIDs(ids []string, tracks []Track) []Track {
	byID := map[string]Track{}
	for _, t := range tracks {
		byID[t.ID] = t
	}
	result := []Track{}
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			result = append(result, t)
		}
	}
	return result
}

func (s *Store) PlaylistContent(ctx context.Context, id string) (Playlist, []Track, error) {
	p, err := s.playlist(ctx, id)
	if err != nil {
		return Playlist{}, nil, err
	}
	tracks, err := s.Tracks(ctx, false)
	if err != nil {
		return Playlist{}, nil, err
	}
	p = resolvePlaylist(p, tracks)
	return p, tracksByIDs(p.TrackIDs, tracks), nil
}

func (s *Store) DeletePlaylist(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, "DELETE FROM playlists WHERE id=?", id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return err
}
