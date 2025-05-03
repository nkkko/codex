.PHONY: build clean test run docker-build docker-run proto

# Variables
BINARY_NAME=engram
BUILD_DIR=./bin
PROTO_DIR=./proto
PROTO_OUT=./pkg/proto
VERSION=$(shell git describe --tags --always || echo "dev")
BUILD_TIME=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)
COMMIT=$(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
LDFLAGS=-ldflags "-X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.Commit=${COMMIT}"

# Go commands
GO=go
GOBUILD=$(GO) build
GOCLEAN=$(GO) clean
GOTEST=$(GO) test
GOGET=$(GO) get

# Default target
all: test build

# Build the application
build:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 $(GOBUILD) $(LDFLAGS) -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/engram

# Build with race detection
build-race:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 $(GOBUILD) $(LDFLAGS) -race -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/engram

# Clean build files
clean:
	$(GOCLEAN)
	rm -rf $(BUILD_DIR)
	rm -rf $(PROTO_OUT)

# Run tests
test:
	$(GOTEST) -v ./...

# Run benchmarks
bench:
	$(GOTEST) -bench=. ./...

# Run the application
run:
	$(GO) run $(LDFLAGS) ./cmd/engram

# Build Docker image
docker-build:
	docker build -t engram:$(VERSION) .

# Run Docker container
docker-run:
	docker run -p 8080:8080 -v $(PWD)/data:/app/data engram:$(VERSION)

# Generate Protocol Buffers
proto:
	mkdir -p $(PROTO_OUT)
	protoc --go_out=$(PROTO_OUT) --go_opt=paths=source_relative \
		--go-grpc_out=$(PROTO_OUT) --go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/*.proto

# Download dependencies
deps:
	$(GOGET) -v ./...

# Format code
fmt:
	$(GO) fmt ./...

# Lint code
lint:
	golangci-lint run ./...

# Generate 
generate:
	$(GO) generate ./...

# Install binary
install: build
	cp $(BUILD_DIR)/$(BINARY_NAME) $(GOPATH)/bin/

# Version info
version:
	@echo "Version: $(VERSION)"
	@echo "Build Time: $(BUILD_TIME)"
	@echo "Commit: $(COMMIT)"