package music

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type ServerConfig struct {
	Prefix  string
	Origins []string
	Version string
	Assets  fs.FS
}

type server struct {
	store   *Store
	cfg     ServerConfig
	origins map[string]bool
	chunks  chan struct{}
}

func NormalizePrefix(prefix string) (string, error) {
	if prefix == "" {
		prefix = "/lilt/"
	}
	if !strings.HasPrefix(prefix, "/") || strings.ContainsAny(prefix, "?#\\") || path.Clean(prefix) != strings.TrimSuffix(prefix, "/") && prefix != "/" {
		return "", fmt.Errorf("prefix must be a clean absolute URL path")
	}
	return strings.TrimSuffix(prefix, "/") + "/", nil
}

func NewHandler(store *Store, cfg ServerConfig) (http.Handler, error) {
	prefix, err := NormalizePrefix(cfg.Prefix)
	if err != nil {
		return nil, err
	}
	cfg.Prefix = prefix
	s := &server{store: store, cfg: cfg, origins: map[string]bool{}, chunks: make(chan struct{}, 2)}
	for _, origin := range cfg.Origins {
		u, err := url.Parse(strings.TrimSpace(origin))
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
			return nil, fmt.Errorf("LILT_ORIGINS requires exact HTTPS origins")
		}
		s.origins["https://"+strings.ToLower(u.Host)] = true
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET "+prefix+"healthz", s.health)
	base := prefix + "api"
	mux.HandleFunc("GET "+base+"/library", s.library)
	mux.HandleFunc("GET "+base+"/tracks", s.tracks)
	mux.HandleFunc("GET "+base+"/tracks/{id}", s.getTrack)
	mux.HandleFunc("GET "+base+"/tracks/{id}/lyrics", s.lyrics)
	mux.HandleFunc("PATCH "+base+"/tracks/{id}", s.updateTrack)
	mux.HandleFunc("DELETE "+base+"/tracks/{id}", s.deleteTrack)
	mux.HandleFunc("POST "+base+"/tracks/{id}/restore", s.restoreTrack)
	mux.HandleFunc("GET "+base+"/tracks/{id}/stream", s.stream)
	mux.HandleFunc("GET "+base+"/tracks/{id}/download", s.download)
	mux.HandleFunc("GET "+base+"/tracks/{id}/cover", s.cover)
	mux.HandleFunc("POST "+base+"/tracks/{id}/cover", s.replaceCover)
	mux.HandleFunc("GET "+base+"/albums/{id}", s.album)
	mux.HandleFunc("GET "+base+"/artists/{id}", s.artist)
	mux.HandleFunc("GET "+base+"/export", s.export)
	mux.HandleFunc("GET "+base+"/uploads", s.uploads)
	mux.HandleFunc("POST "+base+"/uploads", s.startUpload)
	mux.HandleFunc("PATCH "+base+"/uploads/{id}", s.appendUpload)
	mux.HandleFunc("POST "+base+"/uploads/{id}/complete", s.completeUpload)
	mux.HandleFunc("DELETE "+base+"/uploads/{id}", s.cancelUpload)
	mux.HandleFunc("POST "+base+"/playlists", s.savePlaylist)
	mux.HandleFunc("GET "+base+"/playlists/{id}", s.playlist)
	mux.HandleFunc("PUT "+base+"/playlists/{id}", s.savePlaylist)
	mux.HandleFunc("DELETE "+base+"/playlists/{id}", s.deletePlaylist)
	mux.HandleFunc("GET "+base+"/playlists/{id}/export", s.exportPlaylist)
	mux.HandleFunc("POST "+base+"/history", s.saveHistory)
	mux.HandleFunc("GET "+base+"/history", s.history)
	mux.HandleFunc(base+"/", func(w http.ResponseWriter, r *http.Request) { writeError(w, http.StatusNotFound, "接口不存在") })
	if prefix != "/" {
		mux.HandleFunc(strings.TrimSuffix(prefix, "/"), func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, prefix, http.StatusPermanentRedirect)
		})
	}
	mux.HandleFunc(prefix, s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, base+"/") {
			if !loopback(r.RemoteAddr) {
				writeError(w, http.StatusForbidden, "请通过已授权的服务入口访问")
				return
			}
			if r.Method != "GET" && r.Method != "HEAD" {
				if !s.trustedWrite(r) {
					writeError(w, http.StatusForbidden, "请求来源未授权")
					return
				}
			}
		}
		mux.ServeHTTP(w, r)
	}), nil
}

func loopback(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *server) trustedWrite(r *http.Request) bool {
	if !loopback(r.RemoteAddr) {
		return false
	}
	proxied := r.Header.Get("X-Forwarded-Proto") != "" || r.Header.Get("X-Forwarded-Host") != "" || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != ""
	host := strings.ToLower(r.Host)
	if strings.ContainsAny(host, "/\\, \t\r\n") || host == "" {
		return false
	}
	origin := r.Header.Get("Origin")
	if proxied {
		if r.Header.Get("X-Forwarded-Proto") != "https" {
			return false
		}
		if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" && strings.ToLower(forwarded) != host {
			return false
		}
		if origin != "https://"+host {
			return false
		}
		return len(s.origins) == 0 || s.origins[origin]
	}
	parsed, err := url.Parse("http://" + host)
	if err != nil {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	if parsed.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return false
	}
	if origin == "" {
		return true
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin == scheme+"://"+host
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("JSON response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func apiError(w http.ResponseWriter, err error) {
	var offset *OffsetError
	if errors.As(err, &offset) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "offset": offset.Upload.Offset, "upload": offset.Upload})
		return
	}
	var maxBytes *http.MaxBytesError
	switch {
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.As(err, &maxBytes):
		writeError(w, http.StatusRequestEntityTooLarge, "请求内容超过大小限制")
	case errors.Is(err, context.Canceled):
		return
	default:
		log.Printf("API failure: %v", err)
		writeError(w, http.StatusInternalServerError, "操作失败，请稍后重试")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any, empty bool) error {
	if r.ContentLength != 0 {
		kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || kind != "application/json" {
			return fmt.Errorf("请使用 JSON 请求：%w", ErrInvalid)
		}
	}
	reader := http.MaxBytesReader(w, r.Body, 2<<20)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(value)
	if empty && errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return err
		}
		return fmt.Errorf("JSON 数据无效：%w", ErrInvalid)
	}
	var extra any
	if err = decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return fmt.Errorf("只接受一个 JSON 对象：%w", ErrInvalid)
	}
	return nil
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Health(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "error", "version": s.cfg.Version, "db": "error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": s.cfg.Version, "db": "ok"})
}

func (s *server) library(w http.ResponseWriter, r *http.Request) {
	library, err := s.store.Library(r.Context())
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, library)
}

func (s *server) tracks(w http.ResponseWriter, r *http.Request) {
	trash := r.URL.Query().Get("trash") == "true" || r.URL.Query().Get("trash") == "1"
	tracks, err := s.store.Tracks(r.Context(), trash)
	if err != nil {
		apiError(w, err)
		return
	}
	result := map[string]any{"tracks": FilterTracks(tracks, r.URL.Query())}
	if trash {
		playlists, err := s.store.Playlists(r.Context(), tracks)
		if err != nil {
			apiError(w, err)
			return
		}
		manual := []Playlist{}
		for _, playlist := range playlists {
			if playlist.Kind == "manual" {
				manual = append(manual, playlist)
			}
		}
		result["playlists"] = manual
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) getTrack(w http.ResponseWriter, r *http.Request) {
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	track, _, relative, err := s.store.track(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if err = s.store.loadLegacyCredits(r.Context(), &track, relative); err != nil {
		apiError(w, err)
		return
	}
	s.store.hydrate(&track)
	writeJSON(w, http.StatusOK, map[string]any{"track": track})
}

func (s *server) lyrics(w http.ResponseWriter, r *http.Request) {
	// Lyrics live in the catalog; uploads and legacy audio-tag reads need not block them.
	track, _, _, err := s.store.track(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"lyricsText": track.LyricsText, "updatedAt": track.UpdatedAt})
}

func (s *server) updateTrack(w http.ResponseWriter, r *http.Request) {
	var patch TrackPatch
	if err := decodeJSON(w, r, &patch, false); err != nil {
		apiError(w, err)
		return
	}
	track, err := s.store.UpdateTrack(r.Context(), r.PathValue("id"), patch)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"track": track})
}

func (s *server) deleteTrack(w http.ResponseWriter, r *http.Request)  { s.toggleTrash(w, r, false) }
func (s *server) restoreTrack(w http.ResponseWriter, r *http.Request) { s.toggleTrash(w, r, true) }
func (s *server) toggleTrash(w http.ResponseWriter, r *http.Request, restore bool) {
	track, err := s.store.DeleteTrack(r.Context(), r.PathValue("id"), restore)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"track": track})
}

func (s *server) mediaTrack(r *http.Request) (Track, string, string, error) {
	t, hash, relative, err := s.store.track(r.Context(), r.PathValue("id"))
	if err != nil {
		return t, "", "", err
	}
	if t.DeletedAt != "" {
		return t, "", "", ErrNotFound
	}
	path, err := s.store.objectPath(relative)
	return t, hash, path, err
}

func serveFile(w http.ResponseWriter, r *http.Request, name, path string) {
	file, err := os.Open(path)
	if err != nil {
		apiError(w, err)
		return
	}
	defer file.Close()
	serveOpenedFile(w, r, name, file)
}

func serveOpenedFile(w http.ResponseWriter, r *http.Request, name string, file *os.File) {
	info, err := file.Stat()
	if err != nil {
		apiError(w, err)
		return
	}
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func (s *server) stream(w http.ResponseWriter, r *http.Request) {
	s.store.mu.Lock()
	t, hash, path, err := s.mediaTrack(r)
	if err != nil {
		s.store.mu.Unlock()
		apiError(w, err)
		return
	}
	quality := r.URL.Query().Get("quality")
	if quality == "" {
		quality = "original"
	}
	info, err := s.store.playback(r.Context(), t, hash, path, quality)
	if err != nil {
		s.store.mu.Unlock()
		apiError(w, err)
		return
	}
	file, err := os.Open(info.Path)
	s.store.mu.Unlock()
	if err != nil {
		apiError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("X-Lilt-Quality", quality)
	w.Header().Set("X-Lilt-Bitrate", strconv.FormatInt(info.Bitrate, 10))
	w.Header().Set("X-Lilt-Format", info.Format)
	w.Header().Set("X-Lilt-Sample-Rate", strconv.Itoa(info.SampleRate))
	w.Header().Set("X-Lilt-Channels", strconv.Itoa(info.Channels))
	w.Header().Set("ETag", strconv.Quote(hash+"-"+quality))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	contentType := "audio/mp4"
	if quality == "original" {
		contentType = t.MIMEType
		if contentType == "" {
			contentType = audioType(t.Format)
		}
	}
	w.Header().Set("Content-Type", contentType)
	serveOpenedFile(w, r, t.OriginalName, file)
}

func (s *server) download(w http.ResponseWriter, r *http.Request) {
	s.store.mu.Lock()
	t, hash, path, err := s.mediaTrack(r)
	if err != nil {
		s.store.mu.Unlock()
		apiError(w, err)
		return
	}
	file, err := os.Open(path)
	s.store.mu.Unlock()
	if err != nil {
		apiError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": t.OriginalName}))
	w.Header().Set("Content-Type", t.MIMEType)
	w.Header().Set("ETag", strconv.Quote(hash))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	serveOpenedFile(w, r, t.OriginalName, file)
}

func (s *server) cover(w http.ResponseWriter, r *http.Request) {
	t, _, _, err := s.store.track(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if t.CoverURL == "" {
		apiError(w, ErrNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	serveFile(w, r, "cover.jpg", filepath.Join(s.store.dir, "covers", t.ID, "cover.jpg"))
}

func (s *server) replaceCover(w http.ResponseWriter, r *http.Request) {
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(600 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		apiError(w, err)
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	multipart, err := r.MultipartReader()
	if err != nil {
		apiError(w, fmt.Errorf("请上传封面文件：%w", ErrInvalid))
		return
	}
	var file *os.File
	var size int64
	var patch TrackPatch
	hasMetadata := false
	for {
		part, err := multipart.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			apiError(w, err)
			return
		}
		if part.FormName() == "metadata" {
			if hasMetadata {
				part.Close()
				apiError(w, ErrInvalid)
				return
			}
			hasMetadata = true
			metadata, err := io.ReadAll(io.LimitReader(part, (2<<20)+1))
			part.Close()
			if err != nil {
				apiError(w, err)
				return
			}
			decoder := json.NewDecoder(bytes.NewReader(metadata))
			decoder.DisallowUnknownFields()
			if len(metadata) > 2<<20 || decoder.Decode(&patch) != nil || decoder.Decode(new(any)) != io.EOF {
				apiError(w, fmt.Errorf("曲目信息格式无效：%w", ErrInvalid))
				return
			}
			continue
		}
		if part.FormName() != "file" || file != nil {
			part.Close()
			apiError(w, fmt.Errorf("封面上传字段无效：%w", ErrInvalid))
			return
		}
		file, err = os.CreateTemp("", "lilt-cover-upload-*")
		if err != nil {
			part.Close()
			apiError(w, err)
			return
		}
		defer os.Remove(file.Name())
		defer file.Close()
		size, err = io.Copy(file, part)
		part.Close()
		if err != nil {
			apiError(w, err)
			return
		}
	}
	if file == nil || size == 0 {
		apiError(w, fmt.Errorf("缺少封面文件：%w", ErrInvalid))
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		apiError(w, err)
		return
	}
	track, err := s.store.editTrack(r.Context(), r.PathValue("id"), patch, file)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"track": track})
}

func (s *server) album(w http.ResponseWriter, r *http.Request) {
	tracks, err := s.store.Tracks(r.Context(), false)
	if err != nil {
		apiError(w, err)
		return
	}
	albums, _, _ := collections(tracks)
	for _, album := range albums {
		if album.ID == r.PathValue("id") {
			writeJSON(w, http.StatusOK, map[string]any{"album": album, "tracks": tracksByIDs(album.TrackIDs, tracks)})
			return
		}
	}
	apiError(w, ErrNotFound)
}

func (s *server) artist(w http.ResponseWriter, r *http.Request) {
	tracks, err := s.store.Tracks(r.Context(), false)
	if err != nil {
		apiError(w, err)
		return
	}
	_, artists, _ := collections(tracks)
	for _, artist := range artists {
		if artist.ID == r.PathValue("id") {
			selected := tracksByIDs(artist.TrackIDs, tracks)
			albums, _, _ := collections(selected)
			writeJSON(w, http.StatusOK, map[string]any{"artist": artist, "tracks": selected, "albums": albums})
			return
		}
	}
	apiError(w, ErrNotFound)
}

func (s *server) export(w http.ResponseWriter, r *http.Request) {
	active, err := s.store.Tracks(r.Context(), false)
	if err != nil {
		apiError(w, err)
		return
	}
	trash, err := s.store.Tracks(r.Context(), true)
	if err != nil {
		apiError(w, err)
		return
	}
	tracks := append(active, trash...)
	for i, t := range tracks {
		full, _, _, err := s.store.track(r.Context(), t.ID)
		if err != nil {
			apiError(w, err)
			return
		}
		tracks[i] = full
	}
	rows, err := s.store.db.QueryContext(r.Context(), "SELECT document FROM playlists")
	if err != nil {
		apiError(w, err)
		return
	}
	playlists := []Playlist{}
	for rows.Next() {
		var data string
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			apiError(w, err)
			return
		}
		var p Playlist
		if err = json.Unmarshal([]byte(data), &p); err != nil {
			rows.Close()
			apiError(w, err)
			return
		}
		if p.TrackIDs == nil {
			p.TrackIDs = []string{}
		}
		playlists = append(playlists, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		apiError(w, err)
		return
	}
	history, err := s.store.History(r.Context(), 0)
	if err != nil {
		apiError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="lilt-catalog.json"`)
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "exportedAt": now(), "tracks": tracks, "playlists": playlists, "history": history})
}

func (s *server) uploads(w http.ResponseWriter, r *http.Request) {
	uploads, err := s.store.Uploads(r.Context())
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"uploads": uploads})
}

func (s *server) startUpload(w http.ResponseWriter, r *http.Request) {
	var in UploadInput
	if err := decodeJSON(w, r, &in, false); err != nil {
		apiError(w, err)
		return
	}
	u, err := s.store.StartUpload(r.Context(), in)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload": u})
}

func (s *server) appendUpload(w http.ResponseWriter, r *http.Request) {
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		apiError(w, fmt.Errorf("缺少有效的 Upload-Offset：%w", ErrInvalid))
		return
	}
	select {
	case s.chunks <- struct{}{}:
		defer func() { <-s.chunks }()
	case <-r.Context().Done():
		return
	}
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(600 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		apiError(w, err)
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxChunkSize))
	if err != nil {
		apiError(w, err)
		return
	}
	u, err := s.store.AppendUpload(r.Context(), r.PathValue("id"), offset, bytes.NewReader(data))
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload": u})
}

func (s *server) completeUpload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ReplaceTrackID string `json:"replaceTrackId"`
	}
	if err := decodeJSON(w, r, &in, true); err != nil {
		apiError(w, err)
		return
	}
	track, duplicate, err := s.store.CompleteUpload(r.Context(), r.PathValue("id"), in.ReplaceTrackID)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"track": track, "duplicate": duplicate})
}

func (s *server) cancelUpload(w http.ResponseWriter, r *http.Request) {
	if err := s.store.CancelUpload(r.Context(), r.PathValue("id")); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) savePlaylist(w http.ResponseWriter, r *http.Request) {
	var in PlaylistInput
	if err := decodeJSON(w, r, &in, false); err != nil {
		apiError(w, err)
		return
	}
	p, err := s.store.SavePlaylist(r.Context(), r.PathValue("id"), in)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlist": p})
}

func (s *server) playlist(w http.ResponseWriter, r *http.Request) {
	p, tracks, err := s.store.PlaylistContent(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlist": p, "tracks": tracks})
}

func (s *server) deletePlaylist(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeletePlaylist(r.Context(), r.PathValue("id")); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) exportPlaylist(w http.ResponseWriter, r *http.Request) {
	p, tracks, err := s.store.PlaylistContent(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": p.Name + ".m3u"}))
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintln(w, "#EXTM3U")
	line := func(value string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(value) }
	for _, t := range tracks {
		fmt.Fprintf(w, "#EXTINF:%.0f,%s - %s\n%s\n", t.Duration, line(t.Artist), line(t.Title), line(t.OriginalName))
	}
}

func (s *server) saveHistory(w http.ResponseWriter, r *http.Request) {
	var in HistoryInput
	if err := decodeJSON(w, r, &in, false); err != nil {
		apiError(w, err)
		return
	}
	if err := s.store.RecordHistory(r.Context(), in); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) history(w http.ResponseWriter, r *http.Request) {
	history, err := s.store.History(r.Context(), 500)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": history})
}

func (s *server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		writeError(w, http.StatusMethodNotAllowed, "请求方法不支持")
		return
	}
	if s.cfg.Assets == nil {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, s.cfg.Prefix)
	name = strings.TrimPrefix(path.Clean("/"+name), "/")
	if name == "" {
		name = "index.html"
	}
	if info, err := fs.Stat(s.cfg.Assets, name); err != nil || info.IsDir() {
		name = "index.html"
	}
	file, err := s.cfg.Assets.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	reader, ok := file.(io.ReadSeeker)
	if !ok {
		http.NotFound(w, r)
		return
	}
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	}
	if name == "manifest.webmanifest" {
		w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
	}
	http.ServeContent(w, r, name, info.ModTime(), reader)
}
