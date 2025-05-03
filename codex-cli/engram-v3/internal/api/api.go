package api

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/nkkko/engram-v3/internal/lockmanager"
	"github.com/nkkko/engram-v3/internal/notifier"
	"github.com/nkkko/engram-v3/internal/router"
	"github.com/nkkko/engram-v3/internal/search"
	"github.com/nkkko/engram-v3/internal/storage"
	"github.com/nkkko/engram-v3/pkg/proto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"
	"github.com/valyala/fasthttp/fasthttpadaptor"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Config contains API configuration
type Config struct {
	// Server address
	Addr string
}

// DefaultConfig returns a default configuration
func DefaultConfig() Config {
	return Config{
		Addr: ":8080",
	}
}

// API handles HTTP and gRPC endpoints
type API struct {
	config      Config
	app         *fiber.App
	storage     *storage.Storage
	router      *router.Router
	notifier    *notifier.Notifier
	lockManager *lockmanager.LockManager
	search      *search.Search
	logger      *log.Logger
}

// NewAPI creates a new API instance
func NewAPI(config Config, storage *storage.Storage, router *router.Router, notifier *notifier.Notifier, lockManager *lockmanager.LockManager, search *search.Search) *API {
	logger := log.With().Str("component", "api").Logger()

	if config.Addr == "" {
		config.Addr = DefaultConfig().Addr
	}

	return &API{
		config:      config,
		storage:     storage,
		router:      router,
		notifier:    notifier,
		lockManager: lockManager,
		search:      search,
		logger:      &logger,
	}
}

// Start initializes and runs the API server
func (a *API) Start(ctx context.Context) error {
	a.logger.Info().Str("addr", a.config.Addr).Msg("Starting API server")

	// Create Fiber app
	app := fiber.New(fiber.Config{
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
		BodyLimit:    1024 * 1024, // 1MB
	})

	// Middleware
	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(cors.New())

	// Register routes
	a.registerRoutes(app)

	// Register WebSocket and SSE handlers
	a.notifier.RegisterWebSocketHandler(app)
	a.notifier.RegisterSSEHandler(app)

	// Store app reference
	a.app = app

	// Start server
	go func() {
		if err := app.Listen(a.config.Addr); err != nil {
			a.logger.Error().Err(err).Msg("API server error")
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()
	return nil
}

// registerRoutes sets up all API endpoints
func (a *API) registerRoutes(app *fiber.App) {
	// Health checks
	app.Get("/healthz", func(c *fiber.Ctx) error {
		return c.SendString("OK")
	})

	app.Get("/readyz", func(c *fiber.Ctx) error {
		return c.SendString("OK")
	})

	// Metrics endpoint
	app.Get("/metrics", func(c *fiber.Ctx) error {
		handler := fasthttpadaptor.NewFastHTTPHandler(promhttp.Handler())
		handler(c.Context())
		return nil
	})

	// Work Unit endpoints
	app.Post("/workunit", a.handleCreateWorkUnit)
	app.Get("/workunit/:id", a.handleGetWorkUnit)
	app.Get("/workunits/:contextId", a.handleListWorkUnits)

	// Context endpoints
	app.Patch("/contexts/:id", a.handleUpdateContext)
	app.Get("/contexts/:id", a.handleGetContext)

	// Lock endpoints
	app.Post("/locks", a.handleAcquireLock)
	app.Delete("/locks/:resource", a.handleReleaseLock)
	app.Get("/locks/:resource", a.handleGetLock)

	// Search endpoint
	app.Post("/search", a.handleSearch)
}

// handleCreateWorkUnit creates a new work unit
func (a *API) handleCreateWorkUnit(c *fiber.Ctx) error {
	start := time.Now()

	// Parse request
	var req proto.CreateWorkUnitRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	// Validate request
	if req.ContextId == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Context ID is required",
		})
	}

	if req.AgentId == "" {
		// Extract agent ID from authentication header
		agentID := c.Get("X-Agent-ID")
		if agentID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "Agent ID is required",
			})
		}
		req.AgentId = agentID
	}

	// Create work unit
	workUnit, err := a.storage.CreateWorkUnit(c.Context(), &req)
	if err != nil {
		a.logger.Error().Err(err).Msg("Failed to create work unit")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to create work unit",
		})
	}

	// Log latency
	latency := time.Since(start)
	a.logger.Debug().
		Str("work_unit_id", workUnit.Id).
		Str("context_id", workUnit.ContextId).
		Dur("latency_ms", latency).
		Msg("Work unit created")

	// Return response
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"work_unit": workUnit,
	})
}

// handleGetWorkUnit retrieves a work unit by ID
func (a *API) handleGetWorkUnit(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Work unit ID is required",
		})
	}

	// Get work unit
	workUnit, err := a.storage.GetWorkUnit(c.Context(), id)
	if err != nil {
		a.logger.Error().Err(err).Str("id", id).Msg("Failed to get work unit")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "Work unit not found",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"work_unit": workUnit,
	})
}

// handleListWorkUnits lists work units for a context
func (a *API) handleListWorkUnits(c *fiber.Ctx) error {
	contextID := c.Params("contextId")
	if contextID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Context ID is required",
		})
	}

	// Parse pagination parameters
	limitStr := c.Query("limit", "100")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 || limit > 1000 {
		limit = 100
	}

	cursor := c.Query("cursor", "")
	reverse := c.Query("reverse", "false") == "true"

	// List work units
	workUnits, nextCursor, err := a.storage.ListWorkUnits(c.Context(), contextID, limit, cursor, reverse)
	if err != nil {
		a.logger.Error().Err(err).Str("context_id", contextID).Msg("Failed to list work units")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to list work units",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"work_units":  workUnits,
		"next_cursor": nextCursor,
	})
}

// handleUpdateContext updates a context
func (a *API) handleUpdateContext(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Context ID is required",
		})
	}

	// Parse request
	var req proto.UpdateContextRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	// Set ID from path
	req.Id = id

	// Update context
	context, err := a.storage.UpdateContext(c.Context(), &req)
	if err != nil {
		a.logger.Error().Err(err).Str("id", id).Msg("Failed to update context")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update context",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"context": context,
	})
}

// handleGetContext retrieves a context by ID
func (a *API) handleGetContext(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Context ID is required",
		})
	}

	// Get context
	context, err := a.storage.GetContext(c.Context(), id)
	if err != nil {
		a.logger.Error().Err(err).Str("id", id).Msg("Failed to get context")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "Context not found",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"context": context,
	})
}

// handleAcquireLock acquires a lock on a resource
func (a *API) handleAcquireLock(c *fiber.Ctx) error {
	// Parse request
	var req struct {
		ResourcePath string `json:"resource_path"`
		AgentID      string `json:"agent_id"`
		TTLSeconds   int    `json:"ttl_seconds"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	// Validate request
	if req.ResourcePath == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Resource path is required",
		})
	}

	if req.AgentID == "" {
		// Extract agent ID from authentication header
		agentID := c.Get("X-Agent-ID")
		if agentID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "Agent ID is required",
			})
		}
		req.AgentID = agentID
	}

	// Set default TTL if not provided
	if req.TTLSeconds <= 0 {
		req.TTLSeconds = 60 // 1 minute default
	}

	// Acquire lock
	ttl := time.Duration(req.TTLSeconds) * time.Second
	lock, err := a.lockManager.AcquireLock(c.Context(), req.ResourcePath, req.AgentID, ttl)
	if err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"lock": lock,
	})
}

// handleReleaseLock releases a lock on a resource
func (a *API) handleReleaseLock(c *fiber.Ctx) error {
	resourcePath := c.Params("resource")
	if resourcePath == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Resource path is required",
		})
	}

	// Extract agent ID and lock ID from request
	agentID := c.Get("X-Agent-ID", c.Query("agent_id"))
	if agentID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Agent ID is required",
		})
	}

	lockID := c.Query("lock_id")
	if lockID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Lock ID is required",
		})
	}

	// Release lock
	released, err := a.lockManager.ReleaseLock(c.Context(), resourcePath, agentID, lockID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	if !released {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "Lock not found or already released",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"released": true,
	})
}

// handleGetLock retrieves information about a lock
func (a *API) handleGetLock(c *fiber.Ctx) error {
	resourcePath := c.Params("resource")
	if resourcePath == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Resource path is required",
		})
	}

	// Get lock
	lock, err := a.lockManager.GetLock(c.Context(), resourcePath)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "Lock not found or expired",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"lock": lock,
	})
}

// handleSearch searches for work units
func (a *API) handleSearch(c *fiber.Ctx) error {
	// Parse request
	var req struct {
		Query       string            `json:"query"`
		ContextID   string            `json:"context_id,omitempty"`
		AgentIDs    []string          `json:"agent_ids,omitempty"`
		Types       []string          `json:"types,omitempty"`
		MetaFilters map[string]string `json:"meta_filters,omitempty"`
		Limit       int               `json:"limit,omitempty"`
		Offset      int               `json:"offset,omitempty"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	// Set default limit if not provided
	if req.Limit <= 0 || req.Limit > 1000 {
		req.Limit = 100
	}

	// Convert types to enum values
	var types []proto.WorkUnitType
	for _, typeStr := range req.Types {
		typeEnum, ok := proto.WorkUnitType_value[typeStr]
		if ok {
			types = append(types, proto.WorkUnitType(typeEnum))
		}
	}

	// Perform search
	results, totalCount, err := a.search.Search(c.Context(), req.Query, req.ContextID, req.AgentIDs, types, req.MetaFilters, req.Limit, req.Offset)
	if err != nil {
		a.logger.Error().Err(err).Msg("Search failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "Search failed",
		})
	}

	// Return response
	return c.JSON(fiber.Map{
		"results":      results,
		"total_count":  totalCount,
		"limit":        req.Limit,
		"offset":       req.Offset,
	})
}

// Shutdown stops the API server
func (a *API) Shutdown(ctx context.Context) error {
	a.logger.Info().Msg("Shutting down API server")
	if a.app != nil {
		return a.app.Shutdown()
	}
	return nil
}