package music

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mozillazg/go-pinyin"
)

func (s *Store) hydrate(t *Track) {
	if t.Tags == nil {
		t.Tags = []string{}
	}
	if t.Aliases == nil {
		t.Aliases = []string{}
	}
	if t.CoverURL != "" {
		t.CoverURL = s.prefix + "api/tracks/" + t.ID + "/cover"
		if info, err := os.Stat(filepath.Join(s.dir, "covers", t.ID, "cover.jpg")); err == nil {
			t.CoverURL += "?v=" + coverVersion(info)
		}
	}
	t.HasLyrics = t.LyricsText != ""
	t.LyricsVersion = fmt.Sprintf("%x", sha256.Sum256([]byte(t.LyricsText)))
	t.SearchText = trackSearchText(*t)
}

func (s *Store) track(ctx context.Context, id string) (Track, string, string, error) {
	var document, fingerprint, path string
	err := s.db.QueryRowContext(ctx, "SELECT document,fingerprint,original_path FROM tracks WHERE id=?", id).Scan(&document, &fingerprint, &path)
	if errors.Is(err, sql.ErrNoRows) {
		return Track{}, "", "", ErrNotFound
	}
	if err != nil {
		return Track{}, "", "", err
	}
	var t Track
	if err = json.Unmarshal([]byte(document), &t); err != nil {
		return t, "", "", err
	}
	var fields struct {
		Composer *string `json:"composer"`
	}
	if err = json.Unmarshal([]byte(document), &fields); err != nil {
		return t, "", "", err
	}
	t.legacyCredits = fields.Composer == nil
	s.hydrate(&t)
	err = s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(h.seconds),0),COALESCE(SUM(COALESCE(m.counted,CASE WHEN h.completed=1 OR h.seconds>=? THEN 1 ELSE 0 END)),0),COALESCE(MAX(CASE WHEN h.seconds>0 OR h.completed=1 THEN h.updated_at END),'') FROM history h LEFT JOIN history_metrics m ON m.session_id=h.session_id WHERE h.track_id=?", min(30.0, t.Duration/2), id).Scan(&t.PlayedSeconds, &t.PlayCount, &t.LastPlayedAt)
	return t, fingerprint, path, err
}

func (s *Store) Tracks(ctx context.Context, trash bool) ([]Track, error) {
	condition := "deleted_at IS NULL"
	if trash {
		condition = "deleted_at IS NOT NULL"
	}
	rows, err := s.db.QueryContext(ctx, "SELECT document FROM tracks WHERE "+condition)
	if err != nil {
		return nil, err
	}
	all := []Track{}
	for rows.Next() {
		var document string
		if err = rows.Scan(&document); err != nil {
			rows.Close()
			return nil, err
		}
		var t Track
		if err = json.Unmarshal([]byte(document), &t); err != nil {
			rows.Close()
			return nil, err
		}
		s.hydrate(&t)
		t.LyricsText = ""
		t.PlayedSeconds = 0
		t.PlayCount = 0
		t.LastPlayedAt = ""
		all = append(all, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = s.db.QueryContext(ctx, "SELECT h.track_id,SUM(h.seconds),SUM(COALESCE(m.counted,CASE WHEN h.completed=1 OR h.seconds>=MIN(30.0,json_extract(t.document,'$.duration')/2.0) THEN 1 ELSE 0 END)),COALESCE(MAX(CASE WHEN h.seconds>0 OR h.completed=1 THEN h.updated_at END),'') FROM history h JOIN tracks t ON t.id=h.track_id LEFT JOIN history_metrics m ON m.session_id=h.session_id GROUP BY h.track_id")
	if err != nil {
		return nil, err
	}
	index := map[string]int{}
	for i, t := range all {
		index[t.ID] = i
	}
	for rows.Next() {
		var id, last string
		var seconds float64
		var count int64
		if err = rows.Scan(&id, &seconds, &count, &last); err != nil {
			rows.Close()
			return nil, err
		}
		if i, ok := index[id]; ok {
			all[i].PlayedSeconds = seconds
			all[i].PlayCount = count
			all[i].LastPlayedAt = last
		}
	}
	err = rows.Err()
	rows.Close()
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].AddedAt != all[j].AddedAt {
			return all[i].AddedAt > all[j].AddedAt
		}
		return all[i].ID < all[j].ID
	})
	return all, err
}

func albumID(t Track) string {
	artist := t.AlbumArtist
	if artist == "" {
		artist = t.Artist
	}
	return stableID("a_", artist+"\x00"+t.Album)
}

func artistID(name string) string { return stableID("r_", name) }

func trackArtistNames(t Track) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, name := range strings.Split(t.Artist+"/"+t.AlbumArtist, "/") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		id := artistID(name)
		if !seen[id] {
			names = append(names, name)
			seen[id] = true
		}
	}
	return names
}

func matchesArtist(t Track, value string) bool {
	// Preserve saved filters and rules that use the original combined credits.
	if strings.EqualFold(value, t.Artist) || strings.EqualFold(value, t.AlbumArtist) || value == artistID(t.Artist) || value == artistID(t.AlbumArtist) {
		return true
	}
	for _, name := range trackArtistNames(t) {
		if strings.EqualFold(value, name) || value == artistID(name) {
			return true
		}
	}
	return false
}

func orderedTracks(tracks []Track) []Track {
	result := append([]Track{}, tracks...)
	sort.SliceStable(result, func(i, j int) bool {
		a, b := result[i], result[j]
		if a.DiscNumber != b.DiscNumber {
			return a.DiscNumber < b.DiscNumber
		}
		if a.TrackNumber != b.TrackNumber {
			if a.TrackNumber == 0 {
				return false
			}
			if b.TrackNumber == 0 {
				return true
			}
			return a.TrackNumber < b.TrackNumber
		}
		if a.Title != b.Title {
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		}
		return a.ID < b.ID
	})
	return result
}

func collections(tracks []Track) ([]Album, []Artist, []string) {
	albumTracks := map[string][]Track{}
	artistTracks := map[string][]Track{}
	artistNames := map[string]string{}
	tagNames := map[string]string{}
	for _, t := range tracks {
		albumTracks[albumID(t)] = append(albumTracks[albumID(t)], t)
		for _, name := range trackArtistNames(t) {
			id := artistID(name)
			artistNames[id] = name
			artistTracks[id] = append(artistTracks[id], t)
		}
		for _, tag := range t.Tags {
			tagNames[strings.ToLower(tag)] = tag
		}
	}
	albums := []Album{}
	for id, group := range albumTracks {
		ordered := orderedTracks(group)
		first := ordered[0]
		a := Album{ID: id, Title: first.Album, Artist: first.AlbumArtist, Year: first.Year, TrackIDs: []string{}, TrackCount: len(ordered)}
		if a.Artist == "" {
			a.Artist = first.Artist
		}
		for _, t := range ordered {
			a.TrackIDs = append(a.TrackIDs, t.ID)
			a.Duration += t.Duration
			if a.CoverURL == "" {
				a.CoverURL = t.CoverURL
			}
		}
		albums = append(albums, a)
	}
	sort.Slice(albums, func(i, j int) bool {
		if albums[i].Title != albums[j].Title {
			return strings.ToLower(albums[i].Title) < strings.ToLower(albums[j].Title)
		}
		return albums[i].ID < albums[j].ID
	})
	artists := []Artist{}
	for id, group := range artistTracks {
		a := Artist{ID: id, Name: artistNames[id], TrackCount: len(group), TrackIDs: []string{}}
		albumSet := map[string]bool{}
		for _, t := range orderedTracks(group) {
			a.TrackIDs = append(a.TrackIDs, t.ID)
			albumSet[albumID(t)] = true
			if a.CoverURL == "" {
				a.CoverURL = t.CoverURL
			}
		}
		a.AlbumCount = len(albumSet)
		artists = append(artists, a)
	}
	sort.Slice(artists, func(i, j int) bool {
		if artists[i].TrackCount != artists[j].TrackCount {
			return artists[i].TrackCount > artists[j].TrackCount
		}
		if artists[i].AlbumCount != artists[j].AlbumCount {
			return artists[i].AlbumCount > artists[j].AlbumCount
		}
		return strings.ToLower(artists[i].Name) < strings.ToLower(artists[j].Name)
	})
	tags := []string{}
	for _, name := range tagNames {
		tags = append(tags, name)
	}
	sort.Strings(tags)
	return albums, artists, tags
}

func (s *Store) Library(ctx context.Context) (Library, error) {
	tracks, err := s.Tracks(ctx, false)
	if err != nil {
		return Library{}, err
	}
	albums, artists, tags := collections(tracks)
	playlists, err := s.Playlists(ctx, tracks)
	if err != nil {
		return Library{}, err
	}
	stats := Stats{TotalTracks: len(tracks), TotalAlbums: len(albums), TotalArtists: len(artists)}
	for _, t := range tracks {
		stats.TotalDuration += t.Duration
		stats.TotalBytes += t.Size
		if t.Favorite {
			stats.FavoriteTracks++
		}
	}
	if err = s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(h.seconds),0),COALESCE(SUM(COALESCE(m.counted,CASE WHEN h.completed=1 OR h.seconds>=MIN(30.0,json_extract(t.document,'$.duration')/2.0) THEN 1 ELSE 0 END)),0) FROM history h JOIN tracks t ON t.id=h.track_id LEFT JOIN history_metrics m ON m.session_id=h.session_id").Scan(&stats.PlayedSeconds, &stats.PlayCount); err != nil {
		return Library{}, err
	}
	return Library{Tracks: tracks, Albums: albums, Artists: artists, Playlists: playlists, Tags: tags, Stats: stats}, nil
}

type TrackPatch struct {
	Title             *string   `json:"title"`
	Artist            *string   `json:"artist"`
	Album             *string   `json:"album"`
	AlbumArtist       *string   `json:"albumArtist"`
	Genre             *string   `json:"genre"`
	Composer          *string   `json:"composer"`
	Lyricist          *string   `json:"lyricist"`
	Comment           *string   `json:"comment"`
	Copyright         *string   `json:"copyright"`
	ISRC              *string   `json:"isrc"`
	BPM               *float64  `json:"bpm"`
	Year              *int      `json:"year"`
	TrackNumber       *int      `json:"trackNumber"`
	DiscNumber        *int      `json:"discNumber"`
	Version           *string   `json:"version"`
	Tags              *[]string `json:"tags"`
	Aliases           *[]string `json:"aliases"`
	Favorite          *bool     `json:"favorite"`
	LyricsText        *string   `json:"lyricsText"`
	RemoveCover       bool      `json:"removeCover"`
	ExpectedUpdatedAt *string   `json:"expectedUpdatedAt"`
}

func cleanList(values []string) ([]string, error) {
	if len(values) > 256 {
		return nil, fmt.Errorf("标签或别名数量过多：%w", ErrInvalid)
	}
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = tidy(value, 256)
		if value != "" && !seen[strings.ToLower(value)] {
			result = append(result, value)
			seen[strings.ToLower(value)] = true
		}
	}
	return result, nil
}

func (s *Store) UpdateTrack(ctx context.Context, id string, p TrackPatch) (Track, error) {
	return s.editTrack(ctx, id, p, nil)
}

func applyTrackPatch(t *Track, p TrackPatch) error {
	if p.ExpectedUpdatedAt != nil && *p.ExpectedUpdatedAt != t.UpdatedAt {
		return fmt.Errorf("曲目信息已更新，请重新打开编辑：%w", ErrConflict)
	}
	var err error
	for _, field := range []struct {
		value  *string
		target *string
	}{{p.Title, &t.Title}, {p.Artist, &t.Artist}, {p.Album, &t.Album}, {p.AlbumArtist, &t.AlbumArtist}, {p.Genre, &t.Genre}, {p.Version, &t.Version}, {p.Composer, &t.Composer}, {p.Lyricist, &t.Lyricist}, {p.Comment, &t.Comment}, {p.Copyright, &t.Copyright}, {p.ISRC, &t.ISRC}} {
		if field.value != nil {
			if len(*field.value) > 4096 {
				return ErrInvalid
			}
			*field.target = tidy(*field.value, 4096)
		}
	}
	if t.Title == "" {
		return fmt.Errorf("歌曲名称不能为空：%w", ErrInvalid)
	}
	if t.Artist == "" {
		t.Artist = "未知歌手"
	}
	if t.Album == "" {
		t.Album = "未归属专辑"
	}
	if t.AlbumArtist == "" {
		t.AlbumArtist = t.Artist
	}
	for _, field := range []struct {
		value   *int
		target  *int
		maximum int
	}{{p.Year, &t.Year, 9999}, {p.TrackNumber, &t.TrackNumber, 99999}, {p.DiscNumber, &t.DiscNumber, 9999}} {
		if field.value != nil {
			if *field.value < 0 || *field.value > field.maximum {
				return ErrInvalid
			}
			*field.target = *field.value
		}
	}
	if p.Tags != nil {
		t.Tags, err = cleanList(*p.Tags)
		if err != nil {
			return err
		}
	}
	if p.BPM != nil {
		if math.IsNaN(*p.BPM) || math.IsInf(*p.BPM, 0) || *p.BPM < 0 || *p.BPM > 9999 {
			return ErrInvalid
		}
		t.BPM = *p.BPM
	}
	if p.Aliases != nil {
		t.Aliases, err = cleanList(*p.Aliases)
		if err != nil {
			return err
		}
	}
	if p.Favorite != nil {
		t.Favorite = *p.Favorite
	}
	if p.LyricsText != nil {
		if len(*p.LyricsText) > 1<<20 || strings.ContainsRune(*p.LyricsText, '\x00') {
			return fmt.Errorf("歌词格式或大小无效：%w", ErrInvalid)
		}
		t.LyricsText = *p.LyricsText
		t.HasLyrics = strings.TrimSpace(t.LyricsText) != ""
	}
	return nil
}

func (s *Store) DeleteTrack(ctx context.Context, id string, restore bool) (Track, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.finishMetadataWrite(); err != nil {
		return Track{}, err
	}
	t, _, _, err := s.track(ctx, id)
	if err != nil {
		return Track{}, err
	}
	var deleted any
	if restore {
		t.DeletedAt = ""
	} else {
		t.DeletedAt = now()
		deleted = t.DeletedAt
	}
	t.UpdatedAt = now()
	document, err := trackDocument(t)
	if err != nil {
		return Track{}, err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE tracks SET document=?,deleted_at=? WHERE id=?", string(document), deleted, id)
	if err == nil {
		s.invalidateLibrary()
	}
	return t, err
}

func normalizedSearch(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, text)
}

func phonetic(text string) string {
	args := pinyin.NewArgs()
	args.Heteronym = true
	variants := []string{""}
	initials := []string{""}
	for _, r := range text {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			continue
		}
		readings := []string{string(unicode.ToLower(r))}
		if unicode.Is(unicode.Han, r) {
			if values := pinyin.SinglePinyin(r, args); len(values) > 0 {
				readings = values
			}
		}
		next := make([]string, 0, min(32, len(variants)*len(readings)))
		nextInitial := make([]string, 0, cap(next))
		for i, v := range variants {
			for _, reading := range readings {
				if len(next) >= 32 {
					break
				}
				next = append(next, v+reading)
				first, _ := utf8.DecodeRuneInString(reading)
				nextInitial = append(nextInitial, initials[i]+string(first))
			}
		}
		variants, initials = next, nextInitial
	}
	return strings.Join(variants, " ") + " " + strings.Join(initials, " ")
}

func trackSearchText(t Track) string {
	fields := []string{t.Title, t.Artist, t.Album, t.AlbumArtist, t.Genre, t.Version, t.Composer, t.Lyricist, t.Comment, t.ISRC, t.OriginalName}
	fields = append(fields, t.Tags...)
	fields = append(fields, t.Aliases...)
	var search strings.Builder
	for _, field := range fields {
		search.WriteString(normalizedSearch(field))
		search.WriteByte(' ')
		search.WriteString(phonetic(field))
		search.WriteByte(' ')
	}
	return search.String()
}

func trackMatches(t Track, q string) bool {
	search := t.SearchText
	if search == "" {
		search = trackSearchText(t)
	}
	for _, token := range strings.Fields(q) {
		token = normalizedSearch(token)
		if token != "" && !strings.Contains(search, token) {
			return false
		}
	}
	return true
}

func FilterTracks(tracks []Track, values url.Values) []Track {
	result := []Track{}
	for _, t := range tracks {
		if q := values.Get("q"); q != "" && !trackMatches(t, q) {
			continue
		}
		if favorite := values.Get("favorite"); favorite != "" && (favorite == "true" || favorite == "1") != t.Favorite {
			continue
		}
		if tag := values.Get("tag"); tag != "" {
			found := false
			for _, value := range t.Tags {
				if strings.EqualFold(tag, value) {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if album := values.Get("album"); album != "" && album != albumID(t) && !strings.EqualFold(album, t.Album) {
			continue
		}
		if artist := values.Get("artist"); artist != "" && !matchesArtist(t, artist) {
			continue
		}
		result = append(result, t)
	}
	return result
}
