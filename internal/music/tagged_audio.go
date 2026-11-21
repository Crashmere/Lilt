package music

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
)

func synchsafe(value uint32) []byte {
	return []byte{byte(value>>21) & 127, byte(value>>14) & 127, byte(value>>7) & 127, byte(value) & 127}
}

func id3Tags(tags map[string]string, coverPath string) ([]byte, error) {
	var body []byte
	frame := func(id string, value []byte) {
		body = append(body, id...)
		body = append(body, synchsafe(uint32(len(value)))...)
		body = append(body, 0, 0)
		body = append(body, value...)
	}
	frames := map[string]string{"title": "TIT2", "artist": "TPE1", "album": "TALB", "album_artist": "TPE2", "genre": "TCON", "date": "TDRC", "track": "TRCK", "disc": "TPOS", "composer": "TCOM", "lyricist": "TEXT", "isrc": "TSRC", "bpm": "TBPM", "copyright": "TCOP", "publisher": "TPUB", "encoder": "TENC"}
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := tags[key]
		if value == "" {
			continue
		}
		if id := frames[key]; id != "" {
			frame(id, append([]byte{3}, value...))
		} else if key == "lyrics" {
			frame("USLT", append([]byte{3, 'e', 'n', 'g', 0}, value...))
		} else if key == "comment" {
			frame("COMM", append([]byte{3, 'e', 'n', 'g', 0}, value...))
		} else {
			frame("TXXX", append(append([]byte{3}, key+"\x00"...), value...))
		}
	}
	if coverPath != "" {
		data, err := os.ReadFile(coverPath)
		if err != nil {
			return nil, err
		}
		frame("APIC", append([]byte("\x03image/jpeg\x00\x03\x00"), data...))
	}
	result := append([]byte{'I', 'D', '3', 4, 0, 0}, synchsafe(uint32(len(body)))...)
	return append(result, body...), nil
}

func audioFiles(source, output string) (*os.File, *os.File, int64, error) {
	input, err := os.Open(source)
	if err != nil {
		return nil, nil, 0, err
	}
	info, err := input.Stat()
	if err != nil {
		input.Close()
		return nil, nil, 0, err
	}
	out, err := os.OpenFile(output, os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		input.Close()
		return nil, nil, 0, err
	}
	return input, out, info.Size(), nil
}

func writeAPETags(source, output string, tags map[string]string, coverPath string) error {
	input, out, size, err := audioFiles(source, output)
	if err != nil {
		return err
	}
	defer input.Close()
	defer out.Close()
	end := size
	var footer [128]byte
	if size >= 128 {
		if _, err = input.ReadAt(footer[:], size-128); err != nil {
			return err
		}
		if string(footer[:3]) == "TAG" {
			end -= 128
		}
	}
	if end >= 32 {
		if _, err = input.ReadAt(footer[:32], end-32); err != nil {
			return err
		}
		if string(footer[:8]) == "APETAGEX" {
			length := int64(binary.LittleEndian.Uint32(footer[12:16]))
			if length < 32 || length > 32<<20 || length > end {
				return fmt.Errorf("invalid APE tag size: %w", ErrInvalid)
			}
			end -= length
			if binary.LittleEndian.Uint32(footer[20:24])&(1<<31) != 0 {
				end -= 32
			}
		}
	}
	var header [10]byte
	start := int64(0)
	if _, err = input.ReadAt(header[:], 0); err != nil {
		return err
	}
	if string(header[:3]) == "ID3" {
		for _, b := range header[6:10] {
			if b > 127 {
				return fmt.Errorf("invalid ID3 tag: %w", ErrInvalid)
			}
			start = start<<7 | int64(b)
		}
		start += 10
		if header[3] == 4 && header[5]&16 != 0 {
			start += 10
		}
	}
	if start > end || end < 0 {
		return fmt.Errorf("invalid audio tag boundaries: %w", ErrInvalid)
	}
	if _, err = io.Copy(out, io.NewSectionReader(input, start, end-start)); err != nil {
		return err
	}
	var items []byte
	count := uint32(0)
	item := func(key string, value []byte, flags uint32) {
		items = binary.LittleEndian.AppendUint32(items, uint32(len(value)))
		items = binary.LittleEndian.AppendUint32(items, flags)
		items = append(items, key+"\x00"...)
		items = append(items, value...)
		count++
	}
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if tags[key] != "" {
			item(key, []byte(tags[key]), 0)
		}
	}
	if coverPath != "" {
		data, err := os.ReadFile(coverPath)
		if err != nil {
			return err
		}
		item("Cover Art (Front)", append([]byte("cover.jpg\x00"), data...), 2)
	}
	makeFooter := func(flags uint32) []byte {
		b := append([]byte("APETAGEX"), make([]byte, 24)...)
		binary.LittleEndian.PutUint32(b[8:12], 2000)
		binary.LittleEndian.PutUint32(b[12:16], uint32(len(items)+32))
		binary.LittleEndian.PutUint32(b[16:20], count)
		binary.LittleEndian.PutUint32(b[20:24], flags)
		return b
	}
	if _, err = out.Write(makeFooter(1<<31 | 1<<29)); err != nil {
		return err
	}
	if _, err = out.Write(items); err != nil {
		return err
	}
	_, err = out.Write(makeFooter(1 << 31))
	return err
}

func writeDSFTags(source, output string, tags map[string]string, coverPath string) error {
	id3, err := id3Tags(tags, coverPath)
	if err != nil {
		return err
	}
	input, out, size, err := audioFiles(source, output)
	if err != nil {
		return err
	}
	defer input.Close()
	defer out.Close()
	var header [28]byte
	if _, err = input.ReadAt(header[:], 0); err != nil {
		return err
	}
	if string(header[:4]) != "DSD " || binary.LittleEndian.Uint64(header[4:12]) != 28 {
		return fmt.Errorf("invalid DSF header: %w", ErrInvalid)
	}
	end := int64(binary.LittleEndian.Uint64(header[20:28]))
	if end == 0 {
		end = size
	}
	if end < 28 || end > size {
		return fmt.Errorf("invalid DSF metadata offset: %w", ErrInvalid)
	}
	binary.LittleEndian.PutUint64(header[12:20], uint64(end+int64(len(id3))))
	binary.LittleEndian.PutUint64(header[20:28], uint64(end))
	if _, err = out.Write(header[:]); err != nil {
		return err
	}
	if _, err = io.Copy(out, io.NewSectionReader(input, 28, end-28)); err != nil {
		return err
	}
	_, err = out.Write(id3)
	return err
}

func writeADTSID3(source, output string, tags map[string]string, coverPath string) error {
	id3, err := id3Tags(tags, coverPath)
	if err != nil {
		return err
	}
	input, out, size, err := audioFiles(source, output)
	if err != nil {
		return err
	}
	defer input.Close()
	defer out.Close()
	start := int64(0)
	for {
		var header [10]byte
		if _, err = input.ReadAt(header[:], start); err != nil {
			return err
		}
		if string(header[:3]) != "ID3" {
			break
		}
		length := int64(0)
		for _, b := range header[6:10] {
			if b > 127 {
				return ErrInvalid
			}
			length = length<<7 | int64(b)
		}
		start += 10 + length
		if header[3] == 4 && header[5]&16 != 0 {
			start += 10
		}
		if start > size {
			return ErrInvalid
		}
	}
	if _, err = out.Write(id3); err != nil {
		return err
	}
	_, err = io.Copy(out, io.NewSectionReader(input, start, size-start))
	return err
}

func mp4Atom(name string, data []byte) []byte {
	b := binary.BigEndian.AppendUint32(nil, uint32(len(data)+8))
	b = append(b, name...)
	return append(b, data...)
}

func appendMP4Metadata(body []byte, chain []string, extra []byte) ([]byte, error) {
	if len(chain) == 0 {
		return append(body, extra...), nil
	}
	prefix := 0
	if chain[0] == "ilst" {
		prefix = 4
	}
	if len(body) < prefix {
		return nil, ErrInvalid
	}
	for offset := prefix; offset < len(body); {
		if offset+8 > len(body) {
			return nil, ErrInvalid
		}
		length := int(binary.BigEndian.Uint32(body[offset : offset+4]))
		if length < 8 || offset+length > len(body) {
			return nil, ErrInvalid
		}
		name := string(body[offset+4 : offset+8])
		if name == chain[0] {
			child, err := appendMP4Metadata(body[offset+8:offset+length], chain[1:], extra)
			if err != nil {
				return nil, err
			}
			result := append([]byte{}, body[:offset]...)
			result = append(result, mp4Atom(name, child)...)
			return append(result, body[offset+length:]...), nil
		}
		offset += length
	}
	child := []byte{}
	if chain[0] == "meta" {
		child = make([]byte, 4)
	}
	child, err := appendMP4Metadata(child, chain[1:], extra)
	if err != nil {
		return nil, err
	}
	return append(body, mp4Atom(chain[0], child)...), nil
}

func addMP4Tags(path string, tags map[string]string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	var extra []byte
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if tags[key] == "" {
			continue
		}
		data := mp4Atom("mean", append(make([]byte, 4), "com.apple.iTunes"...))
		data = append(data, mp4Atom("name", append(make([]byte, 4), key...))...)
		data = append(data, mp4Atom("data", append([]byte{0, 0, 0, 1, 0, 0, 0, 0}, tags[key]...))...)
		extra = append(extra, mp4Atom("----", data)...)
	}
	for offset := int64(0); offset < info.Size(); {
		var header [16]byte
		if _, err = f.ReadAt(header[:8], offset); err != nil {
			return err
		}
		length := int64(binary.BigEndian.Uint32(header[:4]))
		headerSize := int64(8)
		if length == 1 {
			if _, err = f.ReadAt(header[8:], offset+8); err != nil {
				return err
			}
			length = int64(binary.BigEndian.Uint64(header[8:]))
			headerSize = 16
		}
		if length == 0 {
			length = info.Size() - offset
		}
		if length < headerSize || offset+length > info.Size() {
			return ErrInvalid
		}
		if string(header[4:8]) == "moov" {
			if offset+length != info.Size() || length > 32<<20 {
				return fmt.Errorf("unsupported generated MP4 metadata layout: %w", ErrInvalid)
			}
			body := make([]byte, length-headerSize)
			if _, err = f.ReadAt(body, offset+headerSize); err != nil {
				return err
			}
			body, err = appendMP4Metadata(body, []string{"udta", "meta", "ilst"}, extra)
			if err != nil {
				return err
			}
			if _, err = f.WriteAt(mp4Atom("moov", body), offset); err != nil {
				return err
			}
			return f.Truncate(offset + int64(len(body)) + 8)
		}
		offset += length
	}
	return fmt.Errorf("MP4 metadata box missing: %w", ErrInvalid)
}

func utf16LE(value string) []byte {
	var data []byte
	for _, v := range utf16.Encode([]rune(value + "\x00")) {
		data = binary.LittleEndian.AppendUint16(data, v)
	}
	return data
}

func addASFArtwork(path, coverPath string) error {
	image, err := os.ReadFile(coverPath)
	if err != nil {
		return err
	}
	input, err := os.Open(path)
	if err != nil {
		return err
	}
	defer input.Close()
	var prefix [30]byte
	if _, err = input.ReadAt(prefix[:], 0); err != nil {
		return err
	}
	headerSize := int64(binary.LittleEndian.Uint64(prefix[16:24]))
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if headerSize < 30 || headerSize > 32<<20 || headerSize > info.Size() {
		return ErrInvalid
	}
	header := make([]byte, headerSize)
	if _, err = input.ReadAt(header, 0); err != nil {
		return err
	}
	picture := binary.LittleEndian.AppendUint32([]byte{3}, uint32(len(image)))
	picture = append(picture, utf16LE("image/jpeg")...)
	picture = append(picture, utf16LE("")...)
	picture = append(picture, image...)
	name := utf16LE("WM/Picture")
	record := binary.LittleEndian.AppendUint16(nil, 1)
	record = append(record, 0, 0, 0, 0)
	record = binary.LittleEndian.AppendUint16(record, uint16(len(name)))
	record = binary.LittleEndian.AppendUint16(record, 1)
	record = binary.LittleEndian.AppendUint32(record, uint32(len(picture)))
	record = append(record, name...)
	record = append(record, picture...)
	object := []byte{0x94, 0x1c, 0x23, 0x44, 0x98, 0x94, 0xd1, 0x49, 0xa1, 0x41, 0x1d, 0x13, 0x4e, 0x45, 0x70, 0x54}
	object = binary.LittleEndian.AppendUint64(object, uint64(len(record)+24))
	object = append(object, record...)
	binary.LittleEndian.PutUint64(header[16:24], uint64(headerSize+int64(len(object))))
	binary.LittleEndian.PutUint32(header[24:28], binary.LittleEndian.Uint32(header[24:28])+1)
	fileProperties := []byte{0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65}
	for offset := int64(30); offset < headerSize; {
		if offset+24 > headerSize {
			return ErrInvalid
		}
		length := int64(binary.LittleEndian.Uint64(header[offset+16 : offset+24]))
		if length < 24 || offset+length > headerSize {
			return ErrInvalid
		}
		if bytes.Equal(header[offset:offset+16], fileProperties) {
			if length < 48 {
				return ErrInvalid
			}
			binary.LittleEndian.PutUint64(header[offset+40:offset+48], uint64(info.Size()+int64(len(object))))
		}
		offset += length
	}
	output, err := os.CreateTemp(filepath.Dir(path), ".asf-artwork-*")
	if err != nil {
		return err
	}
	staged := output.Name()
	defer os.Remove(staged)
	if _, err = output.Write(header); err == nil {
		_, err = output.Write(object)
	}
	if err == nil {
		_, err = io.Copy(output, io.NewSectionReader(input, headerSize, info.Size()-headerSize))
	}
	closeErr := output.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(staged, path)
}

func writeWAVTags(source, output string, tags map[string]string, coverPath string) error {
	id3, err := id3Tags(tags, coverPath)
	if err != nil {
		return err
	}
	input, out, size, err := audioFiles(source, output)
	if err != nil {
		return err
	}
	defer input.Close()
	defer out.Close()
	var header [12]byte
	if _, err = input.ReadAt(header[:], 0); err != nil {
		return err
	}
	rf64 := string(header[:4]) == "RF64"
	if (!rf64 && string(header[:4]) != "RIFF") || string(header[8:12]) != "WAVE" {
		return fmt.Errorf("此 WAV 容器暂不支持写回：%w", ErrInvalid)
	}
	if _, err = out.Write(header[:]); err != nil {
		return err
	}
	dataSize, ds64Offset := int64(0), int64(0)
	for offset := int64(12); offset < size; {
		var chunk [8]byte
		if _, err = input.ReadAt(chunk[:], offset); err != nil {
			return err
		}
		length := int64(binary.LittleEndian.Uint32(chunk[4:]))
		name := string(chunk[:4])
		if name == "data" && length == 0xffffffff && rf64 {
			length = dataSize
		}
		padded := length + length%2
		if length < 0 || offset+8+padded > size {
			return fmt.Errorf("invalid WAV chunk: %w", ErrInvalid)
		}
		skip := strings.EqualFold(name, "id3 ")
		if name == "LIST" && length >= 4 {
			var kind [4]byte
			if _, err = input.ReadAt(kind[:], offset+8); err != nil {
				return err
			}
			skip = string(kind[:]) == "INFO"
		}
		if name == "ds64" && length >= 28 {
			var values [16]byte
			if _, err = input.ReadAt(values[:], offset+8); err != nil {
				return err
			}
			dataSize = int64(binary.LittleEndian.Uint64(values[8:]))
			ds64Offset, err = out.Seek(0, io.SeekCurrent)
			if err != nil {
				return err
			}
			ds64Offset += 8
		}
		if !skip {
			if _, err = io.Copy(out, io.NewSectionReader(input, offset, 8+padded)); err != nil {
				return err
			}
		}
		offset += 8 + padded
	}
	writeChunk := func(name string, data []byte) error {
		header := binary.LittleEndian.AppendUint32([]byte(name), uint32(len(data)))
		if _, err := out.Write(header); err != nil {
			return err
		}
		if _, err := out.Write(data); err != nil {
			return err
		}
		if len(data)%2 != 0 {
			_, err := out.Write([]byte{0})
			return err
		}
		return nil
	}
	info := bytes.NewBufferString("INFO")
	for _, entry := range [][2]string{{"title", "INAM"}, {"artist", "IART"}, {"album", "IPRD"}, {"genre", "IGNR"}, {"date", "ICRD"}, {"track", "ITRK"}, {"comment", "ICMT"}, {"copyright", "ICOP"}} {
		if value := tags[entry[0]]; value != "" {
			info.WriteString(entry[1])
			binary.Write(info, binary.LittleEndian, uint32(len(value)+1))
			info.WriteString(value)
			info.WriteByte(0)
			if (len(value)+1)%2 != 0 {
				info.WriteByte(0)
			}
		}
	}
	if err = writeChunk("LIST", info.Bytes()); err != nil {
		return err
	}
	if err = writeChunk("id3 ", id3); err != nil {
		return err
	}
	end, err := out.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if rf64 {
		if ds64Offset == 0 {
			return fmt.Errorf("RF64 size table required: %w", ErrInvalid)
		}
		_, err = out.WriteAt(binary.LittleEndian.AppendUint64(nil, uint64(end-8)), ds64Offset)
	} else {
		if end-8 > 0xffffffff {
			return fmt.Errorf("WAV file exceeds RIFF size limit: %w", ErrInvalid)
		}
		_, err = out.WriteAt(binary.LittleEndian.AppendUint32(nil, uint32(end-8)), 4)
	}
	return err
}
