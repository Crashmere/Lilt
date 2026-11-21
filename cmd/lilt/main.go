package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Crashmere/Lilt/internal/music"
	"github.com/Crashmere/Lilt/web"
)

var version = "0.1.0"

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: lilt serve [--addr ADDRESS] [--data DIRECTORY] [--prefix /lilt/] | lilt check --data DIRECTORY")
	}
	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	data := flags.String("data", env("LILT_DATA_DIR", "./data"), "Application-owned data directory")
	addr := flags.String("addr", env("LILT_ADDR", "127.0.0.1:18089"), "HTTP listen address")
	prefix := flags.String("prefix", env("LILT_PREFIX", "/lilt/"), "Application URL prefix")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	if command == "check" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := music.Check(ctx, *data)
		if err != nil {
			return err
		}
		result["version"] = version
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	if command != "serve" {
		return fmt.Errorf("unknown command: %s", command)
	}
	for _, name := range []string{"ffprobe", "ffmpeg", "vips"} {
		if _, err := exec.LookPath(name); err != nil {
			return fmt.Errorf("required media tool %s is not available: %w", name, err)
		}
	}
	canonical, err := music.NormalizePrefix(*prefix)
	if err != nil {
		return err
	}
	store, err := music.Open(*data, canonical)
	if err != nil {
		return err
	}
	defer store.Close()
	assets, err := fs.Sub(web.Files, "dist")
	if err != nil {
		return err
	}
	origins := []string{}
	for _, origin := range strings.Split(os.Getenv("LILT_ORIGINS"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins = append(origins, origin)
		}
	}
	handler, err := music.NewHandler(store, music.ServerConfig{Prefix: canonical, Origins: origins, Version: version, Assets: assets})
	if err != nil {
		return err
	}
	server := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errorsCh := make(chan error, 1)
	go func() { errorsCh <- server.ListenAndServe() }()
	log.Printf("Lilt %s listening at %s%s", version, *addr, canonical)
	select {
	case err := <-errorsCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
			return err
		}
		return nil
	}
}
