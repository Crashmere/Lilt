package music

import (
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
)

func (s *server) mvs(w http.ResponseWriter, r *http.Request) {
	all, err := s.store.MVs(r.Context(), r.URL.Query().Get("trash") == "true")
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mvs": all})
}

func (s *server) getMV(w http.ResponseWriter, r *http.Request) {
	mv, _, err := s.store.mv(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mv": mv})
}

func (s *server) patchMV(w http.ResponseWriter, r *http.Request) {
	var patch MVPatch
	if err := decodeJSON(w, r, &patch, false); err != nil {
		apiError(w, err)
		return
	}
	mv, err := s.store.PatchMV(r.Context(), r.PathValue("id"), patch)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mv": mv})
}

func (s *server) deleteMV(w http.ResponseWriter, r *http.Request) {
	if err := s.store.TrashMV(r.Context(), r.PathValue("id"), false); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) restoreMV(w http.ResponseWriter, r *http.Request) {
	if err := s.store.TrashMV(r.Context(), r.PathValue("id"), true); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) mvCover(w http.ResponseWriter, r *http.Request) {
	mv, _, err := s.store.mv(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if mv.CoverURL == "" {
		apiError(w, ErrNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("ETag", strconv.Quote(mv.Fingerprint+"-poster"))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	serveFile(w, r, "cover.jpg", filepath.Join(s.store.dir, "covers", mv.ID+".jpg"))
}

func (s *server) mvStream(w http.ResponseWriter, r *http.Request)   { s.mvMedia(w, r, false) }
func (s *server) mvDownload(w http.ResponseWriter, r *http.Request) { s.mvMedia(w, r, true) }

func (s *server) mvMedia(w http.ResponseWriter, r *http.Request, download bool) {
	mv, relative, err := s.store.mv(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if mv.DeletedAt != "" {
		apiError(w, ErrNotFound)
		return
	}
	quality := r.URL.Query().Get("quality")
	if download {
		quality = "original"
	}
	if quality == "" {
		quality = "original"
	}
	if quality != "original" && quality != "compatible" {
		apiError(w, ErrInvalid)
		return
	}
	path, err := s.store.objectPath(relative)
	if err != nil {
		apiError(w, err)
		return
	}
	contentType, etag := mv.MIMEType, mv.Fingerprint+"-original"
	if quality == "compatible" {
		job, err := s.store.MVPlayback(r.Context(), mv.ID, false)
		if err != nil {
			apiError(w, err)
			return
		}
		if job.Status != "ready" {
			writeError(w, http.StatusConflict, "请先准备兼容播放")
			return
		}
		path, contentType, etag = s.store.mvPlaybackPath(mv.Fingerprint), "video/mp4", mv.Fingerprint+"-"+mvPlaybackRecipe
		w.Header().Set("X-Lilt-Engine", job.Engine)
	}
	if download {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": mv.OriginalName}))
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("ETag", strconv.Quote(etag))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	w.Header().Set("X-Lilt-Quality", quality)
	serveFile(w, r, mv.OriginalName, path)
}

func (s *server) mvPlayback(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.MVPlayback(r.Context(), r.PathValue("id"), r.Method == "POST")
	if err != nil {
		apiError(w, err)
		return
	}
	status := http.StatusOK
	if job.Status == "processing" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, job)
}

func (s *server) mvAudio(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.MVAudio(r.Context(), r.PathValue("id"), r.Method == "POST")
	if err != nil {
		apiError(w, err)
		return
	}
	status := http.StatusOK
	if job.Status == "processing" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, job)
}
