package engine

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/nkkko/engram-v3/internal/api"
	"github.com/nkkko/engram-v3/internal/lockmanager"
	"github.com/nkkko/engram-v3/internal/notifier"
	"github.com/nkkko/engram-v3/internal/router"
	"github.com/nkkko/engram-v3/internal/search"
	"github.com/nkkko/engram-v3/internal/storage"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"golang.org/x/sync/errgroup"
)

// Config contains engine configuration parameters
type Config struct {
	// Data directory for storage
	DataDir string

	// HTTP server address
	ServerAddr string

	// Log level
	LogLevel string

	// WAL sync interval in milliseconds
	WALSyncIntervalMs int

	// WAL batch size (number of work units)
	WALBatchSize int

	// Lock TTL in seconds
	DefaultLockTTLSeconds int

	// Maximum idle connection time in seconds
	MaxIdleConnectionSeconds int
}

// DefaultConfig returns a configuration with sensible defaults
func DefaultConfig() Config {
	return Config{
		DataDir:                 "./data",
		ServerAddr:              ":8080",
		LogLevel:                "info",
		WALSyncIntervalMs:       2,
		WALBatchSize:            64,
		DefaultLockTTLSeconds:   60,
		MaxIdleConnectionSeconds: 30,
	}
}

// Engine is the main coordinator of all Engram components
type Engine struct {
	config     Config
	storage    *storage.Storage
	router     *router.Router
	notifier   *notifier.Notifier
	lockMgr    *lockmanager.LockManager
	search     *search.Search
	api        *api.API
	shutdownCh chan struct{}
	wg         sync.WaitGroup
	logger     zerolog.Logger
}

// NewEngine creates a new Engine instance with the given configuration
func NewEngine(config Config) (*Engine, error) {
	// Configure logging
	level, err := zerolog.ParseLevel(config.LogLevel)
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)
	logger := log.With().Str("component", "engine").Logger()

	// Ensure data directory exists
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Create engine
	e := &Engine{
		config:     config,
		shutdownCh: make(chan struct{}),
		logger:     logger,
	}

	// Initialize storage
	storageConfig := storage.Config{
		DataDir:         config.DataDir,
		WALSyncInterval: time.Duration(config.WALSyncIntervalMs) * time.Millisecond,
		WALBatchSize:    config.WALBatchSize,
	}
	e.storage, err = storage.NewStorage(storageConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize storage: %w", err)
	}

	// Initialize router
	e.router = router.NewRouter()

	// Initialize notifier
	notifierConfig := notifier.Config{
		MaxIdleTime: time.Duration(config.MaxIdleConnectionSeconds) * time.Second,
	}
	e.notifier = notifier.NewNotifier(notifierConfig)

	// Initialize lock manager
	lockMgrConfig := lockmanager.Config{
		DefaultTTL: time.Duration(config.DefaultLockTTLSeconds) * time.Second,
	}
	e.lockMgr = lockmanager.NewLockManager(lockMgrConfig, e.storage)

	// Initialize search
	searchConfig := search.Config{
		DataDir: config.DataDir,
	}
	e.search, err = search.NewSearch(searchConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize search: %w", err)
	}

	// Initialize API
	apiConfig := api.Config{
		Addr: config.ServerAddr,
	}
	e.api = api.NewAPI(apiConfig, e.storage, e.router, e.notifier, e.lockMgr, e.search)

	return e, nil
}

// Start initializes and runs all components
func (e *Engine) Start() error {
	e.logger.Info().Msg("Starting Engram engine")

	// Create context that cancels on SIGINT/SIGTERM
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Use errgroup for coordinated startup and shutdown
	g, ctx := errgroup.WithContext(ctx)

	// Start storage
	g.Go(func() error {
		e.logger.Info().Msg("Starting storage engine")
		return e.storage.Start(ctx)
	})

	// Start router
	g.Go(func() error {
		e.logger.Info().Msg("Starting event router")
		return e.router.Start(ctx, e.storage.EventStream())
	})

	// Connect router to notifier
	g.Go(func() error {
		e.logger.Info().Msg("Starting event notifier")
		return e.notifier.Start(ctx, e.router.Subscribe())
	})

	// Start search indexer
	g.Go(func() error {
		e.logger.Info().Msg("Starting search indexer")
		return e.search.Start(ctx, e.storage.EventStream())
	})

	// Start API server
	g.Go(func() error {
		e.logger.Info().Str("addr", e.config.ServerAddr).Msg("Starting API server")
		return e.api.Start(ctx)
	})

	// Setup storage tailer for lock manager
	g.Go(func() error {
		e.logger.Info().Msg("Starting lock manager")
		return e.lockMgr.Start(ctx)
	})

	// Handle graceful shutdown
	g.Go(func() error {
		<-ctx.Done()
		e.logger.Info().Msg("Shutting down Engram engine")

		// Create shutdown context with timeout
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Shutdown components in reverse order
		if err := e.api.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down API server")
		}

		if err := e.search.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down search indexer")
		}

		if err := e.notifier.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down notifier")
		}

		if err := e.router.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down router")
		}

		if err := e.lockMgr.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down lock manager")
		}

		if err := e.storage.Shutdown(shutdownCtx); err != nil {
			e.logger.Error().Err(err).Msg("Error shutting down storage")
		}

		return nil
	})

	// Wait for any component to exit
	if err := g.Wait(); err != nil && err != context.Canceled {
		e.logger.Error().Err(err).Msg("Engram engine exited with error")
		return err
	}

	e.logger.Info().Msg("Engram engine shut down successfully")
	return nil
}