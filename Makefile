GO := $(shell command -v go 2>/dev/null || echo $(HOME)/.goenv/shims/go)
VERSION ?= 0.1.0
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build linux release deploy portal rollback releases

build:
	npm --prefix web run build
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/lilt ./cmd/lilt

linux:
	npm --prefix web run build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/lilt-linux-amd64 ./cmd/lilt

release:
	bash deploy/release.sh build

deploy:
	bash deploy/release.sh deploy

portal:
	bash deploy/release.sh portal

rollback:
	bash deploy/release.sh rollback $(COMMIT)

releases:
	bash deploy/release.sh list
