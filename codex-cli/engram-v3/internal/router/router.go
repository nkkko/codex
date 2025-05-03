package router

import (
	"context"
	"sync"
	"time"

	"github.com/nkkko/engram-v3/pkg/proto"
	"github.com/rs/zerolog/log"
)

// Subscription represents a client's subscription to events
type Subscription struct {
	ID           string
	ContextIDs   []string
	Events       chan *proto.WorkUnit
	LastAccessed time.Time
	mu           sync.Mutex
}

// Config contains router configuration
type Config struct {
	// Maximum buffer size for subscription channels
	MaxBufferSize int
}

// DefaultConfig returns a default router configuration
func DefaultConfig() Config {
	return Config{
		MaxBufferSize: 100,
	}
}

// Router handles event routing to interested subscribers
type Router struct {
	config       Config
	subscriptions map[string]*Subscription
	contextSubs  map[string]map[string]struct{} // contextID -> set of subscription IDs
	mu           sync.RWMutex
	logger       *log.Logger
}

// NewRouter creates a new event router
func NewRouter(config ...Config) *Router {
	var cfg Config
	if len(config) > 0 {
		cfg = config[0]
	} else {
		cfg = DefaultConfig()
	}

	logger := log.With().Str("component", "router").Logger()

	return &Router{
		config:       cfg,
		subscriptions: make(map[string]*Subscription),
		contextSubs:  make(map[string]map[string]struct{}),
		logger:       &logger,
	}
}

// Start begins processing events from the provided stream
func (r *Router) Start(ctx context.Context, events <-chan *proto.WorkUnit) error {
	r.logger.Info().Msg("Starting event router")

	// Start a goroutine to clean up idle subscriptions
	go r.cleanupIdleSubscriptions(ctx)

	// Process events
	for {
		select {
		case event, ok := <-events:
			if !ok {
				r.logger.Info().Msg("Event stream closed, stopping router")
				return nil
			}
			r.routeEvent(event)

		case <-ctx.Done():
			r.logger.Info().Msg("Context canceled, stopping router")
			return ctx.Err()
		}
	}
}

// routeEvent distributes an event to interested subscribers
func (r *Router) routeEvent(event *proto.WorkUnit) {
	if event == nil {
		return
	}

	contextID := event.ContextId
	if contextID == "" {
		r.logger.Warn().Str("id", event.Id).Msg("Work unit has no context ID, cannot route")
		return
	}

	r.mu.RLock()
	subIDs, ok := r.contextSubs[contextID]
	if !ok {
		r.mu.RUnlock()
		return // No subscribers for this context
	}

	// Create a copy of subscription IDs to avoid holding the lock
	ids := make([]string, 0, len(subIDs))
	for id := range subIDs {
		ids = append(ids, id)
	}
	r.mu.RUnlock()

	// Send to each subscriber
	for _, id := range ids {
		r.mu.RLock()
		sub, ok := r.subscriptions[id]
		r.mu.RUnlock()

		if !ok {
			continue
		}

		// Try to send without blocking
		select {
		case sub.Events <- event:
			// Successfully sent
			sub.mu.Lock()
			sub.LastAccessed = time.Now()
			sub.mu.Unlock()

		default:
			// Channel buffer is full, log warning
			r.logger.Warn().
				Str("subscription_id", id).
				Str("context_id", contextID).
				Str("work_unit_id", event.Id).
				Msg("Subscriber channel buffer full, dropping event")
		}
	}
}

// Subscribe creates a new subscription for the specified contexts
func (r *Router) Subscribe(contextIDs ...string) *Subscription {
	sub := &Subscription{
		ID:           generateID(),
		ContextIDs:   contextIDs,
		Events:       make(chan *proto.WorkUnit, r.config.MaxBufferSize),
		LastAccessed: time.Now(),
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Store subscription
	r.subscriptions[sub.ID] = sub

	// Register subscription for each context
	for _, contextID := range contextIDs {
		if _, ok := r.contextSubs[contextID]; !ok {
			r.contextSubs[contextID] = make(map[string]struct{})
		}
		r.contextSubs[contextID][sub.ID] = struct{}{}
	}

	return sub
}

// Unsubscribe removes a subscription
func (r *Router) Unsubscribe(subID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	sub, ok := r.subscriptions[subID]
	if !ok {
		return
	}

	// Remove from context subscriptions
	for _, contextID := range sub.ContextIDs {
		if subs, ok := r.contextSubs[contextID]; ok {
			delete(subs, subID)
			// Clean up empty context entry
			if len(subs) == 0 {
				delete(r.contextSubs, contextID)
			}
		}
	}

	// Close channel and remove subscription
	close(sub.Events)
	delete(r.subscriptions, subID)
}

// UpdateSubscription updates the contexts for a subscription
func (r *Router) UpdateSubscription(subID string, contextIDs ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	sub, ok := r.subscriptions[subID]
	if !ok {
		return fmt.Errorf("subscription not found: %s", subID)
	}

	// Remove from old contexts
	for _, contextID := range sub.ContextIDs {
		if subs, ok := r.contextSubs[contextID]; ok {
			delete(subs, subID)
			// Clean up empty context entry
			if len(subs) == 0 {
				delete(r.contextSubs, contextID)
			}
		}
	}

	// Add to new contexts
	sub.ContextIDs = contextIDs
	for _, contextID := range contextIDs {
		if _, ok := r.contextSubs[contextID]; !ok {
			r.contextSubs[contextID] = make(map[string]struct{})
		}
		r.contextSubs[contextID][subID] = struct{}{}
	}

	// Update last accessed time
	sub.mu.Lock()
	sub.LastAccessed = time.Now()
	sub.mu.Unlock()

	return nil
}

// cleanupIdleSubscriptions periodically removes idle subscriptions
func (r *Router) cleanupIdleSubscriptions(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			r.performCleanup()
		case <-ctx.Done():
			return
		}
	}
}

// performCleanup removes subscriptions that have been idle for too long
func (r *Router) performCleanup() {
	const maxIdleTime = 5 * time.Minute

	now := time.Now()
	var toRemove []string

	r.mu.RLock()
	for id, sub := range r.subscriptions {
		sub.mu.Lock()
		lastAccess := sub.LastAccessed
		sub.mu.Unlock()

		if now.Sub(lastAccess) > maxIdleTime {
			toRemove = append(toRemove, id)
		}
	}
	r.mu.RUnlock()

	// Remove idle subscriptions
	for _, id := range toRemove {
		r.Unsubscribe(id)
		r.logger.Debug().Str("subscription_id", id).Msg("Removed idle subscription")
	}
}

// Shutdown performs cleanup and stops the router
func (r *Router) Shutdown(ctx context.Context) error {
	r.logger.Info().Msg("Shutting down event router")

	r.mu.Lock()
	defer r.mu.Unlock()

	// Close all subscription channels
	for id, sub := range r.subscriptions {
		close(sub.Events)
		delete(r.subscriptions, id)
	}

	// Clear context subscriptions
	r.contextSubs = make(map[string]map[string]struct{})

	return nil
}

// generateID creates a unique subscription ID
func generateID() string {
	return uuid.NewString()
}