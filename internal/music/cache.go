package music

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var fingerprintedAsset = regexp.MustCompile(`^assets/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$`)

func contentETag(data []byte) string {
	return strconv.Quote(fmt.Sprintf("%x", sha256.Sum256(data)))
}

func coverVersion(info fs.FileInfo) string {
	return strconv.FormatInt(info.ModTime().UnixNano(), 36) + "-" + strconv.FormatInt(info.Size(), 36)
}

type librarySnapshot struct {
	body      []byte
	etag      string
	revision  uint64
	expiresAt time.Time
}

func libraryExpiry(library Library, at time.Time) time.Time {
	var expiry time.Time
	for _, playlist := range library.Playlists {
		if playlist.Kind != "smart" || playlist.Rules.UnheardDays <= 0 {
			continue
		}
		for _, track := range library.Tracks {
			played, err := time.Parse(time.RFC3339Nano, track.LastPlayedAt)
			if err != nil {
				continue
			}
			boundary := played.AddDate(0, 0, playlist.Rules.UnheardDays)
			if boundary.After(at) && (expiry.IsZero() || boundary.Before(expiry)) {
				expiry = boundary
			}
		}
	}
	return expiry
}

func (s *server) libraryPayload(ctx context.Context) (librarySnapshot, error) {
	s.libraryMu.Lock()
	defer s.libraryMu.Unlock()
	revision := s.store.libraryRevision.Load()
	started := time.Now().UTC()
	if s.libraryCache.body != nil && s.libraryCache.revision == revision && (s.libraryCache.expiresAt.IsZero() || started.Before(s.libraryCache.expiresAt)) {
		return s.libraryCache, nil
	}
	library, err := s.store.Library(ctx)
	if err != nil {
		return librarySnapshot{}, err
	}
	body, err := json.Marshal(library)
	if err != nil {
		return librarySnapshot{}, err
	}
	body = append(body, '\n')
	snapshot := librarySnapshot{body: body, etag: contentETag(body), revision: revision, expiresAt: libraryExpiry(library, started)}
	// A concurrent publication may have changed part of this read. Never retain it
	// under the newer revision, or let a boundary crossed during the read stay cached.
	if revision == s.store.libraryRevision.Load() && (snapshot.expiresAt.IsZero() || time.Now().Before(snapshot.expiresAt)) && len(body) <= 8<<20 {
		s.libraryCache = snapshot
	} else {
		s.libraryCache = librarySnapshot{}
	}
	return snapshot, nil
}

type shellAsset struct {
	URL  string `json:"url"`
	ETag string `json:"etag"`
}

func (s *server) prepareAssets() error {
	s.assetETags = map[string]string{}
	if s.cfg.Assets == nil {
		return nil
	}
	assets := []shellAsset{}
	err := fs.WalkDir(s.cfg.Assets, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := fs.ReadFile(s.cfg.Assets, name)
		if err != nil {
			return err
		}
		etag := contentETag(data)
		s.assetETags[name] = etag
		if name == "index.html" {
			assets = append(assets, shellAsset{URL: s.cfg.Prefix, ETag: etag})
		} else if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "fonts/") && path.Ext(name) == ".ttf" || name == "favicon.svg" || name == "apple-touch-icon.png" || name == "icon-192.png" || name == "icon-512.png" || name == "manifest.webmanifest" {
			assets = append(assets, shellAsset{URL: s.cfg.Prefix + name, ETag: etag})
		}
		return nil
	})
	if err != nil {
		return err
	}
	identity, err := json.Marshal(assets)
	if err != nil {
		return err
	}
	s.shellManifest, err = json.Marshal(struct {
		Version string       `json:"version"`
		Assets  []shellAsset `json:"assets"`
	}{Version: strings.Trim(contentETag(identity), `"`), Assets: assets})
	return err
}
