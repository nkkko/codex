package storage

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/linxGnu/grocksdb"
	"github.com/rs/zerolog/log"
	"golang.org/x/sync/errgroup"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	// Note: This would be generated from the engram.proto file
	// For the purpose of this implementation, we'll pretend it exists
	"github.com/nkkko/engram-v3/pkg/proto"
)

const (
	// Column family names
	cfDefault   = "default"
	cfWorkUnits = "workunits"
	cfContexts  = "contexts"
	cfMeta      = "meta"
	cfLocks     = "locks"

	// WAL file name
	walFileName = "wal.log"

	// WAL magic number for file identification
	walMagic = uint32(0x454E4752) // "ENGR" in ASCII
)

// WALEntry represents a single write-ahead log entry
type WALEntry struct {
	Type      WALEntryType
	Timestamp time.Time
	Data      []byte
}

// WALEntryType defines the type of WAL entry
type WALEntryType uint8

const (
	WALWorkUnit WALEntryType = iota + 1
	WALContext
	WALLock
)

// Config contains storage configuration
type Config struct {
	// Base directory for data files
	DataDir string

	// WAL sync interval
	WALSyncInterval time.Duration

	// WAL batch size
	WALBatchSize int
}

// Storage manages persistence of work units and contexts
type Storage struct {
	config      Config
	db          *grocksdb.DB
	cfHandles   map[string]*grocksdb.ColumnFamilyHandle
	walFile     *os.File
	walLock     sync.Mutex
	walEntries  chan WALEntry
	walSync     chan struct{}
	walDone     chan struct{}
	eventStream chan *proto.WorkUnit
	logger      *log.Logger
}

// NewStorage creates a new Storage instance
func NewStorage(config Config) (*Storage, error) {
	logger := log.With().Str("component", "storage").Logger()

	// Ensure data directory exists
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Set up storage instance
	s := &Storage{
		config:      config,
		cfHandles:   make(map[string]*grocksdb.ColumnFamilyHandle),
		walEntries:  make(chan WALEntry, config.WALBatchSize*2), // Double buffer size
		walSync:     make(chan struct{}),
		walDone:     make(chan struct{}),
		eventStream: make(chan *proto.WorkUnit, 1000),
		logger:      &logger,
	}

	// Open WAL file
	walPath := filepath.Join(config.DataDir, walFileName)
	var err error
	s.walFile, err = os.OpenFile(walPath, os.O_CREATE|os.O_APPEND|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open WAL file: %w", err)
	}

	// Initialize RocksDB
	if err := s.initRocksDB(); err != nil {
		s.walFile.Close()
		return nil, err
	}

	// Replay WAL if needed
	if err := s.replayWAL(); err != nil {
		s.db.Close()
		s.walFile.Close()
		return nil, fmt.Errorf("failed to replay WAL: %w", err)
	}

	return s, nil
}

// initRocksDB initializes the RocksDB database
func (s *Storage) initRocksDB() error {
	dbPath := filepath.Join(s.config.DataDir, "kv.db")

	// Define column families
	cfNames := []string{cfDefault, cfWorkUnits, cfContexts, cfMeta, cfLocks}
	
	// Check if DB exists
	dbExists := true
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		dbExists = false
	}

	// Configure RocksDB options
	bbto := grocksdb.NewDefaultBlockBasedTableOptions()
	bbto.SetBlockCache(grocksdb.NewLRUCache(3 << 30)) // 3GB cache
	bbto.SetBlockSize(16 * 1024)                     // 16KB blocks
	bbto.SetFilterPolicy(grocksdb.NewBloomFilter(10))

	opts := grocksdb.NewDefaultOptions()
	opts.SetCreateIfMissing(true)
	opts.SetCreateMissingColumnFamilies(true)
	opts.SetBlockBasedTableFactory(bbto)
	opts.SetMaxBackgroundJobs(4)
	opts.SetCompression(grocksdb.LZ4Compression)
	opts.SetWriteBufferSize(64 * 1024 * 1024) // 64MB
	opts.SetMaxWriteBufferNumber(3)
	opts.SetTargetFileSizeBase(64 * 1024 * 1024) // 64MB
	opts.SetLevel0FileNumCompactionTrigger(4)

	// Open database
	var db *grocksdb.DB
	var cfHandles []*grocksdb.ColumnFamilyHandle
	var err error

	if dbExists {
		// Open existing DB with column families
		cfOpts := make([]*grocksdb.Options, len(cfNames))
		for i := range cfNames {
			cfOpts[i] = opts
		}
		db, cfHandles, err = grocksdb.OpenDbColumnFamilies(opts, dbPath, cfNames, cfOpts)
	} else {
		// Create new DB with default column family
		db, err = grocksdb.OpenDb(opts, dbPath)
		if err != nil {
			return fmt.Errorf("failed to open RocksDB: %w", err)
		}

		// Create other column families
		for _, cfName := range cfNames[1:] {
			cfHandle, err := db.CreateColumnFamily(opts, cfName)
			if err != nil {
				db.Close()
				return fmt.Errorf("failed to create column family %s: %w", cfName, err)
			}
			cfHandles = append(cfHandles, cfHandle)
		}
		
		// Add default CF handle
		cfHandles = append([]*grocksdb.ColumnFamilyHandle{db.DefaultColumnFamily()}, cfHandles...)
	}

	if err != nil {
		return fmt.Errorf("failed to open RocksDB: %w", err)
	}

	// Store DB and column family handles
	s.db = db
	for i, cfName := range cfNames {
		s.cfHandles[cfName] = cfHandles[i]
	}

	return nil
}

// replayWAL replays the WAL to ensure consistency
func (s *Storage) replayWAL() error {
	s.logger.Info().Msg("Replaying WAL")

	// Get WAL file info
	stat, err := s.walFile.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat WAL file: %w", err)
	}

	// Skip if WAL is empty
	if stat.Size() == 0 {
		s.logger.Info().Msg("WAL is empty, no replay needed")
		return nil
	}

	// Read and validate WAL header
	var magic uint32
	if err := binary.Read(s.walFile, binary.LittleEndian, &magic); err != nil {
		return fmt.Errorf("failed to read WAL header: %w", err)
	}

	if magic != walMagic {
		return fmt.Errorf("invalid WAL file format")
	}

	// Reset file position
	if _, err := s.walFile.Seek(4, 0); err != nil {
		return fmt.Errorf("failed to reset WAL file position: %w", err)
	}

	// Read WAL entries
	var entryType uint8
	var timestampNanos int64
	var dataLen uint32
	for {
		// Read entry header
		if err := binary.Read(s.walFile, binary.LittleEndian, &entryType); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("failed to read WAL entry type: %w", err)
		}

		if err := binary.Read(s.walFile, binary.LittleEndian, &timestampNanos); err != nil {
			return fmt.Errorf("failed to read WAL timestamp: %w", err)
		}

		if err := binary.Read(s.walFile, binary.LittleEndian, &dataLen); err != nil {
			return fmt.Errorf("failed to read WAL data length: %w", err)
		}

		// Read entry data
		data := make([]byte, dataLen)
		if _, err := io.ReadFull(s.walFile, data); err != nil {
			return fmt.Errorf("failed to read WAL entry data: %w", err)
		}

		// Process entry based on type
		switch WALEntryType(entryType) {
		case WALWorkUnit:
			var workUnit proto.WorkUnit
			if err := proto.Unmarshal(data, &workUnit); err != nil {
				s.logger.Error().Err(err).Msg("Failed to unmarshal work unit from WAL")
				continue
			}
			if err := s.storeWorkUnitInternal(&workUnit, false); err != nil {
				s.logger.Error().Err(err).Str("id", workUnit.Id).Msg("Failed to restore work unit from WAL")
			}

		case WALContext:
			var context proto.Context
			if err := proto.Unmarshal(data, &context); err != nil {
				s.logger.Error().Err(err).Msg("Failed to unmarshal context from WAL")
				continue
			}
			if err := s.storeContextInternal(&context, false); err != nil {
				s.logger.Error().Err(err).Str("id", context.Id).Msg("Failed to restore context from WAL")
			}

		case WALLock:
			var lock proto.LockHandle
			if err := proto.Unmarshal(data, &lock); err != nil {
				s.logger.Error().Err(err).Msg("Failed to unmarshal lock from WAL")
				continue
			}
			if err := s.storeLockInternal(&lock, false); err != nil {
				s.logger.Error().Err(err).Str("path", lock.ResourcePath).Msg("Failed to restore lock from WAL")
			}
		}
	}

	s.logger.Info().Msg("WAL replay completed")
	return nil
}

// Start begins the storage engine operation
func (s *Storage) Start(ctx context.Context) error {
	// Initialize WAL file if needed
	stat, err := s.walFile.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat WAL file: %w", err)
	}

	if stat.Size() == 0 {
		// Write WAL header with magic number
		if err := binary.Write(s.walFile, binary.LittleEndian, walMagic); err != nil {
			return fmt.Errorf("failed to write WAL header: %w", err)
		}
		if err := s.walFile.Sync(); err != nil {
			return fmt.Errorf("failed to sync WAL header: %w", err)
		}
	}

	// Start WAL processing goroutine
	go s.processWAL(ctx)

	<-ctx.Done()
	close(s.walDone)
	return nil
}

// processWAL handles WAL entry batching and syncing
func (s *Storage) processWAL(ctx context.Context) {
	var batch []WALEntry
	batchSize := s.config.WALBatchSize
	syncInterval := s.config.WALSyncInterval
	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()

	for {
		select {
		case entry := <-s.walEntries:
			batch = append(batch, entry)
			if len(batch) >= batchSize {
				s.syncWALBatch(batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				s.syncWALBatch(batch)
				batch = batch[:0]
			}

		case <-s.walSync:
			if len(batch) > 0 {
				s.syncWALBatch(batch)
				batch = batch[:0]
			}

		case <-s.walDone:
			if len(batch) > 0 {
				s.syncWALBatch(batch)
			}
			return
		}
	}
}

// syncWALBatch writes and syncs a batch of WAL entries
func (s *Storage) syncWALBatch(entries []WALEntry) {
	s.walLock.Lock()
	defer s.walLock.Unlock()

	for _, entry := range entries {
		// Write entry header
		binary.Write(s.walFile, binary.LittleEndian, uint8(entry.Type))
		binary.Write(s.walFile, binary.LittleEndian, entry.Timestamp.UnixNano())
		binary.Write(s.walFile, binary.LittleEndian, uint32(len(entry.Data)))

		// Write entry data
		s.walFile.Write(entry.Data)
	}

	// Sync to disk
	if err := s.walFile.Sync(); err != nil {
		s.logger.Error().Err(err).Msg("Failed to sync WAL file")
	}
}

// Shutdown stops the storage engine
func (s *Storage) Shutdown(ctx context.Context) error {
	// Signal WAL processor to complete and wait
	close(s.walSync)
	select {
	case <-s.walDone:
	case <-ctx.Done():
		return ctx.Err()
	}

	// Close WAL file
	if err := s.walFile.Close(); err != nil {
		s.logger.Error().Err(err).Msg("Error closing WAL file")
	}

	// Close RocksDB
	for _, cfHandle := range s.cfHandles {
		cfHandle.Destroy()
	}
	s.db.Close()

	close(s.eventStream)
	return nil
}

// EventStream returns a channel of work unit events
func (s *Storage) EventStream() <-chan *proto.WorkUnit {
	return s.eventStream
}

// CreateWorkUnit creates a new work unit
func (s *Storage) CreateWorkUnit(ctx context.Context, req *proto.CreateWorkUnitRequest) (*proto.WorkUnit, error) {
	// Generate a new UUIDv7
	id := uuid.New().String()
	
	// Create work unit
	workUnit := &proto.WorkUnit{
		Id:            id,
		ContextId:     req.ContextId,
		AgentId:       req.AgentId,
		Type:          req.Type,
		Ts:            timestamppb.Now(),
		Meta:          req.Meta,
		Payload:       req.Payload,
		Relationships: req.Relationships,
	}

	// Store the work unit
	if err := s.storeWorkUnitInternal(workUnit, true); err != nil {
		return nil, err
	}

	return workUnit, nil
}

// storeWorkUnitInternal stores a work unit and optionally records to WAL
func (s *Storage) storeWorkUnitInternal(workUnit *proto.WorkUnit, logToWAL bool) error {
	// Serialize work unit
	data, err := proto.Marshal(workUnit)
	if err != nil {
		return fmt.Errorf("failed to marshal work unit: %w", err)
	}

	// Log to WAL if requested
	if logToWAL {
		walData, _ := proto.Marshal(workUnit)
		s.walEntries <- WALEntry{
			Type:      WALWorkUnit,
			Timestamp: time.Now(),
			Data:      walData,
		}
	}

	// Write to RocksDB
	wo := grocksdb.NewDefaultWriteOptions()
	defer wo.Destroy()

	// Store primary record
	key := []byte(workUnit.Id)
	if err := s.db.PutCF(wo, s.cfHandles[cfWorkUnits], key, data); err != nil {
		return fmt.Errorf("failed to store work unit: %w", err)
	}

	// Create context-timestamp index
	contextKey := makeContextTimeKey(workUnit.ContextId, workUnit.Ts.AsTime())
	if err := s.db.PutCF(wo, s.cfHandles[cfMeta], contextKey, key); err != nil {
		return fmt.Errorf("failed to create context-time index: %w", err)
	}

	// Send to event stream for real-time notifications
	select {
	case s.eventStream <- workUnit:
	default:
		s.logger.Warn().Str("id", workUnit.Id).Msg("Event stream buffer full, dropping work unit notification")
	}

	return nil
}

// makeContextTimeKey creates a composite key for context-timestamp indexing
func makeContextTimeKey(contextID string, ts time.Time) []byte {
	key := make([]byte, len(contextID)+8)
	copy(key, contextID)
	binary.BigEndian.PutUint64(key[len(contextID):], uint64(ts.UnixNano()))
	return key
}

// GetWorkUnit retrieves a work unit by ID
func (s *Storage) GetWorkUnit(ctx context.Context, id string) (*proto.WorkUnit, error) {
	ro := grocksdb.NewDefaultReadOptions()
	defer ro.Destroy()

	// Get work unit from DB
	key := []byte(id)
	value, err := s.db.GetCF(ro, s.cfHandles[cfWorkUnits], key)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve work unit: %w", err)
	}
	defer value.Free()

	if !value.Exists() {
		return nil, fmt.Errorf("work unit not found: %s", id)
	}

	// Unmarshal work unit
	var workUnit proto.WorkUnit
	if err := proto.Unmarshal(value.Data(), &workUnit); err != nil {
		return nil, fmt.Errorf("failed to unmarshal work unit: %w", err)
	}

	return &workUnit, nil
}

// ListWorkUnits retrieves work units for a context
func (s *Storage) ListWorkUnits(ctx context.Context, contextID string, limit int, cursor string, reverse bool) ([]*proto.WorkUnit, string, error) {
	ro := grocksdb.NewDefaultReadOptions()
	defer ro.Destroy()

	// Set up iterator options
	it := s.db.NewIteratorCF(ro, s.cfHandles[cfMeta])
	defer it.Close()

	// Define prefix for context
	prefix := []byte(contextID)

	// Set up start key
	var startKey []byte
	if cursor == "" {
		startKey = prefix
	} else {
		startKey = []byte(cursor)
	}

	// Position iterator
	if reverse {
		// For reverse iteration, seek to the end of the prefix or cursor
		if cursor == "" {
			// Create a key that's just past the prefix range
			endKey := make([]byte, len(prefix)+8)
			copy(endKey, prefix)
			for i := len(prefix); i < len(endKey); i++ {
				endKey[i] = 0xFF
			}
			it.SeekForPrev(endKey)
		} else {
			it.SeekForPrev(startKey)
		}
	} else {
		it.Seek(startKey)
	}

	// Collect work units
	units := make([]*proto.WorkUnit, 0, limit)
	var nextCursor string

	for i := 0; i < limit && it.Valid(); i++ {
		key := it.Key()
		defer key.Free()

		// Check if we're still in the correct prefix
		if !bytes.HasPrefix(key.Data(), prefix) {
			break
		}

		// Get work unit ID from index
		value := it.Value()
		defer value.Free()
		unitID := string(value.Data())

		// Get the actual work unit
		unit, err := s.GetWorkUnit(ctx, unitID)
		if err != nil {
			s.logger.Error().Err(err).Str("id", unitID).Msg("Failed to retrieve work unit")
			if reverse {
				it.Prev()
			} else {
				it.Next()
			}
			continue
		}

		units = append(units, unit)

		// Advance iterator
		if reverse {
			it.Prev()
		} else {
			it.Next()
		}
	}

	// Set next cursor if more results exist
	if it.Valid() && bytes.HasPrefix(it.Key().Data(), prefix) {
		nextCursor = string(it.Key().Data())
	}

	return units, nextCursor, nil
}

// UpdateContext updates or creates a context
func (s *Storage) UpdateContext(ctx context.Context, req *proto.UpdateContextRequest) (*proto.Context, error) {
	// Get existing context if it exists
	var context *proto.Context
	var err error
	
	existingContext, err := s.GetContext(ctx, req.Id)
	if err == nil {
		// Update existing context
		context = existingContext
		
		// Update display name if provided
		if req.DisplayName != "" {
			context.DisplayName = req.DisplayName
		}
		
		// Add agents
		for _, agentID := range req.AddAgents {
			// Check if agent already exists
			exists := false
			for _, id := range context.AgentIds {
				if id == agentID {
					exists = true
					break
				}
			}
			
			if !exists {
				context.AgentIds = append(context.AgentIds, agentID)
			}
		}
		
		// Remove agents
		if len(req.RemoveAgents) > 0 {
			newAgents := make([]string, 0, len(context.AgentIds))
			for _, id := range context.AgentIds {
				remove := false
				for _, removeID := range req.RemoveAgents {
					if id == removeID {
						remove = true
						break
					}
				}
				
				if !remove {
					newAgents = append(newAgents, id)
				}
			}
			context.AgentIds = newAgents
		}
		
		// Pin units
		for _, unitID := range req.PinUnits {
			// Check if unit already pinned
			exists := false
			for _, id := range context.PinnedUnits {
				if id == unitID {
					exists = true
					break
				}
			}
			
			if !exists {
				context.PinnedUnits = append(context.PinnedUnits, unitID)
			}
		}
		
		// Unpin units
		if len(req.UnpinUnits) > 0 {
			newPinned := make([]string, 0, len(context.PinnedUnits))
			for _, id := range context.PinnedUnits {
				unpin := false
				for _, unpinID := range req.UnpinUnits {
					if id == unpinID {
						unpin = true
						break
					}
				}
				
				if !unpin {
					newPinned = append(newPinned, id)
				}
			}
			context.PinnedUnits = newPinned
		}
		
		// Update metadata
		for k, v := range req.Meta {
			context.Meta[k] = v
		}
		
		// Update timestamp
		context.UpdatedAt = timestamppb.Now()
	} else {
		// Create new context
		if req.Id == "" {
			req.Id = uuid.New().String()
		}
		
		context = &proto.Context{
			Id:          req.Id,
			DisplayName: req.DisplayName,
			AgentIds:    req.AddAgents,
			PinnedUnits: req.PinUnits,
			Meta:        req.Meta,
			CreatedAt:   timestamppb.Now(),
			UpdatedAt:   timestamppb.Now(),
		}
	}
	
	// Store the context
	if err := s.storeContextInternal(context, true); err != nil {
		return nil, err
	}
	
	return context, nil
}

// storeContextInternal stores a context and optionally records to WAL
func (s *Storage) storeContextInternal(context *proto.Context, logToWAL bool) error {
	// Serialize context
	data, err := proto.Marshal(context)
	if err != nil {
		return fmt.Errorf("failed to marshal context: %w", err)
	}
	
	// Log to WAL if requested
	if logToWAL {
		walData, _ := proto.Marshal(context)
		s.walEntries <- WALEntry{
			Type:      WALContext,
			Timestamp: time.Now(),
			Data:      walData,
		}
	}
	
	// Write to RocksDB
	wo := grocksdb.NewDefaultWriteOptions()
	defer wo.Destroy()
	
	// Store context record
	key := []byte(context.Id)
	if err := s.db.PutCF(wo, s.cfHandles[cfContexts], key, data); err != nil {
		return fmt.Errorf("failed to store context: %w", err)
	}
	
	return nil
}

// GetContext retrieves a context by ID
func (s *Storage) GetContext(ctx context.Context, id string) (*proto.Context, error) {
	ro := grocksdb.NewDefaultReadOptions()
	defer ro.Destroy()
	
	// Get context from DB
	key := []byte(id)
	value, err := s.db.GetCF(ro, s.cfHandles[cfContexts], key)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve context: %w", err)
	}
	defer value.Free()
	
	if !value.Exists() {
		return nil, fmt.Errorf("context not found: %s", id)
	}
	
	// Unmarshal context
	var context proto.Context
	if err := proto.Unmarshal(value.Data(), &context); err != nil {
		return nil, fmt.Errorf("failed to unmarshal context: %w", err)
	}
	
	return &context, nil
}

// AcquireLock attempts to acquire a lock on a resource
func (s *Storage) AcquireLock(ctx context.Context, req *proto.AcquireLockRequest) (*proto.LockHandle, error) {
	// Check if lock already exists
	existingLock, err := s.GetLock(ctx, req.ResourcePath)
	if err == nil {
		// Lock exists, check if it's expired
		if existingLock.ExpiresAt.AsTime().After(time.Now()) {
			// Lock is still valid
			if existingLock.HolderAgent != req.AgentId {
				return nil, fmt.Errorf("resource already locked by another agent")
			}
			// Same agent already has the lock, extend it
			existingLock.ExpiresAt = timestamppb.New(time.Now().Add(time.Duration(req.TtlSeconds) * time.Second))
			if err := s.storeLockInternal(existingLock, true); err != nil {
				return nil, err
			}
			return existingLock, nil
		}
		// Lock is expired, can be taken
	}
	
	// Create new lock
	lock := &proto.LockHandle{
		ResourcePath: req.ResourcePath,
		HolderAgent:  req.AgentId,
		ExpiresAt:    timestamppb.New(time.Now().Add(time.Duration(req.TtlSeconds) * time.Second)),
		LockId:       uuid.New().String(),
	}
	
	// Store the lock
	if err := s.storeLockInternal(lock, true); err != nil {
		return nil, err
	}
	
	return lock, nil
}

// storeLockInternal stores a lock and optionally records to WAL
func (s *Storage) storeLockInternal(lock *proto.LockHandle, logToWAL bool) error {
	// Serialize lock
	data, err := proto.Marshal(lock)
	if err != nil {
		return fmt.Errorf("failed to marshal lock: %w", err)
	}
	
	// Log to WAL if requested
	if logToWAL {
		walData, _ := proto.Marshal(lock)
		s.walEntries <- WALEntry{
			Type:      WALLock,
			Timestamp: time.Now(),
			Data:      walData,
		}
	}
	
	// Write to RocksDB
	wo := grocksdb.NewDefaultWriteOptions()
	defer wo.Destroy()
	
	// Store lock record
	key := []byte(lock.ResourcePath)
	if err := s.db.PutCF(wo, s.cfHandles[cfLocks], key, data); err != nil {
		return fmt.Errorf("failed to store lock: %w", err)
	}
	
	return nil
}

// GetLock retrieves a lock by resource path
func (s *Storage) GetLock(ctx context.Context, resourcePath string) (*proto.LockHandle, error) {
	ro := grocksdb.NewDefaultReadOptions()
	defer ro.Destroy()
	
	// Get lock from DB
	key := []byte(resourcePath)
	value, err := s.db.GetCF(ro, s.cfHandles[cfLocks], key)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve lock: %w", err)
	}
	defer value.Free()
	
	if !value.Exists() {
		return nil, fmt.Errorf("lock not found: %s", resourcePath)
	}
	
	// Unmarshal lock
	var lock proto.LockHandle
	if err := proto.Unmarshal(value.Data(), &lock); err != nil {
		return nil, fmt.Errorf("failed to unmarshal lock: %w", err)
	}
	
	return &lock, nil
}

// ReleaseLock releases a lock on a resource
func (s *Storage) ReleaseLock(ctx context.Context, req *proto.ReleaseLockRequest) (bool, error) {
	// Get existing lock
	existingLock, err := s.GetLock(ctx, req.ResourcePath)
	if err != nil {
		// Lock doesn't exist
		return false, nil
	}
	
	// Check if the requester is the lock holder
	if existingLock.HolderAgent != req.AgentId {
		return false, fmt.Errorf("lock is held by another agent")
	}
	
	// Check if lock IDs match
	if existingLock.LockId != req.LockId {
		return false, fmt.Errorf("lock ID mismatch")
	}
	
	// Delete the lock
	wo := grocksdb.NewDefaultWriteOptions()
	defer wo.Destroy()
	
	if err := s.db.DeleteCF(wo, s.cfHandles[cfLocks], []byte(req.ResourcePath)); err != nil {
		return false, fmt.Errorf("failed to delete lock: %w", err)
	}
	
	return true, nil
}