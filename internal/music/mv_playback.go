package music

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type mvPlaybackJob struct {
	Status   string `json:"status"`
	URL      string `json:"url,omitempty"`
	Engine   string `json:"engine,omitempty"`
	Fallback string `json:"fallback,omitempty"`
	Error    string `json:"error,omitempty"`
}

const mvPlaybackRecipe = "mp4-h264-aac-1080-v1"

func (s *Store) mvPlaybackPath(hash string) string {
	return filepath.Join(s.dir, "playback", "mv", hash+"-"+mvPlaybackRecipe+".mp4")
}

func (s *Store) removeMVTemps() error {
	for _, directory := range []string{filepath.Join(s.dir, "covers"), filepath.Join(s.dir, "playback", "mv"), filepath.Join(s.dir, "uploads")} {
		entries, err := os.ReadDir(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), ".mv-audio-") {
				if err = os.RemoveAll(filepath.Join(directory, entry.Name())); err != nil {
					return err
				}
			}
			if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), ".mv-") {
				if err = os.Remove(filepath.Join(directory, entry.Name())); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (s *Store) MVPlayback(ctx context.Context, id string, start bool) (mvPlaybackJob, error) {
	mv, relative, err := s.mv(ctx, id)
	if err != nil {
		return mvPlaybackJob{}, err
	}
	if mv.DeletedAt != "" {
		return mvPlaybackJob{}, ErrNotFound
	}
	source, err := s.objectPath(relative)
	if err != nil {
		return mvPlaybackJob{}, err
	}
	s.mvJobsMu.Lock()
	defer s.mvJobsMu.Unlock()
	output := s.mvPlaybackPath(mv.Fingerprint)
	if info, err := os.Stat(output); err == nil && info.Size() > 0 {
		var ready mvPlaybackJob
		if data, err := os.ReadFile(output + ".json"); err == nil && json.Unmarshal(data, &ready) == nil && ready.Status == "ready" {
			ready.URL = s.prefix + "api/mvs/" + id + "/stream?quality=compatible&v=" + mv.Fingerprint
			return ready, nil
		}
	}
	if job := s.mvJobs[mv.Fingerprint]; job != nil {
		if job.Status == "processing" || !start {
			return *job, nil
		}
	}
	if !start {
		return mvPlaybackJob{Status: "missing"}, nil
	}
	for _, job := range s.mvJobs {
		if job.Status == "processing" {
			return mvPlaybackJob{}, fmt.Errorf("另一个 MV 正在准备兼容播放，请稍后重试：%w", ErrConflict)
		}
	}
	if s.mvContext.Err() != nil {
		return mvPlaybackJob{}, s.mvContext.Err()
	}
	// One MV job per application; share the encoding budget with audio derivatives.
	job := &mvPlaybackJob{Status: "processing"}
	s.mvJobs = map[string]*mvPlaybackJob{mv.Fingerprint: job}
	s.mvWorkers.Add(1)
	go func() {
		defer s.mvWorkers.Done()
		jobCtx, cancel := context.WithTimeout(s.mvContext, 20*time.Minute)
		defer cancel()
		s.encodeMu.Lock()
		result, err := s.encodeMV(jobCtx, mv, source, output)
		s.encodeMu.Unlock()
		s.mvJobsMu.Lock()
		defer s.mvJobsMu.Unlock()
		if err != nil {
			log.Printf("MV compatible encoding failed: %v", err)
			*job = mvPlaybackJob{Status: "error", Error: "兼容播放准备失败，请重试或下载原件。"}
		} else {
			*job = result
		}
	}()
	return *job, nil
}

func (s *Store) encodeMV(ctx context.Context, mv MV, source, output string) (mvPlaybackJob, error) {
	result, err := probe(ctx, source)
	if err != nil {
		return mvPlaybackJob{}, err
	}
	video, audio := videoStreams(result)
	if video == nil {
		return mvPlaybackJob{}, ErrInvalid
	}
	hdr := video.ColorTransfer == "smpte2084" || video.ColorTransfer == "arib-std-b67"
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return mvPlaybackJob{}, err
	}
	temp, err := os.CreateTemp(filepath.Dir(output), ".mv-*.mp4")
	if err != nil {
		return mvPlaybackJob{}, err
	}
	name := temp.Name()
	temp.Close()
	defer os.Remove(name)
	modes := []string{"nvenc-cuda", "nvenc-software", "cpu"}
	if hdr {
		modes = []string{"nvenc-software", "cpu"}
	}
	fallback := ""
	if hdr {
		fallback = "HDR 色彩映射使用 CPU"
	}
	for _, mode := range modes {
		if ctx.Err() != nil {
			return mvPlaybackJob{}, ctx.Err()
		}
		args := []string{"-nostdin", "-v", "error", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats}
		gpu := mode != "cpu"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if mode == "nvenc-cuda" {
			args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-extra_hw_frames", "2")
		}
		args = append(args, "-i", source, "-map", fmt.Sprintf("0:%d", video.Index))
		if audio != nil {
			args = append(args, "-map", fmt.Sprintf("0:%d", audio.Index))
		}
		filters := []string{}
		if hdr {
			filters = append(filters, "zscale=t=linear:npl=100", "format=gbrpf32le", "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=limited", "format=yuv420p")
		}
		const scale = "w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
		if gpu {
			if mode != "nvenc-cuda" {
				filters = append(filters, "format=nv12", "hwupload")
			}
			filters = append(filters, "scale_cuda="+scale+":format=nv12")
		} else {
			filters = append(filters, "scale="+scale, "format=yuv420p")
		}
		args = append(args, "-vf", strings.Join(filters, ","), "-fps_mode", "vfr")
		if gpu {
			args = append(args, "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-maxrate", "8M", "-bufsize", "8M", "-surfaces", "8", "-rc-lookahead", "0")
		} else {
			args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-maxrate", "8M", "-bufsize", "8M")
		}
		args = append(args, "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-threads", "1", "-y", name)
		_, err = runMedia(ctx, "ffmpeg", args...)
		if err == nil {
			var check probeResult
			check, err = probe(ctx, name)
			v, a := videoStreams(check)
			if err == nil && (v == nil || v.CodecName != "h264" || v.Width > 1920 || v.Height > 1080 || audio != nil && (a == nil || a.CodecName != "aac")) {
				err = fmt.Errorf("inconsistent MV playback streams")
			}
			if err == nil {
				var encoded MV
				encoded, _, err = probeMV(ctx, name, "playback.mp4")
				if err == nil && math.Abs(encoded.Duration-mv.Duration) > math.Max(2, mv.Duration*0.01) {
					err = fmt.Errorf("incomplete MV playback duration")
				}
			}
		}
		if err != nil {
			log.Printf("MV playback %s failed: %v", mode, err)
			if mode == "nvenc-cuda" {
				fallback = "CUDA 解码不可用，使用 CPU 解码"
			}
			if mode == "nvenc-software" {
				fallback = "GPU 编码不可用，使用 CPU"
			}
			continue
		}
		ready := mvPlaybackJob{Status: "ready", Engine: mode, Fallback: fallback}
		if err = syncFile(name); err != nil {
			return mvPlaybackJob{}, err
		}
		if err = os.Rename(name, output); err != nil {
			return mvPlaybackJob{}, err
		}
		data, _ := json.Marshal(ready)
		if err = os.WriteFile(output+".json", data, 0600); err != nil {
			return mvPlaybackJob{}, err
		}
		if err = syncFile(output + ".json"); err != nil {
			return mvPlaybackJob{}, err
		}
		if err = syncDir(filepath.Dir(output)); err != nil {
			return mvPlaybackJob{}, err
		}
		return ready, nil
	}
	return mvPlaybackJob{}, err
}
