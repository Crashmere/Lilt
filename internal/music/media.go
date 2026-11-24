package music

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
)

const allowedFormats = "aac,aiff,ape,asf,avi,dsf,flac,flv,matroska,webm,mov,mp3,mpeg,mpegts,wav,wv,tta,ogg"

type probeStream struct {
	Index         int               `json:"index"`
	CodecType     string            `json:"codec_type"`
	CodecName     string            `json:"codec_name"`
	SampleRate    string            `json:"sample_rate"`
	Channels      int               `json:"channels"`
	BitsPerSample int               `json:"bits_per_sample"`
	BitsRaw       string            `json:"bits_per_raw_sample"`
	BitRate       string            `json:"bit_rate"`
	Duration      string            `json:"duration"`
	Width         int               `json:"width"`
	Height        int               `json:"height"`
	PixelFormat   string            `json:"pix_fmt"`
	ColorTransfer string            `json:"color_transfer"`
	Tags          map[string]string `json:"tags"`
	Disposition   struct {
		AttachedPic int `json:"attached_pic"`
	} `json:"disposition"`
}

type probeResult struct {
	Streams []probeStream `json:"streams"`
	Format  struct {
		FormatName string            `json:"format_name"`
		Duration   string            `json:"duration"`
		BitRate    string            `json:"bit_rate"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, fmt.Errorf("media tool output exceeds limit")
	}
	return b.Buffer.Write(p)
}

func runMedia(ctx context.Context, name string, args ...string) ([]byte, error) {
	return runMediaWithFiles(ctx, nil, name, args...)
}

func runMediaWithFiles(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.ExtraFiles = files
	out := &boundedBuffer{limit: 4 << 20}
	log := &boundedBuffer{limit: 64 << 10}
	cmd.Stdout = out
	cmd.Stderr = log
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(log.String())
		if len(message) > 1000 {
			message = message[len(message)-1000:]
		}
		return nil, fmt.Errorf("%s failed: %w: %s", name, err, message)
	}
	return out.Bytes(), nil
}

func probe(ctx context.Context, path string) (probeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	output, err := runMedia(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-show_format", "-show_streams", "-of", "json", path)
	var result probeResult
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(output, &result)
	return result, err
}

func probeTags(result probeResult) map[string]string {
	tags := map[string]string{}
	for key, value := range result.Format.Tags {
		tags[strings.ToLower(key)] = value
	}
	for _, stream := range result.Streams {
		if stream.CodecType == "audio" {
			for key, value := range stream.Tags {
				tags[strings.ToLower(key)] = value
			}
			break
		}
	}
	return tags
}

func metadataValue(tags map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(tags[key]); value != "" {
			return tidy(value, 4096)
		}
	}
	return ""
}

var lyricTimestamp = regexp.MustCompile(`\[\d+:\d{2}(?:[.:]\d+)?\]`)
var lyricMetadataHeader = regexp.MustCompile(`(?i)^\[(?:ar|ti|al|by|offset|length|re|ve):[^\]]*\]\s*$`)

func lyricCreditTiming(line string) (valid, timed bool) {
	if !strings.HasPrefix(line, "{") {
		return false, false
	}
	var credit struct {
		Time    *float64 `json:"t"`
		Content []struct {
			Text *string `json:"tx"`
		} `json:"c"`
	}
	if err := json.Unmarshal([]byte(line), &credit); err != nil || len(credit.Content) == 0 {
		return false, false
	}
	for _, part := range credit.Content {
		if part.Text == nil {
			return false, false
		}
	}
	return true, credit.Time != nil
}

func lyricsType(text string) string {
	if strings.TrimSpace(text) == "" {
		return "none"
	}
	timed := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || lyricMetadataHeader.MatchString(line) {
			continue
		}
		if credit, creditTimed := lyricCreditTiming(line); credit {
			timed = timed || creditTimed
			continue
		}
		if position := lyricTimestamp.FindStringIndex(line); position == nil || position[0] != 0 {
			return "txt"
		}
		timed = true
	}
	if timed {
		return "lrc"
	}
	return "txt"
}

func lyricMetadata(tags map[string]string) string {
	keys := []string{"lyrics", "syncedlyrics", "unsyncedlyrics", "unsynchronised_lyrics"}
	var languages []string
	for key := range tags {
		if strings.HasPrefix(key, "lyrics-") {
			languages = append(languages, key)
		}
	}
	sort.Strings(languages)
	keys = append(keys, languages...)
	var plain string
	for _, key := range keys {
		value := tags[key]
		if strings.TrimSpace(value) == "" || len(value) > 1<<20 || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
			continue
		}
		// Timed lyrics take precedence over plain alternatives in the same file.
		if lyricTimestamp.MatchString(value) {
			return value
		}
		if plain == "" {
			plain = value
		}
	}
	return plain
}

func readCredits(t *Track, tags map[string]string) {
	t.Composer, t.Lyricist = metadataValue(tags, "composer"), metadataValue(tags, "lyricist", "text", "writer")
	t.Comment, t.Copyright, t.ISRC = metadataValue(tags, "comment", "description"), metadataValue(tags, "copyright"), metadataValue(tags, "isrc", "tsrc")
	t.BPM, _ = strconv.ParseFloat(metadataValue(tags, "bpm", "tbpm"), 64)
	if math.IsNaN(t.BPM) || math.IsInf(t.BPM, 0) || t.BPM < 0 || t.BPM > 9999 {
		t.BPM = 0
	}
}

func embeddedCoverIndex(result probeResult) int {
	for _, stream := range result.Streams {
		if stream.CodecType == "video" && stream.Disposition.AttachedPic == 1 && stream.Width > 0 && stream.Height > 0 {
			return stream.Index
		}
	}
	return -1
}

func probeTrack(ctx context.Context, path, filename, relativePath string) (Track, int, error) {
	result, err := probe(ctx, path)
	if err != nil {
		log.Printf("audio probe rejected file: %v", err)
		return Track{}, -1, fmt.Errorf("无法读取音频，请确认文件格式和内容有效：%w", ErrInvalid)
	}
	var audio *probeStream
	cover := embeddedCoverIndex(result)
	for i := range result.Streams {
		stream := &result.Streams[i]
		if stream.CodecType == "audio" && audio == nil {
			audio = stream
		}
		if stream.CodecType == "video" {
			if stream.Disposition.AttachedPic != 1 {
				return Track{}, -1, fmt.Errorf("请上传音频文件，而不是视频：%w", ErrInvalid)
			}
		}
	}
	if audio == nil {
		return Track{}, -1, fmt.Errorf("文件中没有可播放的音轨：%w", ErrInvalid)
	}
	duration, _ := strconv.ParseFloat(audio.Duration, 64)
	if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		duration, _ = strconv.ParseFloat(result.Format.Duration, 64)
	}
	if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return Track{}, -1, fmt.Errorf("无法确定音频时长：%w", ErrInvalid)
	}
	info, err := os.Stat(path)
	if err != nil {
		return Track{}, -1, err
	}
	tags := probeTags(result)
	find := func(keys ...string) string {
		return metadataValue(tags, keys...)
	}
	t := Track{Title: find("title"), Artist: find("artist", "performer"), Album: find("album"), AlbumArtist: find("album_artist", "albumartist", "album artist"), Genre: find("genre"), Version: find("version", "subtitle"), Duration: duration, Size: info.Size(), Format: audio.CodecName, Channels: audio.Channels, OriginalName: filename, Tags: []string{}, Aliases: []string{}}
	t.Container, t.MIMEType = containerType(result.Format.FormatName, filename)
	if t.Container == "dsf" {
		file, err := os.Open(path)
		if err != nil {
			return Track{}, -1, err
		}
		var header [80]byte
		_, err = file.ReadAt(header[:], 0)
		file.Close()
		if err != nil || string(header[28:32]) != "fmt " {
			return Track{}, -1, ErrInvalid
		}
		rate, samples := binary.LittleEndian.Uint32(header[56:60]), binary.LittleEndian.Uint64(header[64:72])
		if rate == 0 || samples == 0 {
			return Track{}, -1, ErrInvalid
		}
		// FFprobe may estimate DSF duration from file size, which also includes tags.
		t.Duration = float64(samples) / float64(rate)
	}
	t.SampleRate, _ = strconv.Atoi(audio.SampleRate)
	if t.SampleRate <= 0 || t.Channels <= 0 || t.Channels > 64 {
		return Track{}, -1, fmt.Errorf("音频参数无效：%w", ErrInvalid)
	}
	decodeCtx, cancelDecode := context.WithTimeout(ctx, 60*time.Second)
	defer cancelDecode()
	if _, err = runMedia(decodeCtx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "2", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-threads", "1", "-f", "null", "-"); err != nil {
		log.Printf("audio decode rejected file: %v", err)
		return Track{}, -1, fmt.Errorf("音轨无法解码，请检查文件内容：%w", ErrInvalid)
	}
	t.BitDepth, _ = strconv.Atoi(audio.BitsRaw)
	if t.BitDepth == 0 {
		t.BitDepth = audio.BitsPerSample
	}
	t.Bitrate, _ = strconv.ParseInt(audio.BitRate, 10, 64)
	if t.Bitrate <= 0 {
		t.Bitrate, _ = strconv.ParseInt(result.Format.BitRate, 10, 64)
	}
	if t.Bitrate <= 0 {
		t.Bitrate = int64(float64(t.Size) * 8 / duration)
	}
	t.Year = numberPrefix(find("date", "year", "originaldate"))
	readCredits(&t, tags)
	t.TrackNumber = numberPrefix(find("track", "tracknumber", "track_number"))
	t.DiscNumber = numberPrefix(find("disc", "discnumber", "disc_number"))
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	if t.Title == "" {
		if match := numberedFilename.FindStringSubmatch(base); len(match) > 0 {
			t.Title = match[2]
			if t.TrackNumber == 0 {
				t.TrackNumber, _ = strconv.Atoi(match[1])
			}
		} else {
			t.Title = base
		}
	}
	t.Title = tidy(t.Title, 4096)
	parts := strings.Split(strings.Trim(strings.ReplaceAll(relativePath, "\\", "/"), "/"), "/")
	if t.Album == "" && len(parts) >= 2 {
		t.Album = tidy(parts[len(parts)-2], 4096)
	}
	if t.Artist == "" && len(parts) >= 3 {
		t.Artist = tidy(parts[len(parts)-3], 4096)
	}
	if t.Title == "" {
		t.Title = "未命名歌曲"
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
	t.LyricsText = lyricMetadata(tags)
	for key, target := range map[string]*[]string{"lilt_tags": &t.Tags, "lilt_aliases": &t.Aliases} {
		var values []string
		if json.Unmarshal([]byte(tags[key]), &values) == nil {
			if cleaned, err := cleanList(values); err == nil {
				*target = cleaned
			}
		}
	}
	t.HasLyrics = t.LyricsText != ""
	return t, cover, nil
}

var numberedFilename = regexp.MustCompile(`^(\d{1,3})[\s._-]+(.+)$`)

func numberPrefix(value string) int {
	i := 0
	for i < len(value) && value[i] >= '0' && value[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0
	}
	n, _ := strconv.Atoi(value[:i])
	return n
}

func tidy(value string, limit int) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	value = strings.ToValidUTF8(value, "")
	if len(value) > limit {
		value = value[:limit]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

func (s *Store) extractCover(ctx context.Context, path, trackID string, index int) error {
	if index < 0 {
		return fmt.Errorf("音频中没有可提取的封面：%w", ErrInvalid)
	}
	source, err := os.CreateTemp("", "lilt-embedded-cover-*")
	if err != nil {
		return err
	}
	defer os.Remove(source.Name())
	defer source.Close()
	// Copy compressed artwork; libvips handles image decoding and resizing.
	extractCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	_, err = runMedia(extractCtx, "ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-i", path, "-map", fmt.Sprintf("0:%d", index), "-frames:v", "1", "-c:v", "copy", "-f", "image2", "-update", "1", source.Name())
	cancel()
	if err != nil {
		return err
	}
	name, err := s.normalizeCover(ctx, source.Name())
	if err != nil {
		return err
	}
	defer os.Remove(name)
	dir := filepath.Join(s.dir, "covers", trackID)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err = syncDir(filepath.Dir(dir)); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(dir, "cover.jpg")); err != nil {
		return err
	}
	return syncDir(dir)
}

func (s *Store) prepareCover(ctx context.Context, reader io.Reader) (string, error) {
	// Reuse the HTTP upload spool; libvips reads large images without a full Go-heap decode.
	source, fileInput := reader.(*os.File)
	if fileInput {
		position, err := source.Seek(0, io.SeekCurrent)
		if err != nil {
			return "", err
		}
		fileInput = position == 0
	}
	if !fileInput {
		temp, err := os.CreateTemp("", "lilt-cover-input-*")
		if err != nil {
			return "", err
		}
		defer os.Remove(temp.Name())
		defer temp.Close()
		if _, err = io.Copy(temp, reader); err != nil {
			return "", err
		}
		if _, err = temp.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		source = temp
	}
	config, format, err := image.DecodeConfig(source)
	if err != nil || (format != "jpeg" && format != "png" && format != "gif" && format != "webp") {
		return "", fmt.Errorf("请上传 JPEG、PNG、GIF 或 WebP 封面：%w", ErrInvalid)
	}
	if config.Width < 1 || config.Height < 1 {
		return "", fmt.Errorf("封面尺寸无效：%w", ErrInvalid)
	}
	return s.normalizeCover(ctx, source.Name())
}

func (s *Store) normalizeCover(ctx context.Context, source string) (string, error) {
	dir := filepath.Join(s.dir, "covers")
	temp, err := os.CreateTemp(dir, ".cover-*.jpg")
	if err != nil {
		return "", err
	}
	name := temp.Name()
	prepared := false
	defer func() {
		if !prepared {
			os.Remove(name)
		}
	}()
	if err = temp.Close(); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	_, err = runMedia(ctx, "vips", "--vips-concurrency=1", "--vips-cache-max=0", "--vips-cache-max-memory=16777216", "--vips-disc-threshold=16777216", "thumbnail", source, name+"[Q=90,strip]", "1600", "--height=1600", "--size=down", "--fail-on=error")
	if err != nil {
		log.Printf("cover normalization failed: %v", err)
		return "", fmt.Errorf("无法处理封面，请确认图片完整后重试：%w", ErrInvalid)
	}
	output, err := os.Open(name)
	if err != nil {
		return "", err
	}
	img, err := jpeg.Decode(output)
	if err == nil && (img.Bounds().Dx() < 1 || img.Bounds().Dy() < 1 || img.Bounds().Dx() > 1600 || img.Bounds().Dy() > 1600) {
		err = fmt.Errorf("cover normalization produced invalid dimensions")
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err = syncDir(dir); err != nil {
		return "", err
	}
	prepared = true
	return name, nil
}

func (s *Store) SetCover(ctx context.Context, id string, reader io.Reader) (Track, error) {
	return s.editTrack(ctx, id, TrackPatch{}, reader)
}

type PlaybackInfo struct {
	Path       string `json:"-"`
	Format     string `json:"format"`
	Bitrate    int64  `json:"bitrate"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
}

func (s *Store) playback(ctx context.Context, track Track, fingerprint, original, quality string) (PlaybackInfo, error) {
	if quality == "original" {
		return PlaybackInfo{Path: original, Format: track.Format, Bitrate: track.Bitrate, SampleRate: track.SampleRate, Channels: track.Channels}, nil
	}
	if quality != "standard" && quality != "compact" {
		return PlaybackInfo{}, ErrInvalid
	}
	dir := filepath.Join(s.dir, "playback", fingerprint)
	path := filepath.Join(dir, quality+".m4a")
	meta := filepath.Join(dir, quality+".json")
	cached := func() (PlaybackInfo, bool) {
		if data, err := os.ReadFile(meta); err == nil {
			var info PlaybackInfo
			if json.Unmarshal(data, &info) == nil {
				if stat, e := os.Stat(path); e == nil && stat.Size() > 0 {
					info.Path = path
					return info, true
				}
			}
		}
		return PlaybackInfo{}, false
	}
	if info, ok := cached(); ok {
		return info, nil
	}
	s.encodeMu.Lock()
	defer s.encodeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return PlaybackInfo{}, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return PlaybackInfo{}, err
	}
	if info, ok := cached(); ok {
		return info, nil
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		temp, err := os.CreateTemp(dir, ".encode-*.m4a")
		if err != nil {
			return PlaybackInfo{}, err
		}
		name := temp.Name()
		temp.Close()
		defer os.Remove(name)
		bitrate := "192k"
		if quality == "compact" {
			bitrate = "96k"
		}
		channels := min(max(track.Channels, 1), 2)
		rate := min(max(track.SampleRate, 8000), 48000)
		ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		_, err = runMedia(ctx, "ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", allowedFormats, "-i", original, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", bitrate, "-ac", strconv.Itoa(channels), "-ar", strconv.Itoa(rate), "-threads", "1", "-movflags", "+faststart", "-f", "ipod", name)
		if err != nil {
			return PlaybackInfo{}, fmt.Errorf("兼容音频生成失败：%w", err)
		}
		f, err := os.Open(name)
		if err != nil {
			return PlaybackInfo{}, err
		}
		err = f.Sync()
		f.Close()
		if err != nil {
			return PlaybackInfo{}, err
		}
		if err = os.Rename(name, path); err != nil {
			return PlaybackInfo{}, err
		}
		if err = syncDir(dir); err != nil {
			return PlaybackInfo{}, err
		}
	}
	result, err := probe(ctx, path)
	if err != nil {
		return PlaybackInfo{}, err
	}
	info := PlaybackInfo{Path: path, Format: "aac"}
	for _, stream := range result.Streams {
		if stream.CodecType == "audio" {
			info.Bitrate, _ = strconv.ParseInt(stream.BitRate, 10, 64)
			info.SampleRate, _ = strconv.Atoi(stream.SampleRate)
			info.Channels = stream.Channels
			break
		}
	}
	if info.Bitrate <= 0 {
		info.Bitrate, _ = strconv.ParseInt(result.Format.BitRate, 10, 64)
	}
	if err = writeJSONFile(meta, info); err != nil {
		return PlaybackInfo{}, err
	}
	return info, nil
}

func audioType(format string) string {
	switch strings.ToLower(format) {
	case "mp3":
		return "audio/mpeg"
	case "flac":
		return "audio/flac"
	case "aac", "alac":
		return "audio/mp4"
	case "opus", "vorbis":
		return "audio/ogg"
	case "wmav1", "wmav2", "wmapro", "wmalossless":
		return "audio/x-ms-wma"
	case "ape":
		return "audio/ape"
	default:
		return "application/octet-stream"
	}
}

func containerType(format, filename string) (string, string) {
	container := strings.Split(format, ",")[0]
	switch container {
	case "mov":
		return "mp4", "audio/mp4"
	case "aac":
		return "adts", "audio/aac"
	case "wav":
		return "wav", "audio/wav"
	case "aiff":
		return "aiff", "audio/aiff"
	case "mp3":
		return "mp3", "audio/mpeg"
	case "flac":
		return "flac", "audio/flac"
	case "ogg":
		return "ogg", "audio/ogg"
	case "asf":
		return "asf", "audio/x-ms-wma"
	case "matroska":
		if strings.EqualFold(filepath.Ext(filename), ".webm") {
			return "webm", "audio/webm"
		}
		return "matroska", "audio/x-matroska"
	default:
		return container, audioType(container)
	}
}
