package music

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxChunkSize int64 = 32 << 20

type UploadInput struct {
	Filename       string `json:"filename"`
	Size           int64  `json:"size"`
	Fingerprint    string `json:"fingerprint"`
	RelativePath   string `json:"relativePath"`
	ReplaceTrackID string `json:"replaceTrackId,omitempty"`
}

type OffsetError struct{ Upload Upload }

func (e *OffsetError) Error() string { return "上传进度已变化，请按服务器进度重试" }

func scanUpload(row interface{ Scan(...any) error }) (Upload, error) {
	var u Upload
	err := row.Scan(&u.ID, &u.Filename, &u.Size, &u.Offset, &u.Fingerprint, &u.Status, &u.TrackID, &u.Duplicate, &u.RelativePath)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return u, err
}

const uploadColumns = "id,filename,size,offset,fingerprint,status,track_id,duplicate,relative_path"

func (s *Store) upload(ctx context.Context, id string) (Upload, error) {
	return scanUpload(s.db.QueryRowContext(ctx, "SELECT "+uploadColumns+" FROM uploads WHERE id=?", id))
}

func (s *Store) uploadPath(id string) string { return filepath.Join(s.dir, "uploads", id+".part") }

func (s *Store) reconcileUploads(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, "SELECT "+uploadColumns+" FROM uploads WHERE status='uploading'")
	if err != nil {
		return err
	}
	var all []Upload
	for rows.Next() {
		u, e := scanUpload(rows)
		if e != nil {
			rows.Close()
			return e
		}
		all = append(all, u)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, u := range all {
		if !validID(u.ID) {
			return fmt.Errorf("invalid retained upload ID")
		}
		file, err := os.OpenFile(s.uploadPath(u.ID), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return err
		}
		// Unacknowledged bytes are discarded; committed SQLite offsets define resumable progress.
		offset := min(u.Offset, info.Size())
		if info.Size() != offset {
			err = file.Truncate(offset)
			if err == nil {
				err = file.Sync()
			}
		}
		file.Close()
		if err != nil {
			return err
		}
		if offset != u.Offset {
			if _, err = s.db.ExecContext(ctx, "UPDATE uploads SET offset=? WHERE id=?", offset, u.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) Uploads(ctx context.Context) ([]Upload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reconcileUploads(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+uploadColumns+" FROM uploads WHERE status='uploading' ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []Upload{}
	for rows.Next() {
		u, e := scanUpload(rows)
		if e != nil {
			return nil, e
		}
		all = append(all, u)
	}
	return all, rows.Err()
}

func (s *Store) StartUpload(ctx context.Context, in UploadInput) (Upload, error) {
	in.Filename = tidy(filepath.Base(strings.ReplaceAll(in.Filename, "\\", "/")), 512)
	in.Fingerprint = strings.ToLower(strings.TrimSpace(in.Fingerprint))
	decoded, err := hex.DecodeString(in.Fingerprint)
	if err != nil || len(decoded) != 32 || in.Size <= 0 || in.Size > 64<<30 || in.Filename == "" || in.Filename == "." {
		return Upload{}, fmt.Errorf("文件名、大小或 SHA-256 无效：%w", ErrInvalid)
	}
	if in.ReplaceTrackID != "" && !validID(in.ReplaceTrackID) {
		return Upload{}, ErrInvalid
	}
	in.RelativePath = tidy(in.RelativePath, 4096)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.finishMetadataWrite(); err != nil {
		return Upload{}, err
	}
	if err = s.reconcileUploads(ctx); err != nil {
		return Upload{}, err
	}
	// Explicit replacement needs the supplied bytes, not a historical hash whose file was removed.
	duplicateID, err := s.duplicateTrack(ctx, in.Fingerprint, in.Size, in.ReplaceTrackID == "")
	if err != nil {
		return Upload{}, err
	}
	if duplicateID == "" {
		u, e := scanUpload(s.db.QueryRowContext(ctx, "SELECT "+uploadColumns+" FROM uploads WHERE fingerprint=? AND size=? AND status='uploading' ORDER BY created_at LIMIT 1", in.Fingerprint, in.Size))
		if e == nil {
			return u, nil
		}
		if !errors.Is(e, ErrNotFound) {
			return Upload{}, e
		}
	}
	id, err := newID("u_")
	if err != nil {
		return Upload{}, err
	}
	u := Upload{ID: id, Filename: in.Filename, Size: in.Size, Fingerprint: in.Fingerprint, Status: "uploading", RelativePath: in.RelativePath}
	if duplicateID != "" {
		u.Offset = u.Size
		u.TrackID = duplicateID
		u.Status = "complete"
		u.Duplicate = true
	} else {
		f, e := os.OpenFile(s.uploadPath(id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return Upload{}, e
		}
		err = f.Sync()
		f.Close()
		if err == nil {
			err = syncDir(filepath.Join(s.dir, "uploads"))
		}
		if err != nil {
			os.Remove(s.uploadPath(id))
			return Upload{}, err
		}
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO uploads (id,filename,size,offset,fingerprint,status,track_id,duplicate,relative_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", u.ID, u.Filename, u.Size, u.Offset, u.Fingerprint, u.Status, u.TrackID, u.Duplicate, u.RelativePath, now())
	if err != nil {
		if !u.Duplicate {
			os.Remove(s.uploadPath(id))
		}
		return Upload{}, err
	}
	return u, nil
}

func (s *Store) AppendUpload(ctx context.Context, id string, offset int64, reader io.Reader) (Upload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, err := s.upload(ctx, id)
	if err != nil {
		return Upload{}, err
	}
	if u.Status != "uploading" {
		return u, &OffsetError{Upload: u}
	}
	if offset != u.Offset {
		return u, &OffsetError{Upload: u}
	}
	f, err := os.OpenFile(s.uploadPath(id), os.O_RDWR, 0600)
	if err != nil {
		return u, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return u, err
	}
	if info.Size() != u.Offset {
		if info.Size() > u.Offset {
			err = f.Truncate(u.Offset)
		} else {
			u.Offset = info.Size()
			_, err = s.db.ExecContext(ctx, "UPDATE uploads SET offset=? WHERE id=?", u.Offset, id)
		}
		if err != nil {
			return u, err
		}
		if offset != u.Offset {
			return u, &OffsetError{Upload: u}
		}
	}
	if _, err = f.Seek(u.Offset, io.SeekStart); err != nil {
		return u, err
	}
	limit := min(MaxChunkSize+1, u.Size-u.Offset+1)
	n, copyErr := io.Copy(f, io.LimitReader(reader, limit))
	if copyErr != nil || n <= 0 || n > MaxChunkSize || u.Offset+n > u.Size {
		f.Truncate(u.Offset)
		f.Sync()
		if copyErr != nil {
			return u, copyErr
		}
		return u, fmt.Errorf("分块大小无效，单块最多 32 MiB：%w", ErrInvalid)
	}
	if err = f.Sync(); err != nil {
		f.Truncate(u.Offset)
		return u, err
	}
	if _, err = s.db.ExecContext(ctx, "UPDATE uploads SET offset=? WHERE id=?", u.Offset+n, id); err != nil {
		f.Truncate(u.Offset)
		f.Sync()
		return u, err
	}
	u.Offset += n
	return u, nil
}

func fileFingerprint(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

func (s *Store) preserveAudio(source, fingerprint string, size int64) (string, error) {
	relative := filepath.Join("originals", fingerprint[:2], fingerprint+".audio")
	path := filepath.Join(s.dir, relative)
	if _, err := os.Stat(path); err == nil {
		h, n, e := fileFingerprint(path)
		if e != nil || h != fingerprint || n != size {
			return "", fmt.Errorf("已有原始对象校验失败，未覆盖文件")
		}
		return relative, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	temp, err := os.CreateTemp(filepath.Dir(path), ".original-*")
	if err != nil {
		return "", err
	}
	name := temp.Name()
	defer os.Remove(name)
	n, err := io.Copy(temp, input)
	if err == nil && n != size {
		err = fmt.Errorf("原始文件大小发生变化")
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err = os.Link(name, path); err != nil {
		return "", err
	}
	if err = syncDir(filepath.Dir(path)); err != nil {
		return "", err
	}
	return relative, nil
}

func (s *Store) CompleteUpload(ctx context.Context, id, replaceID string) (Track, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.finishMetadataWrite(); err != nil {
		return Track{}, false, err
	}
	u, err := s.upload(ctx, id)
	if err != nil {
		return Track{}, false, err
	}
	if replaceID != "" && !validID(replaceID) {
		return Track{}, false, ErrInvalid
	}
	if u.Status == "complete" && (replaceID == "" || replaceID == u.TrackID) {
		t, _, _, err := s.track(ctx, u.TrackID)
		return t, u.Duplicate, err
	}
	if u.Offset != u.Size {
		return Track{}, false, fmt.Errorf("文件尚未上传完整：%w", ErrConflict)
	}
	source := s.uploadPath(id)
	if u.Status == "complete" {
		source = filepath.Join(s.dir, "originals", u.Fingerprint[:2], u.Fingerprint+".audio")
	}
	h, size, err := fileFingerprint(source)
	if err != nil {
		if u.Status == "complete" && os.IsNotExist(err) {
			return Track{}, false, fmt.Errorf("已完成上传的文件已更新，请重新选择文件上传：%w", ErrConflict)
		}
		return Track{}, false, err
	}
	if h != u.Fingerprint || size != u.Size {
		return Track{}, false, fmt.Errorf("完整文件 SHA-256 校验失败，请取消后重新上传：%w", ErrInvalid)
	}
	if replaceID == "" {
		existingID, err := s.duplicateTrack(ctx, h, size, true)
		if err != nil {
			return Track{}, false, err
		}
		if existingID != "" {
			if _, err = s.db.ExecContext(ctx, "UPDATE uploads SET status='complete',track_id=?,duplicate=1 WHERE id=?", existingID, id); err != nil {
				return Track{}, false, err
			}
			os.Remove(s.uploadPath(id))
			t, _, _, err := s.track(ctx, existingID)
			return t, true, err
		}
	}
	t, coverIndex, err := probeTrack(ctx, source, u.Filename, u.RelativePath)
	if err != nil {
		return Track{}, false, err
	}
	var old Track
	var oldHash, oldRelative string
	if replaceID != "" {
		old, oldHash, oldRelative, err = s.track(ctx, replaceID)
		if err != nil {
			return Track{}, false, err
		}
		if err = s.loadLegacyCredits(ctx, &old, oldRelative); err != nil {
			return Track{}, false, err
		}
		if old.DeletedAt != "" {
			return Track{}, false, fmt.Errorf("请先恢复歌曲再替换音频：%w", ErrConflict)
		}
		t.ID = old.ID
		t.Title = old.Title
		t.Artist = old.Artist
		t.Album = old.Album
		t.AlbumArtist = old.AlbumArtist
		t.Genre = old.Genre
		t.Composer, t.Lyricist, t.Comment, t.Copyright, t.ISRC, t.BPM = old.Composer, old.Lyricist, old.Comment, old.Copyright, old.ISRC, old.BPM
		t.Year = old.Year
		t.TrackNumber = old.TrackNumber
		t.DiscNumber = old.DiscNumber
		t.Version = old.Version
		t.Tags = old.Tags
		t.Aliases = old.Aliases
		t.Favorite = old.Favorite
		t.CoverURL = old.CoverURL
		t.LyricsText = old.LyricsText
		t.HasLyrics = old.HasLyrics
		t.AddedAt = old.AddedAt
	} else {
		t.ID, err = newID("t_")
		if err != nil {
			return Track{}, false, err
		}
		t.AddedAt = now()
	}
	t.UpdatedAt = now()
	relative, err := s.preserveAudio(source, h, size)
	if err != nil {
		return Track{}, false, err
	}
	if t.CoverURL == "" && s.extractCover(ctx, filepath.Join(s.dir, relative), t.ID, coverIndex) {
		t.CoverURL = s.prefix + "api/tracks/" + t.ID + "/cover"
	}
	document, err := json.Marshal(t)
	if err != nil {
		return Track{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Track{}, false, err
	}
	defer tx.Rollback()
	if replaceID != "" {
		previous, _ := json.Marshal(old)
		if _, err = tx.ExecContext(ctx, "INSERT INTO revisions (track_id,fingerprint,original_path,document,replaced_at) VALUES (?,?,?,?,?)", old.ID, oldHash, oldRelative, string(previous), now()); err != nil {
			return Track{}, false, err
		}
		_, err = tx.ExecContext(ctx, "UPDATE tracks SET fingerprint=?,original_path=?,document=? WHERE id=?", h, relative, string(document), t.ID)
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO tracks (id,fingerprint,original_path,document) VALUES (?,?,?,?)", t.ID, h, relative, string(document))
	}
	if err != nil {
		return Track{}, false, err
	}
	if replaceID != "" {
		if _, err = tx.ExecContext(ctx, "DELETE FROM track_fingerprints WHERE track_id=?", t.ID); err != nil {
			return Track{}, false, err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO track_fingerprints (fingerprint,track_id,size) VALUES (?,?,?)", h, t.ID, size); err != nil {
		return Track{}, false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE uploads SET status='complete',track_id=?,duplicate=? WHERE id=?", t.ID, u.Duplicate, id); err != nil {
		return Track{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return Track{}, false, err
	}
	s.invalidateLibrary()
	os.Remove(s.uploadPath(id))
	t, _, _, err = s.track(ctx, t.ID)
	return t, u.Duplicate, err
}

func (s *Store) CancelUpload(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, err := s.upload(ctx, id)
	if err != nil {
		return err
	}
	if u.Status != "uploading" {
		return fmt.Errorf("已完成的上传不能取消：%w", ErrConflict)
	}
	if err = os.Remove(s.uploadPath(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err = s.db.ExecContext(ctx, "DELETE FROM uploads WHERE id=?", id)
	return err
}
