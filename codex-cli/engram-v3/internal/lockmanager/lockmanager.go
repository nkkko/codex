package lockmanager

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/nkkko/engram-v3/internal/storage"
	"github.com/nkkko/engram-v3/pkg/proto"
	"github.com/rs/zerolog/log"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Config contains lock manager configuration
type Config struct {
	// Default TTL for locks
	DefaultTTL time.Duration

	// How often to clean expired locks
	CleanupInterval time.Duration
}

// DefaultConfig returns a default configuration
func DefaultConfig() Config {
	return Config{
		DefaultTTL:      time.Minute,
		CleanupInterval: time.Minute,
	}
}

// LockManager handles resource locking and concurrency control
type LockManager struct {
	config  Config
	storage *storage.Storage
	locks   map[string]*proto.LockHandle
	mu      sync.RWMutex
	logger  *log.Logger
}

// NewLockManager creates a new lock manager
func NewLockManager(config Config, storage *storage.Storage) *LockManager {
	logger := log.With().Str("component", "lockmanager").Logger()

	if config.DefaultTTL == 0 {
		config.DefaultTTL = DefaultConfig().DefaultTTL
	}

	if config.CleanupInterval == 0 {
		config.CleanupInterval = DefaultConfig().CleanupInterval
	}

	return &LockManager{
		config:  config,
		storage: storage,
		locks:   make(map[string]*proto.LockHandle),
		logger:  &logger,
	}
}

// Start begins the lock manager operation
func (m *LockManager) Start(ctx context.Context) error {
	m.logger.Info().Msg("Starting lock manager")

	// Load existing locks from storage
	if err := m.loadLocks(ctx); err != nil {
		return fmt.Errorf("failed to load locks: %w", err)
	}

	// Start cleanup goroutine
	go m.cleanupExpiredLocks(ctx)

	return nil
}

// loadLocks loads existing locks from storage
func (m *LockManager) loadLocks(ctx context.Context) error {
	// This would use storage to load existing locks
	// For now, just initialize with empty locks
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.locks = make(map[string]*proto.LockHandle)
	return nil
}

// cleanupExpiredLocks periodically removes expired locks
func (m *LockManager) cleanupExpiredLocks(ctx context.Context) {
	ticker := time.NewTicker(m.config.CleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.performCleanup()
		case <-ctx.Done():
			return
		}
	}
}

// performCleanup removes locks that have expired
func (m *LockManager) performCleanup() {
	now := time.Now()
	var expired []string

	m.mu.RLock()
	for path, lock := range m.locks {
		if lock.ExpiresAt.AsTime().Before(now) {
			expired = append(expired, path)
		}
	}
	m.mu.RUnlock()

	if len(expired) > 0 {
		m.mu.Lock()
		for _, path := range expired {
			// Double check that it's still expired
			if lock, exists := m.locks[path]; exists && lock.ExpiresAt.AsTime().Before(now) {
				delete(m.locks, path)
				m.logger.Debug().
					Str("resource", path).
					Str("agent", lock.HolderAgent).
					Msg("Cleaned up expired lock")
			}
		}
		m.mu.Unlock()
	}
}

// AcquireLock attempts to acquire a lock on a resource
func (m *LockManager) AcquireLock(ctx context.Context, resourcePath, agentID string, ttl time.Duration) (*proto.LockHandle, error) {
	if ttl == 0 {
		ttl = m.config.DefaultTTL
	}

	// Create lock request
	req := &proto.AcquireLockRequest{
		ResourcePath: resourcePath,
		AgentId:      agentID,
		TtlSeconds:   int32(ttl.Seconds()),
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if lock is already held
	existingLock, exists := m.locks[resourcePath]
	if exists {
		// If lock exists and is not expired
		if existingLock.ExpiresAt.AsTime().After(time.Now()) {
			// If same agent, extend the lock
			if existingLock.HolderAgent == agentID {
				existingLock.ExpiresAt = timestamppb.New(time.Now().Add(ttl))
				// Update in storage asynchronously
				go m.storage.AcquireLock(context.Background(), req)
				return existingLock, nil
			}
			// Another agent holds the lock
			return nil, fmt.Errorf("resource '%s' is locked by agent '%s' until %s",
				resourcePath, existingLock.HolderAgent, existingLock.ExpiresAt.AsTime().Format(time.RFC3339))
		}
		// Lock exists but is expired, can be taken
	}

	// Create new lock
	lockID := uuid.New().String()
	lock := &proto.LockHandle{
		ResourcePath: resourcePath,
		HolderAgent:  agentID,
		ExpiresAt:    timestamppb.New(time.Now().Add(ttl)),
		LockId:       lockID,
	}

	// Store in memory
	m.locks[resourcePath] = lock

	// Store in storage asynchronously
	go func() {
		if _, err := m.storage.AcquireLock(context.Background(), req); err != nil {
			m.logger.Error().Err(err).
				Str("resource", resourcePath).
				Str("agent", agentID).
				Msg("Failed to persist lock")

			// If we can't persist, remove from memory
			m.mu.Lock()
			if current, exists := m.locks[resourcePath]; exists && current.LockId == lockID {
				delete(m.locks, resourcePath)
			}
			m.mu.Unlock()
		}
	}()

	m.logger.Debug().
		Str("resource", resourcePath).
		Str("agent", agentID).
		Str("lock_id", lockID).
		Time("expires", lock.ExpiresAt.AsTime()).
		Msg("Lock acquired")

	return lock, nil
}

// ReleaseLock releases a lock on a resource
func (m *LockManager) ReleaseLock(ctx context.Context, resourcePath, agentID, lockID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if lock exists
	existingLock, exists := m.locks[resourcePath]
	if !exists {
		return false, nil
	}

	// Verify ownership
	if existingLock.HolderAgent != agentID {
		return false, fmt.Errorf("lock is held by another agent")
	}

	// Verify lock ID
	if existingLock.LockId != lockID {
		return false, fmt.Errorf("lock ID mismatch")
	}

	// Remove from memory
	delete(m.locks, resourcePath)

	// Release in storage asynchronously
	go func() {
		req := &proto.ReleaseLockRequest{
			ResourcePath: resourcePath,
			AgentId:      agentID,
			LockId:       lockID,
		}
		if _, err := m.storage.ReleaseLock(context.Background(), req); err != nil {
			m.logger.Error().Err(err).
				Str("resource", resourcePath).
				Str("agent", agentID).
				Msg("Failed to release lock in storage")
		}
	}()

	m.logger.Debug().
		Str("resource", resourcePath).
		Str("agent", agentID).
		Str("lock_id", lockID).
		Msg("Lock released")

	return true, nil
}

// GetLock retrieves information about a lock
func (m *LockManager) GetLock(ctx context.Context, resourcePath string) (*proto.LockHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	lock, exists := m.locks[resourcePath]
	if !exists {
		return nil, fmt.Errorf("no lock found for resource: %s", resourcePath)
	}

	// Check if lock is expired
	if lock.ExpiresAt.AsTime().Before(time.Now()) {
		return nil, fmt.Errorf("lock found but expired for resource: %s", resourcePath)
	}

	return lock, nil
}

// AcquireMultipleLocks acquires multiple locks in a deadlock-free manner
func (m *LockManager) AcquireMultipleLocks(ctx context.Context, resources []string, agentID string, ttl time.Duration) ([]*proto.LockHandle, error) {
	if len(resources) == 0 {
		return nil, nil
	}

	// Sort resources to avoid deadlocks
	sortedResources := make([]string, len(resources))
	copy(sortedResources, resources)
	sort.Strings(sortedResources)

	// Try to acquire all locks
	locks := make([]*proto.LockHandle, 0, len(sortedResources))
	
	for _, resource := range sortedResources {
		lock, err := m.AcquireLock(ctx, resource, agentID, ttl)
		if err != nil {
			// Failed to acquire lock, release any locks we've already acquired
			for _, acquiredLock := range locks {
				m.ReleaseLock(ctx, acquiredLock.ResourcePath, agentID, acquiredLock.LockId)
			}
			return nil, fmt.Errorf("failed to acquire lock on '%s': %w", resource, err)
		}
		locks = append(locks, lock)
	}

	return locks, nil
}

// Shutdown performs cleanup and stops the lock manager
func (m *LockManager) Shutdown(ctx context.Context) error {
	m.logger.Info().Msg("Shutting down lock manager")
	// No special cleanup needed, just return
	return nil
}