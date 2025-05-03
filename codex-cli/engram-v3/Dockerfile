# Build stage
FROM golang:1.21-alpine AS builder

# Install dependencies
RUN apk add --no-cache git gcc musl-dev

# Set working directory
WORKDIR /app

# Copy go mod and sum files
COPY go.mod ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=1 GOOS=linux go build -a -ldflags "-extldflags '-static' -X main.Version=$(git describe --tags --always) -X main.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ) -X main.Commit=$(git rev-parse HEAD)" -o engram ./cmd/engram

# Final stage
FROM alpine:3.18

# Install dependencies
RUN apk add --no-cache ca-certificates tzdata

# Create non-root user
RUN addgroup -S engram && adduser -S engram -G engram

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/engram .

# Create data directory
RUN mkdir -p /app/data && chown -R engram:engram /app/data

# Switch to non-root user
USER engram

# Expose HTTP port
EXPOSE 8080

# Set environment variables
ENV DATA_DIR=/app/data

# Command to run
ENTRYPOINT ["/app/engram"]
CMD ["--addr=:8080", "--data-dir=/app/data"]