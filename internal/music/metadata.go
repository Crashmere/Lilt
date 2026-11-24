package music

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

const metadataJournalKey = "pendingMetadataWrite"

type metadataWrite struct {
	Track       Track  `json:"track"`
	OldHash     string `json:"oldHash"`
	OldPath     string `json:"oldPath"`
	Hash        string `json:"hash"`
	Path        string `json:"path"`
	Staged      string `json:"staged"`
	Cover       string `json:"cover,omitempty"`
	RemoveCover bool   `json:"removeCover,omitempty"`
}

func (s *Store) editTrack(ctx context.Context, id string, p TrackPatch, cover io.Reader) (Track, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.editTrackLocked(ctx, id, p, cover)
}

func (s *Store) editTrackLocked(ctx context.Context, id string, p TrackPatch, cover io.Reader) (Track, error) {
	if err := s.finishMetadataWrite(); err != nil {
		return Track{}, err
	}
	t, oldHash, relative, err := s.track(ctx, id)
	if err != nil {
		return Track{}, err
	}
	writesAudio := p.Title != nil || p.Artist != nil || p.Album != nil || p.AlbumArtist != nil || p.Genre != nil || p.Composer != nil || p.Lyricist != nil || p.Comment != nil || p.Copyright != nil || p.ISRC != nil || p.BPM != nil || p.Year != nil || p.TrackNumber != nil || p.DiscNumber != nil || p.Version != nil || p.Tags != nil || p.Aliases != nil || p.LyricsText != nil || p.RemoveCover || cover != nil
	if writesAudio {
		if err = s.loadLegacyCredits(ctx, &t, relative); err != nil {
			return Track{}, err
		}
		// Legacy filename-derived titles must match tag readback normalization.
		t.Title = tidy(t.Title, 4096)
	}
	if err = applyTrackPatch(&t, p); err != nil {
		return Track{}, err
	}
	t.UpdatedAt = now()
	if !writesAudio {
		data, err := trackDocument(t)
		if err == nil {
			_, err = s.db.ExecContext(ctx, "UPDATE tracks SET document=? WHERE id=?", string(data), id)
			if err == nil {
				s.invalidateLibrary()
			}
		}
		return t, err
	}
	if cover != nil && p.RemoveCover {
		return Track{}, fmt.Errorf("不能同时更换和移除封面：%w", ErrInvalid)
	}
	path, err := s.objectPath(relative)
	if err != nil {
		return Track{}, err
	}
	stagedCover := ""
	if cover != nil {
		stagedCover, err = s.prepareCover(ctx, cover)
		if err != nil {
			return Track{}, err
		}
	}
	// Once journaled, staged files belong to recovery, including after a client disconnect.
	journaled := false
	defer func() {
		if !journaled && stagedCover != "" {
			os.Remove(stagedCover)
		}
	}()
	imagePath := stagedCover
	if imagePath == "" && !p.RemoveCover && t.CoverURL != "" {
		imagePath = filepath.Join(s.dir, "covers", id, "cover.jpg")
	}
	staged, err := os.CreateTemp(filepath.Dir(path), ".metadata-*.audio")
	if err != nil {
		return Track{}, err
	}
	stagedPath := staged.Name()
	staged.Close()
	defer func() {
		if !journaled {
			os.Remove(stagedPath)
		}
	}()
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if err = rewriteAudioTags(writeCtx, path, stagedPath, t, imagePath, imagePath != "" || p.RemoveCover); err != nil {
		return Track{}, err
	}
	written, coverIndex, err := probeTrack(writeCtx, stagedPath, t.OriginalName, "")
	if err != nil {
		return Track{}, err
	}
	if !sameWrittenMetadata(t, written) || (p.RemoveCover && coverIndex >= 0) || (imagePath != "" && coverIndex < 0) {
		return Track{}, fmt.Errorf("此文件格式无法完整写入所选信息，音频未修改：%w", ErrInvalid)
	}
	if written.Format != t.Format || written.SampleRate != t.SampleRate || written.Channels != t.Channels {
		return Track{}, fmt.Errorf("写回后的音轨参数发生变化，音频未修改：%w", ErrInvalid)
	}
	t.Size, t.Duration, t.Bitrate, t.BitDepth = written.Size, written.Duration, written.Bitrate, written.BitDepth
	t.Container, t.MIMEType = written.Container, written.MIMEType
	if p.RemoveCover {
		t.CoverURL = ""
	}
	if cover != nil {
		t.CoverURL = s.prefix + "api/tracks/" + id + "/cover"
	}
	s.hydrate(&t)
	hash, _, err := fileFingerprint(stagedPath)
	if err != nil {
		return Track{}, err
	}
	t.AudioVersion = hash
	if err = syncFile(stagedPath); err != nil {
		return Track{}, err
	}
	if err = syncDir(filepath.Dir(stagedPath)); err != nil {
		return Track{}, err
	}
	stagedRelative, _ := filepath.Rel(s.dir, stagedPath)
	coverRelative := ""
	if stagedCover != "" {
		coverRelative, _ = filepath.Rel(s.dir, stagedCover)
	}
	w := metadataWrite{Track: t, OldHash: oldHash, OldPath: relative, Hash: hash, Path: filepath.Join("originals", hash[:2], hash+".audio"), Staged: stagedRelative, Cover: coverRelative, RemoveCover: p.RemoveCover}
	document, err := json.Marshal(w)
	if err != nil {
		return Track{}, err
	}
	if _, err = s.db.ExecContext(ctx, "INSERT INTO settings (key,value) VALUES (?,?)", metadataJournalKey, string(document)); err != nil {
		return Track{}, err
	}
	journaled = true
	if err = s.finishMetadataWrite(); err != nil {
		return Track{}, err
	}
	s.hydrate(&t)
	return t, nil
}

func trackDocument(t Track) ([]byte, error) {
	data, err := json.Marshal(t)
	if err != nil || !t.legacyCredits {
		return data, err
	}
	// Catalog-only operations must not turn unimported legacy credits into explicit blanks.
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for _, key := range []string{"composer", "lyricist", "comment", "copyright", "isrc", "bpm"} {
		delete(fields, key)
	}
	return json.Marshal(fields)
}

func (s *Store) loadLegacyCredits(ctx context.Context, t *Track, relative string) error {
	if !t.legacyCredits {
		return nil
	}
	path, err := s.objectPath(relative)
	if err != nil {
		return err
	}
	result, err := probe(ctx, path)
	if err != nil {
		return fmt.Errorf("无法读取已有音频标签，请检查原文件：%w", ErrInvalid)
	}
	readCredits(t, probeTags(result))
	t.legacyCredits = false
	return nil
}

func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *Store) removeMetadataTemps() error {
	for _, pattern := range []string{"originals/*/.metadata-*", "originals/*/.tags-*", "originals/*/.asf-artwork-*", "covers/.cover-*"} {
		paths, err := filepath.Glob(filepath.Join(s.dir, pattern))
		if err != nil {
			return err
		}
		for _, path := range paths {
			if err = os.RemoveAll(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func sameWrittenMetadata(a, b Track) bool {
	return a.Title == b.Title && a.Artist == b.Artist && a.Album == b.Album && a.AlbumArtist == b.AlbumArtist && a.Genre == b.Genre && a.Composer == b.Composer && a.Lyricist == b.Lyricist && a.Comment == b.Comment && a.Copyright == b.Copyright && a.ISRC == b.ISRC && a.BPM == b.BPM && a.Year == b.Year && a.TrackNumber == b.TrackNumber && a.DiscNumber == b.DiscNumber && a.Version == b.Version && a.LyricsText == b.LyricsText && reflect.DeepEqual(a.Tags, b.Tags) && reflect.DeepEqual(a.Aliases, b.Aliases)
}

func (s *Store) finishMetadataWrite() error {
	var document string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key=?", metadataJournalKey).Scan(&document)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	var w metadataWrite
	if err = json.Unmarshal([]byte(document), &w); err != nil {
		return err
	}
	if !validID(w.Track.ID) || len(w.Hash) != 64 || !safeRelative(w.Path) || !safeRelative(w.OldPath) || !safeRelative(w.Staged) || w.Cover != "" && !safeRelative(w.Cover) {
		return fmt.Errorf("invalid pending metadata write")
	}
	destination := filepath.Join(s.dir, w.Path)
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	if hash, size, e := fileFingerprint(destination); e == nil {
		if hash != w.Hash || size != w.Track.Size {
			return fmt.Errorf("metadata destination integrity failure")
		}
	} else if os.IsNotExist(e) {
		staged := filepath.Join(s.dir, w.Staged)
		hash, size, err := fileFingerprint(staged)
		if err != nil {
			return err
		}
		if hash != w.Hash || size != w.Track.Size {
			return fmt.Errorf("staged metadata integrity failure")
		}
		if err = os.Rename(staged, destination); err != nil {
			return err
		}
	} else {
		return e
	}
	if err = syncDir(filepath.Dir(destination)); err != nil {
		return err
	}
	coverDir := filepath.Join(s.dir, "covers", w.Track.ID)
	coverPath := filepath.Join(coverDir, "cover.jpg")
	if w.Cover != "" {
		if err = os.MkdirAll(coverDir, 0700); err != nil {
			return err
		}
		if err = os.Rename(filepath.Join(s.dir, w.Cover), coverPath); err != nil {
			if !os.IsNotExist(err) {
				return err
			}
			// An interrupted write can recover its display derivative from the embedded cover.
			_, index, e := probeTrack(context.Background(), destination, w.Track.OriginalName, "")
			if e != nil || s.extractCover(context.Background(), destination, w.Track.ID, index) != nil {
				return fmt.Errorf("cannot recover written artwork")
			}
		}
		if err = syncDir(coverDir); err != nil {
			return err
		}
	} else if w.RemoveCover {
		if err = os.Remove(coverPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	data, err := json.Marshal(w.Track)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT OR IGNORE INTO track_fingerprints (fingerprint,track_id,size)
SELECT fingerprint,id,json_extract(document,'$.size') FROM tracks WHERE id=?`, w.Track.ID); err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE tracks SET fingerprint=?,original_path=?,document=? WHERE id=?", w.Hash, w.Path, string(data), w.Track.ID); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT OR IGNORE INTO track_fingerprints (fingerprint,track_id,size) VALUES (?,?,?)", w.Hash, w.Track.ID, w.Track.Size); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.invalidateLibrary()
	// Shared audio and explicit upload revisions remain owned; editing creates no revision.
	if w.OldPath != w.Path {
		var refs int
		if err = s.db.QueryRow("SELECT (SELECT COUNT(*) FROM tracks WHERE original_path=?)+(SELECT COUNT(*) FROM revisions WHERE original_path=?)", w.OldPath, w.OldPath).Scan(&refs); err != nil {
			return err
		}
		if refs == 0 {
			if err = os.Remove(filepath.Join(s.dir, w.OldPath)); err != nil && !os.IsNotExist(err) {
				return err
			}
			if err = syncDir(filepath.Dir(filepath.Join(s.dir, w.OldPath))); err != nil {
				return err
			}
		}
	}
	if w.OldHash != w.Hash {
		var refs int
		if err = s.db.QueryRow("SELECT COUNT(*) FROM tracks WHERE fingerprint=?", w.OldHash).Scan(&refs); err != nil {
			return err
		}
		if refs == 0 {
			if err = os.RemoveAll(filepath.Join(s.dir, "playback", w.OldHash)); err != nil {
				return err
			}
		}
	}
	if err = os.Remove(filepath.Join(s.dir, w.Staged)); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err = s.db.Exec("DELETE FROM settings WHERE key=?", metadataJournalKey)
	return err
}

func audioMetadata(result probeResult, t Track) map[string]string {
	tags := probeTags(result)
	for key := range tags {
		switch key {
		case "title", "artist", "performer", "album", "album_artist", "albumartist", "album artist", "genre", "composer", "lyricist", "text", "writer", "comment", "description", "copyright", "isrc", "tsrc", "bpm", "tbpm", "date", "year", "originaldate", "track", "tracknumber", "track_number", "disc", "discnumber", "disc_number", "version", "subtitle", "lyrics", "syncedlyrics", "unsyncedlyrics", "unsynchronised_lyrics", "lilt_tags", "lilt_aliases", "metadata_block_picture", "cover art (front)":
			delete(tags, key)
		}
		if strings.HasPrefix(key, "lyrics-") {
			delete(tags, key)
		}
	}
	number := func(value int) string {
		if value == 0 {
			return ""
		}
		return strconv.Itoa(value)
	}
	bpm := ""
	if t.BPM != 0 {
		bpm = strconv.FormatFloat(t.BPM, 'f', -1, 64)
	}
	for key, value := range map[string]string{"title": t.Title, "artist": t.Artist, "album": t.Album, "album_artist": t.AlbumArtist, "genre": t.Genre, "composer": t.Composer, "lyricist": t.Lyricist, "comment": t.Comment, "copyright": t.Copyright, "isrc": t.ISRC, "bpm": bpm, "date": number(t.Year), "track": number(t.TrackNumber), "disc": number(t.DiscNumber), "version": t.Version, "lyrics": t.LyricsText} {
		tags[key] = value
	}
	for key, values := range map[string][]string{"lilt_tags": t.Tags, "lilt_aliases": t.Aliases} {
		data, _ := json.Marshal(values)
		tags[key] = string(data)
	}
	return tags
}

func rewriteAudioTags(ctx context.Context, source, output string, t Track, coverPath string, changeCover bool) error {
	result, err := probe(ctx, source)
	if err != nil {
		return err
	}
	tags := audioMetadata(result, t)
	if t.Container == "ape" || t.Container == "wv" || t.Container == "tta" {
		return writeAPETags(source, output, tags, coverPath)
	}
	if t.Container == "dsf" {
		return writeDSFTags(source, output, tags, coverPath)
	}
	if t.Container == "adts" {
		return writeADTSID3(source, output, tags, coverPath)
	}
	if t.Container == "wav" {
		return writeWAVTags(source, output, tags, coverPath)
	}
	muxer := t.Container
	opts := []string{}
	switch muxer {
	case "mp3":
		opts = []string{"-id3v2_version", "4", "-write_id3v1", "0"}
	case "mp4":
		// A trailing moov allows adding standard iTunes freeform fields without moving audio.
	case "adts", "aiff":
		opts = []string{"-write_id3v2", "1"}
	case "flac", "ogg", "asf", "matroska", "webm":
	default:
		return fmt.Errorf("此音频格式暂不支持安全写回，请使用 MP3、FLAC 或 M4A 文件：%w", ErrInvalid)
	}
	if muxer == "ogg" && coverPath != "" {
		data, err := os.ReadFile(coverPath)
		if err != nil {
			return err
		}
		tags["metadata_block_picture"] = base64.StdEncoding.EncodeToString(flacPicture(data))
	}
	metadataPath, err := os.MkdirTemp(filepath.Dir(output), ".tags-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(metadataPath)
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	args := []string{"-nostdin", "-v", "error", "-y", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-i", source}
	if changeCover && coverPath != "" {
		args = append(args, "-i", coverPath)
	}
	args = append(args, "-map", "0")
	if changeCover || muxer == "ogg" || muxer == "asf" {
		args = append(args, "-map", "-0:v?")
	}
	if changeCover && coverPath != "" && muxer != "ogg" && muxer != "asf" {
		args = append(args, "-map", "1:v:0", "-disposition:v:0", "attached_pic", "-metadata:s:v:0", "title=Album cover", "-metadata:s:v:0", "comment=Cover (front)")
	}
	args = append(args, "-map_metadata", "-1", "-map_metadata:s:a", "-1", "-c", "copy")
	// File-valued options preserve multiline lyrics and avoid OS argument-size limits.
	for i, key := range keys {
		path := filepath.Join(metadataPath, strconv.Itoa(i))
		if err = os.WriteFile(path, []byte(key+"="+tags[key]), 0600); err != nil {
			return err
		}
		args = append(args, "-/metadata", path, "-/metadata:s:a", path)
	}
	args = append(args, opts...)
	args = append(args, "-f", muxer, output)
	if _, err = runMedia(ctx, "ffmpeg", args...); err != nil {
		log.Printf("metadata write failed: %v", err)
		return fmt.Errorf("此文件无法安全写回所选信息，音频未修改：%w", ErrInvalid)
	}
	if muxer == "mp4" {
		return addMP4Tags(output, tags)
	}
	if muxer == "asf" && coverPath != "" {
		return addASFArtwork(output, coverPath)
	}
	return nil
}

func flacPicture(data []byte) []byte {
	var result []byte
	put := func(value uint32) { result = binary.BigEndian.AppendUint32(result, value) }
	put(3)
	put(10)
	result = append(result, "image/jpeg"...)
	put(0)
	put(0)
	put(0)
	put(24)
	put(0)
	put(uint32(len(data)))
	return append(result, data...)
}
