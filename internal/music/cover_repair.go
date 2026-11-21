package music

import (
	"context"
	"os"
	"path/filepath"
)

func (s *Store) RepairCover(ctx context.Context, id string) (Track, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.finishMetadataWrite(); err != nil {
		return Track{}, err
	}
	t, _, relative, err := s.track(ctx, id)
	if err != nil {
		return Track{}, err
	}
	if t.CoverURL != "" {
		info, err := os.Stat(filepath.Join(s.dir, "covers", id, "cover.jpg"))
		if err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return t, nil
		}
	}
	path, err := s.objectPath(relative)
	if err != nil {
		return Track{}, err
	}
	result, err := probe(ctx, path)
	if err != nil {
		return Track{}, err
	}
	if err = s.extractCover(ctx, path, id, embeddedCoverIndex(result)); err != nil {
		return Track{}, err
	}
	// Avoid persisting hydrated metadata and listening statistics during derivative repair.
	_, err = s.db.ExecContext(ctx, "UPDATE tracks SET document=json_set(document,'$.coverUrl',?,'$.updatedAt',?) WHERE id=?", s.prefix+"api/tracks/"+id+"/cover", now(), id)
	if err != nil {
		return Track{}, err
	}
	s.invalidateLibrary()
	t, _, _, err = s.track(ctx, id)
	return t, err
}
