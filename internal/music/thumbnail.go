package music

import (
	"context"
	"fmt"
	"image/jpeg"
	"os"
	"strconv"
	"time"
)

// Keep derivatives in bounded memory; no catalog lock or new persistent resource is needed.
func (s *server) coverThumbnail(ctx context.Context, source *os.File, version, size string) ([]byte, error) {
	key := source.Name() + ":" + version + ":" + size
	s.thumbnailMu.Lock()
	defer s.thumbnailMu.Unlock()
	if data := s.thumbnails[key]; data != nil {
		return data, nil
	}
	file, err := os.CreateTemp("", "lilt-thumbnail-*.jpg")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	if err = file.Close(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// The descriptor keeps this exact cover alive across atomic artwork replacement.
	_, err = runMediaWithFiles(ctx, []*os.File{source}, "vips", "--vips-concurrency=1", "--vips-cache-max=0", "thumbnail", "/dev/fd/3", file.Name()+"[Q=80,strip]", size, "--height="+size, "--size=down", "--fail-on=error")
	if err != nil {
		return nil, fmt.Errorf("无法加载封面，请重试：%w", err)
	}
	output, err := os.Open(file.Name())
	if err != nil {
		return nil, err
	}
	config, err := jpeg.DecodeConfig(output)
	output.Close()
	limit, _ := strconv.Atoi(size)
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > limit || config.Height > limit {
		return nil, fmt.Errorf("invalid cover thumbnail")
	}
	data, err := os.ReadFile(file.Name())
	if err != nil {
		return nil, err
	}
	if s.thumbnailSize+len(data) > 16<<20 {
		s.thumbnails = nil
		s.thumbnailSize = 0
	}
	if s.thumbnails == nil {
		s.thumbnails = make(map[string][]byte)
	}
	s.thumbnails[key] = data
	s.thumbnailSize += len(data)
	return data, nil
}
