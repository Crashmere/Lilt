package music

import "errors"

var (
	ErrNotFound = errors.New("未找到记录")
	ErrInvalid  = errors.New("请求数据无效")
	ErrConflict = errors.New("记录状态已变化")
)

type Track struct {
	legacyCredits bool
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Artist        string   `json:"artist"`
	Album         string   `json:"album"`
	AlbumArtist   string   `json:"albumArtist"`
	Genre         string   `json:"genre"`
	Composer      string   `json:"composer"`
	Lyricist      string   `json:"lyricist"`
	Comment       string   `json:"comment"`
	Copyright     string   `json:"copyright"`
	ISRC          string   `json:"isrc"`
	BPM           float64  `json:"bpm"`
	Year          int      `json:"year"`
	TrackNumber   int      `json:"trackNumber"`
	DiscNumber    int      `json:"discNumber"`
	Duration      float64  `json:"duration"`
	Size          int64    `json:"size"`
	Format        string   `json:"format"`
	Container     string   `json:"container"`
	MIMEType      string   `json:"mimeType"`
	SearchText    string   `json:"searchText,omitempty"`
	Bitrate       int64    `json:"bitrate"`
	SampleRate    int      `json:"sampleRate"`
	BitDepth      int      `json:"bitDepth"`
	Channels      int      `json:"channels"`
	OriginalName  string   `json:"originalName"`
	Version       string   `json:"version"`
	Tags          []string `json:"tags"`
	Aliases       []string `json:"aliases"`
	Favorite      bool     `json:"favorite"`
	CoverURL      string   `json:"coverUrl"`
	HasLyrics     bool     `json:"hasLyrics"`
	LyricsType    string   `json:"lyricsType"`
	LyricsText    string   `json:"lyricsText,omitempty"`
	LyricsVersion string   `json:"lyricsVersion,omitempty"`
	AudioVersion  string   `json:"audioVersion,omitempty"`
	PlayCount     int64    `json:"playCount"`
	PlayedSeconds float64  `json:"playedSeconds"`
	LastPlayedAt  string   `json:"lastPlayedAt"`
	AddedAt       string   `json:"addedAt"`
	UpdatedAt     string   `json:"updatedAt"`
	DeletedAt     string   `json:"deletedAt,omitempty"`
}

type Album struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Artist     string   `json:"artist"`
	Year       int      `json:"year"`
	CoverURL   string   `json:"coverUrl"`
	TrackCount int      `json:"trackCount"`
	Duration   float64  `json:"duration"`
	TrackIDs   []string `json:"trackIds"`
}

type Artist struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	CoverURL   string   `json:"coverUrl"`
	TrackCount int      `json:"trackCount"`
	AlbumCount int      `json:"albumCount"`
	TrackIDs   []string `json:"trackIds"`
}

type SmartRules struct {
	Favorite    *bool    `json:"favorite,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Artist      string   `json:"artist,omitempty"`
	Genre       string   `json:"genre,omitempty"`
	YearFrom    int      `json:"yearFrom,omitempty"`
	YearTo      int      `json:"yearTo,omitempty"`
	Unplayed    bool     `json:"unplayed,omitempty"`
	UnheardDays int      `json:"unheardDays,omitempty"`
	Limit       int      `json:"limit,omitempty"`
}

type Playlist struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Kind        string     `json:"kind"`
	Rules       SmartRules `json:"rules"`
	TrackIDs    []string   `json:"trackIds"`
	CoverURL    string     `json:"coverUrl"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
}

type Stats struct {
	TotalTracks    int     `json:"totalTracks"`
	TotalAlbums    int     `json:"totalAlbums"`
	TotalArtists   int     `json:"totalArtists"`
	TotalDuration  float64 `json:"totalDuration"`
	TotalBytes     int64   `json:"totalBytes"`
	FavoriteTracks int     `json:"favoriteTracks"`
	PlayedSeconds  float64 `json:"playedSeconds"`
	PlayCount      int64   `json:"playCount"`
}

type Library struct {
	Tracks    []Track    `json:"tracks"`
	MVs       []MV       `json:"mvs"`
	Albums    []Album    `json:"albums"`
	Artists   []Artist   `json:"artists"`
	Playlists []Playlist `json:"playlists"`
	Tags      []string   `json:"tags"`
	Stats     Stats      `json:"stats"`
}

type Upload struct {
	ID           string `json:"id"`
	Filename     string `json:"filename"`
	Size         int64  `json:"size"`
	Offset       int64  `json:"offset"`
	Fingerprint  string `json:"fingerprint"`
	Status       string `json:"status"`
	TrackID      string `json:"trackId,omitempty"`
	MVID         string `json:"mvId,omitempty"`
	Kind         string `json:"kind"`
	Duplicate    bool   `json:"duplicate,omitempty"`
	RelativePath string `json:"-"`
}

type HistoryInput struct {
	TrackID   string  `json:"trackId"`
	SessionID string  `json:"sessionId"`
	Seconds   float64 `json:"seconds"`
	Completed bool    `json:"completed"`
}

type HistoryEntry struct {
	ID        string  `json:"id"`
	TrackID   string  `json:"trackId"`
	SessionID string  `json:"sessionId"`
	Seconds   float64 `json:"seconds"`
	Completed bool    `json:"completed"`
	PlayedAt  string  `json:"playedAt"`
	UpdatedAt string  `json:"updatedAt"`
}
