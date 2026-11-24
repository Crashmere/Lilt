package music

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type TrackSync struct {
	SourceID                string   `json:"sourceId"`
	Fields                  []string `json:"fields"`
	ExpectedSourceUpdatedAt string   `json:"expectedSourceUpdatedAt"`
	ExpectedUpdatedAt       string   `json:"expectedUpdatedAt"`
}

func (s *Store) SyncTrack(ctx context.Context, id string, request TrackSync) (Track, error) {
	if id == request.SourceID || request.SourceID == "" || len(request.Fields) == 0 || len(request.Fields) > 19 || request.ExpectedSourceUpdatedAt == "" || request.ExpectedUpdatedAt == "" {
		return Track{}, ErrInvalid
	}
	// Keep the source snapshot and target publication under the same audio-write lock.
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.finishMetadataWrite(); err != nil {
		return Track{}, err
	}
	source, _, relative, err := s.track(ctx, request.SourceID)
	if err != nil {
		return Track{}, err
	}
	target, _, _, err := s.track(ctx, id)
	if err != nil {
		return Track{}, err
	}
	if source.DeletedAt != "" || target.DeletedAt != "" {
		return Track{}, ErrNotFound
	}
	if source.UpdatedAt != request.ExpectedSourceUpdatedAt || target.UpdatedAt != request.ExpectedUpdatedAt {
		return Track{}, fmt.Errorf("歌曲已更新，请重新载入后确认同步内容：%w", ErrConflict)
	}
	if err = s.loadLegacyCredits(ctx, &source, relative); err != nil {
		return Track{}, err
	}
	patch := TrackPatch{ExpectedUpdatedAt: &request.ExpectedUpdatedAt}
	copyCover := false
	for _, field := range request.Fields {
		switch field {
		case "title":
			patch.Title = &source.Title
		case "artist":
			patch.Artist = &source.Artist
		case "album":
			patch.Album = &source.Album
		case "albumArtist":
			patch.AlbumArtist = &source.AlbumArtist
		case "genre":
			patch.Genre = &source.Genre
		case "version":
			patch.Version = &source.Version
		case "composer":
			patch.Composer = &source.Composer
		case "lyricist":
			patch.Lyricist = &source.Lyricist
		case "comment":
			patch.Comment = &source.Comment
		case "copyright":
			patch.Copyright = &source.Copyright
		case "isrc":
			patch.ISRC = &source.ISRC
		case "bpm":
			patch.BPM = &source.BPM
		case "year":
			patch.Year = &source.Year
		case "trackNumber":
			patch.TrackNumber = &source.TrackNumber
		case "discNumber":
			patch.DiscNumber = &source.DiscNumber
		case "tags":
			patch.Tags = &source.Tags
		case "aliases":
			patch.Aliases = &source.Aliases
		case "lyricsText":
			patch.LyricsText = &source.LyricsText
		case "cover":
			copyCover = true
		default:
			return Track{}, fmt.Errorf("不支持同步此字段：%w", ErrInvalid)
		}
	}
	var cover io.Reader
	if copyCover {
		if source.CoverURL == "" {
			patch.RemoveCover = true
		} else {
			file, err := os.Open(filepath.Join(s.dir, "covers", source.ID, "cover.jpg"))
			if err != nil {
				return Track{}, fmt.Errorf("无法读取来源封面，请检查后重试：%w", ErrInvalid)
			}
			defer file.Close()
			cover = file
		}
	}
	return s.editTrackLocked(ctx, id, patch, cover)
}
