package search

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nkkko/engram-v3/pkg/proto"
	"github.com/rs/zerolog/log"
	_ "github.com/mattn/go-sqlite3"
)

// Config contains search configuration
type Config struct {
	// Base directory for data files
	DataDir string
}

// DefaultConfig returns a default configuration
func DefaultConfig() Config {
	return Config{
		DataDir: "./data",
	}
}

// Search provides search capabilities for work units
type Search struct {
	config     Config
	db         *sql.DB
	mu         sync.RWMutex
	logger     *log.Logger
	indexQueue chan *proto.WorkUnit
}

// NewSearch creates a new search index
func NewSearch(config Config) (*Search, error) {
	logger := log.With().Str("component", "search").Logger()

	// Ensure data directory exists
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Initialize search
	s := &Search{
		config:     config,
		logger:     &logger,
		indexQueue: make(chan *proto.WorkUnit, 1000),
	}

	// Initialize SQLite
	if err := s.initSQLite(); err != nil {
		return nil, err
	}

	return s, nil
}

// initSQLite initializes the SQLite database with FTS5
func (s *Search) initSQLite() error {
	dbPath := filepath.Join(s.config.DataDir, "search.db")

	// Open database
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return fmt.Errorf("failed to open SQLite database: %w", err)
	}

	// Configure database
	_, err = db.Exec("PRAGMA journal_mode = WAL")
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to configure SQLite journal mode: %w", err)
	}

	_, err = db.Exec("PRAGMA synchronous = NORMAL")
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to configure SQLite synchronous mode: %w", err)
	}

	// Create tables if they don't exist
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS work_units (
			id TEXT PRIMARY KEY,
			context_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			type INTEGER NOT NULL,
			timestamp INTEGER NOT NULL,
			payload BLOB,
			created_at INTEGER NOT NULL
		)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create work_units table: %w", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS meta (
			work_unit_id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (work_unit_id, key),
			FOREIGN KEY (work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE
		)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create meta table: %w", err)
	}

	_, err = db.Exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS work_units_fts USING fts5(
			id,
			context_id,
			agent_id,
			payload,
			meta_values,
			content=''
		)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create FTS table: %w", err)
	}

	// Create indexes
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_work_units_context_timestamp 
		ON work_units(context_id, timestamp)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create index: %w", err)
	}

	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_work_units_agent 
		ON work_units(agent_id)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create index: %w", err)
	}

	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_work_units_type 
		ON work_units(type)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create index: %w", err)
	}

	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_meta_key_value 
		ON meta(key, value)
	`)
	if err != nil {
		db.Close()
		return fmt.Errorf("failed to create index: %w", err)
	}

	s.db = db
	return nil
}

// Start begins the search indexer operation
func (s *Search) Start(ctx context.Context, events <-chan *proto.WorkUnit) error {
	s.logger.Info().Msg("Starting search indexer")

	// Process events from storage
	go func() {
		for {
			select {
			case event, ok := <-events:
				if !ok {
					s.logger.Info().Msg("Event stream closed, stopping indexer")
					return
				}
				
				// Send to indexing queue
				select {
				case s.indexQueue <- event:
					// Successfully queued
				default:
					s.logger.Warn().Str("id", event.Id).Msg("Index queue full, dropping work unit")
				}
				
			case <-ctx.Done():
				s.logger.Info().Msg("Context canceled, stopping indexer")
				return
			}
		}
	}()
	
	// Process index queue
	go s.processIndexQueue(ctx)

	return nil
}

// processIndexQueue handles indexing of work units
func (s *Search) processIndexQueue(ctx context.Context) {
	const batchSize = 100
	const maxWait = 200 * time.Millisecond
	
	var batch []*proto.WorkUnit
	ticker := time.NewTicker(maxWait)
	defer ticker.Stop()
	
	for {
		select {
		case unit, ok := <-s.indexQueue:
			if !ok {
				// Channel closed, index any remaining items
				if len(batch) > 0 {
					s.indexBatch(batch)
				}
				return
			}
			
			batch = append(batch, unit)
			if len(batch) >= batchSize {
				s.indexBatch(batch)
				batch = batch[:0]
			}
			
		case <-ticker.C:
			// Process any accumulated items after the wait period
			if len(batch) > 0 {
				s.indexBatch(batch)
				batch = batch[:0]
			}
			
		case <-ctx.Done():
			// Context canceled, index any remaining items
			if len(batch) > 0 {
				s.indexBatch(batch)
			}
			return
		}
	}
}

// indexBatch indexes a batch of work units
func (s *Search) indexBatch(units []*proto.WorkUnit) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Begin transaction
	tx, err := s.db.Begin()
	if err != nil {
		s.logger.Error().Err(err).Msg("Failed to begin transaction")
		return
	}
	
	// Prepare statements
	stmtWorkUnit, err := tx.Prepare(`
		INSERT OR REPLACE INTO work_units 
		(id, context_id, agent_id, type, timestamp, payload, created_at) 
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		s.logger.Error().Err(err).Msg("Failed to prepare work unit statement")
		tx.Rollback()
		return
	}
	defer stmtWorkUnit.Close()
	
	stmtMeta, err := tx.Prepare(`
		INSERT OR REPLACE INTO meta 
		(work_unit_id, key, value) 
		VALUES (?, ?, ?)
	`)
	if err != nil {
		s.logger.Error().Err(err).Msg("Failed to prepare meta statement")
		tx.Rollback()
		return
	}
	defer stmtMeta.Close()
	
	stmtFTS, err := tx.Prepare(`
		INSERT OR REPLACE INTO work_units_fts 
		(id, context_id, agent_id, payload, meta_values) 
		VALUES (?, ?, ?, ?, ?)
	`)
	if err != nil {
		s.logger.Error().Err(err).Msg("Failed to prepare FTS statement")
		tx.Rollback()
		return
	}
	defer stmtFTS.Close()
	
	// Process each work unit
	for _, unit := range units {
		// Skip if no ID
		if unit.Id == "" {
			continue
		}
		
		// Extract payload as string if it's text
		var payloadStr string
		if unit.Payload != nil {
			// Check if payload is likely text
			if isTextPayload(unit.Payload) {
				payloadStr = string(unit.Payload)
			}
		}
		
		// Get timestamp
		var timestamp int64
		if unit.Ts != nil {
			timestamp = unit.Ts.AsTime().UnixNano()
		} else {
			timestamp = time.Now().UnixNano()
		}
		
		// Insert work unit
		_, err = stmtWorkUnit.Exec(
			unit.Id,
			unit.ContextId,
			unit.AgentId,
			int(unit.Type),
			timestamp,
			unit.Payload,
			time.Now().UnixNano(),
		)
		if err != nil {
			s.logger.Error().Err(err).Str("id", unit.Id).Msg("Failed to insert work unit")
			continue
		}
		
		// Insert metadata
		var metaValues []string
		for key, value := range unit.Meta {
			_, err = stmtMeta.Exec(unit.Id, key, value)
			if err != nil {
				s.logger.Error().Err(err).Str("id", unit.Id).Msg("Failed to insert metadata")
				continue
			}
			metaValues = append(metaValues, value)
		}
		
		// Insert into FTS
		_, err = stmtFTS.Exec(
			unit.Id,
			unit.ContextId,
			unit.AgentId,
			payloadStr,
			strings.Join(metaValues, " "),
		)
		if err != nil {
			s.logger.Error().Err(err).Str("id", unit.Id).Msg("Failed to insert into FTS")
		}
	}
	
	// Commit transaction
	if err := tx.Commit(); err != nil {
		s.logger.Error().Err(err).Msg("Failed to commit transaction")
		tx.Rollback()
		return
	}
	
	s.logger.Debug().Int("count", len(units)).Msg("Indexed work units")
}

// isTextPayload checks if a byte array is likely text
func isTextPayload(data []byte) bool {
	// Simple heuristic: check if the first 512 bytes contain only printable ASCII or common Unicode characters
	maxCheck := len(data)
	if maxCheck > 512 {
		maxCheck = 512
	}
	
	for i := 0; i < maxCheck; i++ {
		if data[i] < 32 && data[i] != 9 && data[i] != 10 && data[i] != 13 {
			// Non-printable, non-whitespace character
			return false
		}
	}
	
	return true
}

// Search searches for work units
func (s *Search) Search(ctx context.Context, query string, contextID string, agentIDs []string, types []proto.WorkUnitType, metaFilters map[string]string, limit int, offset int) ([]string, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	// Build query
	var conditions []string
	var args []interface{}
	
	// Start with base query
	baseQuery := `
		SELECT w.id FROM work_units w
	`
	
	// Handle full-text search
	if query != "" {
		baseQuery = `
			SELECT w.id FROM work_units w
			INNER JOIN work_units_fts f ON w.id = f.id
			WHERE work_units_fts MATCH ?
		`
		conditions = append(conditions, "")
		args = append(args, query)
	} else {
		conditions = append(conditions, "1=1")
	}
	
	// Filter by context
	if contextID != "" {
		conditions = append(conditions, "w.context_id = ?")
		args = append(args, contextID)
	}
	
	// Filter by agent
	if len(agentIDs) > 0 {
		placeholders := make([]string, len(agentIDs))
		for i, id := range agentIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		conditions = append(conditions, fmt.Sprintf("w.agent_id IN (%s)", strings.Join(placeholders, ",")))
	}
	
	// Filter by type
	if len(types) > 0 {
		placeholders := make([]string, len(types))
		for i, t := range types {
			placeholders[i] = "?"
			args = append(args, int(t))
		}
		conditions = append(conditions, fmt.Sprintf("w.type IN (%s)", strings.Join(placeholders, ",")))
	}
	
	// Filter by metadata
	if len(metaFilters) > 0 {
		for key, value := range metaFilters {
			baseQuery += `
				INNER JOIN meta m_${key} ON w.id = m_${key}.work_unit_id AND m_${key}.key = ? AND m_${key}.value = ?
			`
			baseQuery = strings.Replace(baseQuery, "${key}", key, -1)
			args = append(args, key, value)
		}
	}
	
	// Combine conditions
	whereClause := strings.Join(conditions, " AND ")
	
	// Complete query with order and limit
	query = fmt.Sprintf("%s WHERE %s ORDER BY w.timestamp DESC LIMIT ? OFFSET ?", baseQuery, whereClause)
	args = append(args, limit, offset)
	
	// Count total matches
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM (%s WHERE %s)", baseQuery, whereClause)
	countArgs := args[:len(args)-2] // Remove limit and offset
	
	// Execute count query
	var totalCount int
	err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count search results: %w", err)
	}
	
	// Execute main query
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to execute search query: %w", err)
	}
	defer rows.Close()
	
	// Collect results
	var results []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, 0, fmt.Errorf("failed to scan search result: %w", err)
		}
		results = append(results, id)
	}
	
	return results, totalCount, nil
}

// Shutdown performs cleanup and stops the search indexer
func (s *Search) Shutdown(ctx context.Context) error {
	s.logger.Info().Msg("Shutting down search indexer")
	
	// Close index queue
	close(s.indexQueue)
	
	// Close database
	if s.db != nil {
		if err := s.db.Close(); err != nil {
			return fmt.Errorf("failed to close search database: %w", err)
		}
	}
	
	return nil
}