package music

import (
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type mvAudioJob struct {
	Status    string `json:"status"`
	TrackID   string `json:"trackId,omitempty"`
	Track     *Track `json:"track,omitempty"`
	Duplicate bool   `json:"duplicate,omitempty"`
	Engine    string `json:"engine,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *Store) MVAudio(ctx context.Context, id string, start bool) (mvAudioJob, error) {
	mv, relative, err := s.mv(ctx, id)
	if err != nil {
		return mvAudioJob{}, err
	}
	if mv.DeletedAt != "" {
		return mvAudioJob{}, ErrNotFound
	}
	if mv.AudioCodec == "" {
		return mvAudioJob{}, fmt.Errorf("此 MV 没有音轨，请选择有声音的 MV：%w", ErrInvalid)
	}
	source, err := s.objectPath(relative)
	if err != nil {
		return mvAudioJob{}, err
	}
	s.mvJobsMu.Lock()
	defer s.mvJobsMu.Unlock()
	if job := s.mvAudioJobs[id]; job != nil && (job.Status != "error" || !start) {
		result := *job
		if result.TrackID != "" {
			track, _, _, err := s.track(ctx, result.TrackID)
			if err != nil {
				return mvAudioJob{}, err
			}
			result.Track = &track
		}
		return result, nil
	}
	if !start {
		return mvAudioJob{Status: "missing"}, nil
	}
	for _, job := range s.mvAudioJobs {
		if job.Status == "processing" {
			return mvAudioJob{}, fmt.Errorf("另一个 MV 正在提取音频，请稍后重试：%w", ErrConflict)
		}
	}
	if s.mvContext.Err() != nil {
		return mvAudioJob{}, s.mvContext.Err()
	}
	job := &mvAudioJob{Status: "processing"}
	s.mvAudioJobs = map[string]*mvAudioJob{id: job}
	s.mvWorkers.Add(1)
	go func() {
		defer s.mvWorkers.Done()
		jobCtx, cancel := context.WithTimeout(s.mvContext, 20*time.Minute)
		defer cancel()
		s.encodeMu.Lock()
		track, duplicate, engine, err := s.extractMVAudio(jobCtx, id, source)
		s.encodeMu.Unlock()
		s.mvJobsMu.Lock()
		defer s.mvJobsMu.Unlock()
		if err != nil {
			log.Printf("MV audio extraction failed: %v", err)
			*job = mvAudioJob{Status: "error", Error: "音频提取失败，请重试或检查 MV 原件。"}
		} else {
			*job = mvAudioJob{Status: "ready", TrackID: track.ID, Duplicate: duplicate, Engine: engine}
		}
	}()
	return *job, nil
}

func mvAudioFormat(codec string) (extension, muxer, encoder string) {
	switch codec {
	case "aac", "alac":
		return ".m4a", "mp4", "copy"
	case "mp3":
		return ".mp3", "mp3", "copy"
	case "flac":
		return ".flac", "flac", "copy"
	case "opus", "vorbis":
		return ".ogg", "ogg", "copy"
	default:
		return ".flac", "flac", "flac"
	}
}

func (s *Store) extractMVAudio(ctx context.Context, id, source string) (Track, bool, string, error) {
	result, err := probe(ctx, source)
	if err != nil {
		return Track{}, false, "", err
	}
	_, audio := videoStreams(result)
	if audio == nil {
		return Track{}, false, "", ErrInvalid
	}
	stage, err := os.MkdirTemp(filepath.Join(s.dir, "uploads"), ".mv-audio-")
	if err != nil {
		return Track{}, false, "", err
	}
	defer os.RemoveAll(stage)
	extension, muxer, encoder := mvAudioFormat(audio.CodecName)
	raw := filepath.Join(stage, "audio"+extension)
	args := []string{"-nostdin", "-v", "error", "-xerror", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-i", source, "-map", fmt.Sprintf("0:%d", audio.Index), "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-c:a", encoder}
	engine := "stream-copy"
	if encoder != "copy" {
		engine = "cpu-flac"
		args = append(args, "-sample_fmt", "s32")
	}
	// No seek, duration cap or shortest-stream option: retain the entire first audio stream.
	args = append(args, "-threads", "1", "-f", muxer, "-y", raw)
	if _, err = runMedia(ctx, "ffmpeg", args...); err != nil {
		return Track{}, false, engine, err
	}
	t, _, err := probeTrack(ctx, raw, "audio"+extension, "")
	if err != nil {
		return Track{}, false, engine, err
	}
	sourceDuration, _ := strconv.ParseFloat(audio.Duration, 64)
	if sourceDuration <= 0 || math.IsInf(sourceDuration, 0) || math.IsNaN(sourceDuration) {
		// Matroska commonly stores each stream's duration in a tag instead.
		for key, value := range audio.Tags {
			if strings.EqualFold(key, "duration") {
				var hours, minutes int
				var seconds float64
				if n, _ := fmt.Sscanf(value, "%d:%d:%f", &hours, &minutes, &seconds); n == 3 {
					sourceDuration = float64(hours*3600+minutes*60) + seconds
				}
			}
		}
	}
	rate, _ := strconv.Atoi(audio.SampleRate)
	if t.SampleRate != rate || t.Channels != audio.Channels || sourceDuration > 0 && !math.IsInf(sourceDuration, 0) && math.Abs(t.Duration-sourceDuration) > math.Max(0.25, sourceDuration*0.01) {
		return Track{}, false, engine, fmt.Errorf("incomplete or inconsistent extracted audio")
	}
	// Serialize only metadata and publication; extraction must not block library writes.
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.finishMetadataWrite(); err != nil {
		return Track{}, false, engine, err
	}
	mv, _, err := s.mv(ctx, id)
	if err != nil {
		return Track{}, false, engine, err
	}
	if mv.DeletedAt != "" {
		return Track{}, false, engine, ErrNotFound
	}
	t.Title = mv.Title
	if mv.Artist != "" {
		t.Artist, t.AlbumArtist = mv.Artist, mv.Artist
	}
	base := strings.TrimSuffix(mv.OriginalName, filepath.Ext(mv.OriginalName))
	t.OriginalName = base + extension
	cover := ""
	if mv.CoverURL != "" {
		cover = filepath.Join(s.dir, "covers", mv.ID+".jpg")
	}
	output := filepath.Join(stage, "tagged"+extension)
	if err = rewriteAudioTags(ctx, raw, output, t, cover, cover != ""); err != nil {
		return Track{}, false, engine, err
	}
	written, coverIndex, err := probeTrack(ctx, output, t.OriginalName, "")
	if err != nil {
		return Track{}, false, engine, err
	}
	if !sameWrittenMetadata(t, written) || cover != "" && coverIndex < 0 || t.Format != written.Format || t.SampleRate != written.SampleRate || t.Channels != written.Channels || math.Abs(t.Duration-written.Duration) > 0.1 {
		return Track{}, false, engine, fmt.Errorf("inconsistent extracted audio metadata")
	}
	hash, size, err := fileFingerprint(output)
	if err != nil {
		return Track{}, false, engine, err
	}
	track, duplicate, err := s.importAudio(ctx, Upload{Filename: t.OriginalName, Fingerprint: hash, Size: size}, "", output)
	return track, duplicate, engine, err
}
