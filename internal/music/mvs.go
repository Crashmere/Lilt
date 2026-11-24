package music

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type MV struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Artist       string  `json:"artist"`
	Duration     float64 `json:"duration"`
	Size         int64   `json:"size"`
	Width        int     `json:"width"`
	Height       int     `json:"height"`
	VideoCodec   string  `json:"videoCodec"`
	AudioCodec   string  `json:"audioCodec"`
	MIMEType     string  `json:"mimeType"`
	OriginalName string  `json:"originalName"`
	Fingerprint  string  `json:"fingerprint"`
	CoverURL     string  `json:"coverUrl"`
	Favorite     bool    `json:"favorite"`
	AddedAt      string  `json:"addedAt"`
	UpdatedAt    string  `json:"updatedAt"`
	DeletedAt    string  `json:"deletedAt,omitempty"`
}

func scanMV(row interface{ Scan(...any) error }) (MV, string, error) {
	var mv MV
	var document, relative, hash string
	var deleted sql.NullString
	err := row.Scan(&document, &relative, &hash, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return mv, "", ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(document), &mv)
	}
	mv.Fingerprint, mv.DeletedAt = hash, deleted.String
	return mv, relative, err
}

func (s *Store) mv(ctx context.Context, id string) (MV, string, error) {
	if !validID(id) {
		return MV{}, "", ErrNotFound
	}
	mv, relative, err := scanMV(s.db.QueryRowContext(ctx, "SELECT document,original_path,fingerprint,deleted_at FROM mvs WHERE id=?", id))
	if mv.CoverURL != "" {
		mv.CoverURL = s.prefix + "api/mvs/" + mv.ID + "/cover?v=" + mv.Fingerprint
	}
	return mv, relative, err
}

func (s *Store) MVs(ctx context.Context, trash bool) ([]MV, error) {
	condition := "deleted_at IS NULL"
	if trash {
		condition = "deleted_at IS NOT NULL"
	}
	rows, err := s.db.QueryContext(ctx, "SELECT document,original_path,fingerprint,deleted_at FROM mvs WHERE "+condition+" ORDER BY rowid DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []MV{}
	for rows.Next() {
		mv, _, err := scanMV(rows)
		if err != nil {
			return nil, err
		}
		if mv.CoverURL != "" {
			mv.CoverURL = s.prefix + "api/mvs/" + mv.ID + "/cover?v=" + mv.Fingerprint
		}
		all = append(all, mv)
	}
	return all, rows.Err()
}

func (s *Store) duplicateMV(ctx context.Context, hash string, size int64) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM mvs WHERE fingerprint=? AND json_extract(document,'$.size')=?", hash, size).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func videoStreams(result probeResult) (*probeStream, *probeStream) {
	var video, audio *probeStream
	for i := range result.Streams {
		stream := &result.Streams[i]
		if stream.CodecType == "video" && stream.Disposition.AttachedPic == 0 && video == nil {
			video = stream
		}
		if stream.CodecType == "audio" && audio == nil {
			audio = stream
		}
	}
	return video, audio
}

func videoType(format, filename string) string {
	switch {
	case strings.Contains(format, "mov"):
		if strings.EqualFold(filepath.Ext(filename), ".mov") {
			return "video/quicktime"
		}
		return "video/mp4"
	case strings.Contains(format, "webm") && strings.EqualFold(filepath.Ext(filename), ".webm"):
		return "video/webm"
	case strings.Contains(format, "matroska"):
		return "video/x-matroska"
	case format == "avi":
		return "video/x-msvideo"
	case format == "flv":
		return "video/x-flv"
	case format == "mpegts":
		return "video/mp2t"
	case format == "asf":
		return "video/x-ms-wmv"
	default:
		return "video/mpeg"
	}
}

func probeMV(ctx context.Context, source, filename string) (MV, *probeStream, error) {
	result, err := probe(ctx, source)
	if err != nil {
		log.Printf("MV probe rejected: %v", err)
		return MV{}, nil, fmt.Errorf("无法读取视频，请检查文件格式和内容：%w", ErrInvalid)
	}
	video, audio := videoStreams(result)
	duration, _ := strconv.ParseFloat(result.Format.Duration, 64)
	if video == nil || video.Width <= 0 || video.Height <= 0 || duration <= 0 || math.IsInf(duration, 0) || math.IsNaN(duration) {
		return MV{}, nil, fmt.Errorf("文件没有有效视频画面或时长：%w", ErrInvalid)
	}
	info, err := os.Stat(source)
	if err != nil {
		return MV{}, nil, err
	}
	tags := probeTags(result)
	mv := MV{Title: metadataValue(tags, "title"), Artist: metadataValue(tags, "artist", "performer"), Duration: duration, Size: info.Size(), Width: video.Width, Height: video.Height, VideoCodec: video.CodecName, MIMEType: videoType(result.Format.FormatName, filename), OriginalName: filename}
	if audio != nil {
		mv.AudioCodec = audio.CodecName
	}
	if mv.Title == "" {
		mv.Title = strings.TrimSuffix(filename, filepath.Ext(filename))
	}
	if mv.Title == "" {
		mv.Title = "未命名 MV"
	}
	return mv, video, nil
}

func (s *Store) CompleteMVUpload(ctx context.Context, id string) (MV, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, err := s.upload(ctx, id)
	if err != nil {
		return MV{}, false, err
	}
	if u.Kind != "mv" {
		return MV{}, false, ErrInvalid
	}
	if u.Status == "complete" {
		mv, _, err := s.mv(ctx, u.MVID)
		return mv, u.Duplicate, err
	}
	if u.Offset != u.Size {
		return MV{}, false, fmt.Errorf("文件尚未上传完整：%w", ErrConflict)
	}
	source := s.uploadPath(id)
	hash, size, err := fileFingerprint(source)
	if err != nil {
		return MV{}, false, err
	}
	if hash != u.Fingerprint || size != u.Size {
		return MV{}, false, fmt.Errorf("完整文件 SHA-256 校验失败，请取消后重新上传：%w", ErrInvalid)
	}
	existing, err := s.duplicateMV(ctx, hash, size)
	if err != nil {
		return MV{}, false, err
	}
	if existing != "" {
		if _, err = s.db.ExecContext(ctx, "UPDATE uploads SET status='complete',track_id=?,duplicate=1 WHERE id=?", existing, id); err != nil {
			return MV{}, false, err
		}
		os.Remove(source)
		mv, _, err := s.mv(ctx, existing)
		return mv, true, err
	}
	mv, video, err := probeMV(ctx, source, u.Filename)
	if err != nil {
		return MV{}, false, err
	}
	mv.ID, err = newID("m_")
	if err != nil {
		return MV{}, false, err
	}
	// Decode an initial frame before publishing; this also supplies the poster.
	if err = s.mvPoster(ctx, source, mv.ID, video.Index); err != nil {
		log.Printf("MV frame validation failed: %v", err)
		return MV{}, false, fmt.Errorf("视频画面无法解码，请检查文件内容：%w", ErrInvalid)
	}
	poster := filepath.Join(s.dir, "covers", mv.ID+".jpg")
	published := false
	defer func() {
		if !published {
			os.Remove(poster)
		}
	}()
	relative, err := s.preserveOriginal(source, hash, size, filepath.Join("originals", "videos"), ".video")
	if err != nil {
		return MV{}, false, err
	}
	mv.Fingerprint, mv.AddedAt = hash, now()
	mv.UpdatedAt, mv.CoverURL = mv.AddedAt, s.prefix+"api/mvs/"+mv.ID+"/cover?v="+hash
	document, err := json.Marshal(mv)
	if err != nil {
		return MV{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MV{}, false, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO mvs (id,fingerprint,original_path,document) VALUES (?,?,?,?)", mv.ID, hash, relative, string(document)); err != nil {
		return MV{}, false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE uploads SET status='complete',track_id=? WHERE id=?", mv.ID, id); err != nil {
		return MV{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return MV{}, false, err
	}
	published = true
	s.invalidateLibrary()
	os.Remove(source)
	return mv, false, nil
}

func (s *Store) mvPoster(ctx context.Context, source, id string, index int) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	file, err := os.CreateTemp(filepath.Join(s.dir, "covers"), ".mv-poster-*.jpg")
	if err != nil {
		return err
	}
	name := file.Name()
	file.Close()
	defer os.Remove(name)
	for _, gpu := range []bool{true, false} {
		args := []string{"-nostdin", "-v", "error", "-xerror", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats}
		if gpu {
			args = append(args, "-hwaccel", "cuda")
		}
		args = append(args, "-i", source, "-map", fmt.Sprintf("0:%d", index), "-an", "-sn", "-dn", "-frames:v", "1", "-vf", "scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease", "-c:v", "mjpeg", "-q:v", "3", "-threads", "1", "-y", name)
		_, err = runMedia(ctx, "ffmpeg", args...)
		if err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	image, err := os.Open(name)
	if err != nil {
		return err
	}
	_, err = jpeg.Decode(image)
	image.Close()
	if err != nil {
		return err
	}
	if err = syncFile(name); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(s.dir, "covers", id+".jpg")); err != nil {
		return err
	}
	return syncDir(filepath.Join(s.dir, "covers"))
}

type MVPatch struct {
	Title             *string `json:"title"`
	Artist            *string `json:"artist"`
	Favorite          *bool   `json:"favorite"`
	ExpectedUpdatedAt *string `json:"expectedUpdatedAt"`
}

func (s *Store) PatchMV(ctx context.Context, id string, patch MVPatch) (MV, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mv, _, err := s.mv(ctx, id)
	if err != nil {
		return MV{}, err
	}
	if mv.DeletedAt != "" || patch.ExpectedUpdatedAt != nil && *patch.ExpectedUpdatedAt != mv.UpdatedAt {
		return MV{}, ErrConflict
	}
	if patch.Title != nil {
		mv.Title = tidy(*patch.Title, 4096)
		if mv.Title == "" {
			return MV{}, fmt.Errorf("请输入 MV 名称：%w", ErrInvalid)
		}
	}
	if patch.Artist != nil {
		mv.Artist = tidy(*patch.Artist, 4096)
	}
	if patch.Favorite != nil {
		mv.Favorite = *patch.Favorite
	}
	mv.UpdatedAt = now()
	document, err := json.Marshal(mv)
	if err == nil {
		_, err = s.db.ExecContext(ctx, "UPDATE mvs SET document=? WHERE id=?", string(document), id)
	}
	if err == nil {
		s.invalidateLibrary()
	}
	return mv, err
}

func (s *Store) TrashMV(ctx context.Context, id string, restore bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := s.mv(ctx, id); err != nil {
		return err
	}
	var deleted any = now()
	if restore {
		deleted = nil
	}
	_, err := s.db.ExecContext(ctx, "UPDATE mvs SET deleted_at=? WHERE id=?", deleted, id)
	if err == nil {
		s.invalidateLibrary()
	}
	return err
}
