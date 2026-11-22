package music

import (
	"bufio"
	"context"
	"database/sql"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

//go:embed lyrics_infer.py
var lyricsInference string

const lyricJobPrefix = "lyricsJob:"

type AlignmentLine struct {
	ID            string   `json:"id"`
	Text          string   `json:"text"`
	Time          *float64 `json:"time"`
	Locked        bool     `json:"locked"`
	Pronunciation string   `json:"pronunciation,omitempty"`
}
type AlignmentWord struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}
type AlignmentResult struct {
	ID         string          `json:"id"`
	Time       *float64        `json:"time"`
	Words      []AlignmentWord `json:"words,omitempty"`
	Confidence float64         `json:"confidence"`
	Warning    string          `json:"warning,omitempty"`
}
type LyricsJob struct {
	ID                    string            `json:"id"`
	TrackID               string            `json:"trackId"`
	Kind                  string            `json:"kind"`
	Status                string            `json:"status"`
	Phase                 string            `json:"phase"`
	Progress              float64           `json:"progress"`
	AudioVersion          string            `json:"audioVersion"`
	ExpectedLyricsVersion string            `json:"expectedLyricsVersion"`
	DraftVersion          string            `json:"draftVersion"`
	Language              string            `json:"language"`
	Start                 float64           `json:"start"`
	End                   float64           `json:"end"`
	Lines                 []AlignmentLine   `json:"lines,omitempty"`
	Results               []AlignmentResult `json:"results,omitempty"`
	Peaks                 []float64         `json:"peaks,omitempty"`
	Error                 string            `json:"error,omitempty"`
	CreatedAt             string            `json:"createdAt"`
	UpdatedAt             string            `json:"updatedAt"`
}

func (s *Store) lyricJob(ctx context.Context, id string) (LyricsJob, error) {
	var value string
	err := s.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", lyricJobPrefix+id).Scan(&value)
	if err == sql.ErrNoRows {
		return LyricsJob{}, ErrNotFound
	}
	var job LyricsJob
	if err == nil {
		err = json.Unmarshal([]byte(value), &job)
	}
	return job, err
}
func (s *Store) writeLyricJob(ctx context.Context, job LyricsJob, insert bool) error {
	job.UpdatedAt = now()
	value, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if insert {
		_, err = s.db.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES(?,?)", lyricJobPrefix+job.ID, string(value))
	} else {
		// A canceled job cannot be resurrected by late inference output.
		_, err = s.db.ExecContext(ctx, "UPDATE settings SET value=? WHERE key=? AND json_extract(value,'$.status') IN ('queued','running')", string(value), lyricJobPrefix+job.ID)
	}
	return err
}
func (s *server) lyricsTools(w http.ResponseWriter, r *http.Request) {
	var value string
	status := map[string]any{"available": false, "alignment": false, "languages": []string{}, "engine": "SOFA"}
	if s.store.db.QueryRowContext(r.Context(), "SELECT value FROM settings WHERE key='lyricsWorker'").Scan(&value) == nil {
		var saved struct {
			UpdatedAt string `json:"updatedAt"`
			Alignment bool   `json:"alignment"`
		}
		if json.Unmarshal([]byte(value), &saved) == nil {
			at, err := time.Parse(time.RFC3339Nano, saved.UpdatedAt)
			live := err == nil && time.Since(at) < 15*time.Second
			status["available"], status["alignment"] = live, live && saved.Alignment
			if live && saved.Alignment {
				status["languages"] = []string{"zh"}
			}
		}
	}
	writeJSON(w, http.StatusOK, status)
}
func (s *server) lyricsJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		rows, err := s.store.db.QueryContext(r.Context(), "SELECT value FROM settings WHERE key LIKE 'lyricsJob:%' AND json_extract(value,'$.trackId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 16", r.PathValue("id"))
		if err != nil {
			apiError(w, err)
			return
		}
		jobs := []LyricsJob{}
		for rows.Next() {
			var value string
			if err = rows.Scan(&value); err != nil {
				break
			}
			var job LyricsJob
			if err = json.Unmarshal([]byte(value), &job); err != nil {
				break
			}
			jobs = append(jobs, job)
		}
		rows.Close()
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
		return
	}
	var job LyricsJob
	if err := decodeJSON(w, r, &job, false); err != nil {
		apiError(w, err)
		return
	}
	if job.Kind != "waveform" && job.Kind != "align" {
		writeError(w, 400, "任务类型无效")
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	track, hash, relative, err := s.store.track(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if track.DeletedAt != "" || job.AudioVersion != hash || job.ExpectedLyricsVersion != track.LyricsVersion {
		writeError(w, 409, "歌曲已变更，请重新打开歌词工作台")
		return
	}
	if track.Duration <= 0 || track.Duration > 1800 {
		writeError(w, 400, "校准支持最长 30 分钟的曲目")
		return
	}
	if job.Kind == "waveform" {
		job.Start, job.End, job.Lines = 0, track.Duration*1000, nil
	}
	if !finite(job.Start) || !finite(job.End) || job.Start < 0 || job.End <= job.Start || job.End > track.Duration*1000+10 {
		writeError(w, 400, "请选择有效的音频范围")
		return
	}
	if job.Kind == "align" {
		if job.Language != "zh" || len(job.Lines) == 0 || len(job.Lines) > 2000 || len(job.DraftVersion) > 128 {
			writeError(w, 400, "请选择中文歌词，或缩小校准范围")
			return
		}
		ids, characters, previous := map[string]bool{}, 0, job.Start
		for _, line := range job.Lines {
			characters += len(line.Text)
			if line.ID == "" || len(line.ID) > 128 || ids[line.ID] || len(line.Pronunciation) > 4096 || strings.ContainsRune(line.Text, '\x00') || strings.TrimSpace(line.Text) == "" {
				writeError(w, 400, "歌词行无效")
				return
			}
			ids[line.ID] = true
			if line.Locked && (line.Time == nil || !finite(*line.Time) || *line.Time < previous || *line.Time >= job.End) {
				writeError(w, 400, "锁定锚点必须按时间顺序位于选定范围内")
				return
			}
			if line.Locked {
				previous = *line.Time
			}
		}
		if characters > 1<<20 {
			writeError(w, 400, "歌词不能超过 1 MiB")
			return
		}
	}
	var pending int
	if err = s.store.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM settings WHERE key LIKE 'lyricsJob:%' AND json_extract(value,'$.status') IN ('queued','running')").Scan(&pending); err != nil {
		apiError(w, err)
		return
	}
	if pending >= 8 {
		writeError(w, 429, "校准队列已满，请稍后重试")
		return
	}
	id, err := newID("lj_")
	if err != nil {
		apiError(w, err)
		return
	}
	// Only the validated request fields become the queued job; supplied output/status is discarded.
	job = LyricsJob{ID: id, TrackID: track.ID, Kind: job.Kind, Status: "queued", Phase: "等待处理", AudioVersion: hash, ExpectedLyricsVersion: track.LyricsVersion, DraftVersion: job.DraftVersion, Language: job.Language, Start: job.Start, End: job.End, Lines: job.Lines, CreatedAt: now()}
	path, err := s.store.objectPath(relative)
	if err != nil {
		apiError(w, err)
		return
	}
	input := filepath.Join(s.store.dir, "analysis", id+".audio")
	if err = os.Link(path, input); err != nil {
		apiError(w, err)
		return
	}
	if err = s.store.writeLyricJob(r.Context(), job, true); err != nil {
		os.Remove(input)
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job})
}
func (s *server) lyricsJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.lyricJob(r.Context(), r.PathValue("job"))
	if err != nil {
		apiError(w, err)
		return
	}
	if r.Method == "DELETE" && (job.Status == "queued" || job.Status == "running") {
		job.Status, job.Phase = "cancelled", "已取消"
		if err = s.store.writeLyricJob(r.Context(), job, false); err != nil {
			apiError(w, err)
			return
		}
		os.Remove(filepath.Join(s.store.dir, "analysis", job.ID+".audio"))
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

func RunLyricsWorker(ctx context.Context, dir, root string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if _, err = os.Stat(filepath.Join(abs, "lilt.sqlite")); err != nil {
		return fmt.Errorf("existing catalog required: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(abs, "analysis", "worker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("lyrics worker already running: %w", err)
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.Join(abs, "lilt.sqlite")}).String() + "?_pragma=busy_timeout(10000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	s := &Store{db: db, dir: abs}
	// Interrupted jobs are retryable failures, never silently applied or partially resumed.
	rows, err := db.Query("SELECT value FROM settings WHERE key LIKE 'lyricsJob:%' AND json_extract(value,'$.status')='running'")
	if err != nil {
		return err
	}
	var interrupted []LyricsJob
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			break
		}
		var job LyricsJob
		if json.Unmarshal([]byte(value), &job) == nil {
			interrupted = append(interrupted, job)
		}
	}
	rows.Close()
	for _, job := range interrupted {
		job.Status, job.Error, job.Phase = "error", "处理被中断，请重新校准", "处理失败"
		if err = s.writeLyricJob(ctx, job, false); err != nil {
			return err
		}
		os.Remove(filepath.Join(abs, "analysis", job.ID+".audio"))
	}
	entries, err := os.ReadDir(filepath.Join(abs, "analysis"))
	if err != nil {
		return err
	}
	ownedStage := regexp.MustCompile(`^\.lyrics-model-lj_[a-f0-9]{32}-`)
	ownedInput := regexp.MustCompile(`^(lj_[a-f0-9]{32})\.audio$`)
	for _, entry := range entries {
		if ownedStage.MatchString(entry.Name()) {
			os.RemoveAll(filepath.Join(abs, "analysis", entry.Name()))
			continue
		}
		if match := ownedInput.FindStringSubmatch(entry.Name()); match != nil {
			job, e := s.lyricJob(ctx, match[1])
			if e == ErrNotFound || e == nil && job.Status != "queued" {
				os.Remove(filepath.Join(abs, "analysis", entry.Name()))
			}
		}
	}
	heartbeat := func() {
		_, modelErr := os.Stat(filepath.Join(root, "model", "model.ckpt"))
		_, pythonErr := os.Stat(filepath.Join(root, "venv", "bin", "python"))
		value, _ := json.Marshal(map[string]any{"updatedAt": now(), "alignment": modelErr == nil && pythonErr == nil})
		db.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES('lyricsWorker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(value))
	}
	heartbeat()
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				heartbeat()
			}
		}
	}()
	for ctx.Err() == nil {
		var value string
		err = db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key LIKE 'lyricsJob:%' AND json_extract(value,'$.status')='queued' ORDER BY json_extract(value,'$.createdAt') LIMIT 1").Scan(&value)
		if err == sql.ErrNoRows {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			continue
		}
		if err != nil {
			return err
		}
		var job LyricsJob
		if err = json.Unmarshal([]byte(value), &job); err != nil {
			return err
		}
		job.Status, job.Phase = "running", "读取音频"
		if err = s.writeLyricJob(ctx, job, false); err != nil {
			return err
		}
		work, cancel := context.WithTimeout(ctx, 20*time.Minute)
		done := make(chan struct{})
		go func(id string) {
			tick := time.NewTicker(time.Second)
			defer tick.Stop()
			for {
				select {
				case <-done:
					return
				case <-work.Done():
					return
				case <-tick.C:
					latest, e := s.lyricJob(work, id)
					if e == nil && latest.Status == "cancelled" {
						cancel()
						return
					}
				}
			}
		}(job.ID)
		input := filepath.Join(abs, "analysis", job.ID+".audio")
		if job.Kind == "waveform" {
			job.Peaks, err = waveformPeaks(work, input, job.End/1000)
		} else {
			err = s.inferLyrics(work, root, input, &job)
		}
		close(done)
		cancel()
		job.Lines = nil
		if err != nil {
			job.Status, job.Phase, job.Error = "error", "处理失败", err.Error()
		} else {
			job.Status, job.Phase, job.Progress = "done", "处理完成", 1
		}
		if ctx.Err() == nil {
			if err = s.writeLyricJob(ctx, job, false); err != nil {
				return err
			}
		}
		os.Remove(input)
		if entries, e := os.ReadDir(filepath.Join(abs, "analysis")); e == nil {
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".lyrics-model-"+job.ID+"-") {
					os.RemoveAll(filepath.Join(abs, "analysis", entry.Name()))
				}
			}
		}
		// Candidate results are bounded disposable analysis, not saved lyric revisions.
		db.ExecContext(ctx, "DELETE FROM settings WHERE key IN (SELECT key FROM settings WHERE key LIKE 'lyricsJob:%' AND json_extract(value,'$.status') IN ('done','error','cancelled') ORDER BY json_extract(value,'$.createdAt') DESC LIMIT -1 OFFSET 64)")
	}
	return nil
}

func waveformPeaks(ctx context.Context, input string, duration float64) ([]float64, error) {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	peaks := make([]float64, 4096)
	perPeak := math.Max(1, duration*16000/float64(len(peaks)))
	reader := bufio.NewReaderSize(pipe, 32768)
	var sample [2]byte
	index := 0
	for {
		if _, err = io.ReadFull(reader, sample[:]); err != nil {
			break
		}
		bucket := int(float64(index) / perPeak)
		if bucket >= len(peaks) {
			bucket = len(peaks) - 1
		}
		peak := math.Abs(float64(int16(binary.LittleEndian.Uint16(sample[:])))) / 32768
		if peak > peaks[bucket] {
			peaks[bucket] = peak
		}
		index++
	}
	waitErr := cmd.Wait()
	if waitErr != nil {
		return nil, fmt.Errorf("波形生成失败，请重试")
	}
	if err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	return peaks, nil
}
func (s *Store) inferLyrics(ctx context.Context, root, input string, job *LyricsJob) error {
	python := filepath.Join(root, "venv", "bin", "python")
	if _, err := os.Stat(python); err != nil {
		return fmt.Errorf("模型尚未安装，请先使用人工校准")
	}
	request, err := json.Marshal(map[string]any{"root": root, "audio": input, "job": job})
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, python, "-u", "-c", lyricsInference)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.Stderr = os.Stderr
	cmd.Stdin = strings.NewReader(string(request))
	cmd.Env = append(os.Environ(), "PYTHONNOUSERSITE=1", "HF_HUB_OFFLINE=1", "OMP_NUM_THREADS=2", "MKL_NUM_THREADS=2")
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	gotResult := false
	for scanner.Scan() {
		var event struct {
			Kind     string            `json:"kind"`
			Phase    string            `json:"phase"`
			Progress float64           `json:"progress"`
			Results  []AlignmentResult `json:"results"`
			Error    string            `json:"error"`
		}
		if err = json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		if event.Kind == "progress" {
			job.Phase, job.Progress = event.Phase, math.Min(.99, event.Progress)
			s.writeLyricJob(ctx, *job, false)
		}
		if event.Kind == "result" {
			job.Results, gotResult = event.Results, true
		}
		if event.Error != "" {
			job.Error = event.Error
		}
	}
	if scanErr := scanner.Err(); scanErr != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return fmt.Errorf("模型输出过大，请缩小校准范围")
	}
	if err = cmd.Wait(); err != nil || !gotResult {
		if job.Error != "" {
			return fmt.Errorf("%s", job.Error)
		}
		return fmt.Errorf("模型处理失败，请缩小范围后重试")
	}
	return nil
}
