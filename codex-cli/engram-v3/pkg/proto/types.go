package proto

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// WorkUnitType defines the type of a work unit
type WorkUnitType int32

const (
	WorkUnitType_UNKNOWN     WorkUnitType = 0
	WorkUnitType_MESSAGE     WorkUnitType = 1
	WorkUnitType_REASONING   WorkUnitType = 2
	WorkUnitType_TOOL_CALL   WorkUnitType = 3
	WorkUnitType_TOOL_RESULT WorkUnitType = 4
	WorkUnitType_FILE_CHANGE WorkUnitType = 5
	WorkUnitType_TASK_STATUS WorkUnitType = 6
	WorkUnitType_ERROR       WorkUnitType = 7
	WorkUnitType_SYSTEM      WorkUnitType = 8
)

// RelationshipType defines how work units relate to each other
type RelationshipType int32

const (
	RelationshipType_UNSPECIFIED RelationshipType = 0
	RelationshipType_SEQUENTIAL  RelationshipType = 1
	RelationshipType_CAUSES      RelationshipType = 2
	RelationshipType_DEPENDS_ON  RelationshipType = 3
	RelationshipType_REFERENCES  RelationshipType = 4
	RelationshipType_RESPONDS_TO RelationshipType = 5
	RelationshipType_MODIFIES    RelationshipType = 6
	RelationshipType_REPLACES    RelationshipType = 7
)

// Relationship represents a typed connection between work units
type Relationship struct {
	TargetId string            `json:"target_id"`
	Type     RelationshipType  `json:"type"`
	Meta     map[string]string `json:"meta,omitempty"`
}

// WorkUnit is an immutable atomic record of information
type WorkUnit struct {
	Id            string            `json:"id"`
	ContextId     string            `json:"context_id"`
	AgentId       string            `json:"agent_id"`
	Type          WorkUnitType      `json:"type"`
	Ts            *timestamppb.Timestamp `json:"ts,omitempty"`
	Meta          map[string]string `json:"meta,omitempty"`
	Payload       []byte            `json:"payload,omitempty"`
	Relationships []*Relationship   `json:"relationships,omitempty"`
}

// Context represents a logical grouping of work units and agents
type Context struct {
	Id          string                    `json:"id"`
	DisplayName string                    `json:"display_name,omitempty"`
	AgentIds    []string                  `json:"agent_ids,omitempty"`
	PinnedUnits []string                  `json:"pinned_units,omitempty"`
	Meta        map[string]string         `json:"meta,omitempty"`
	CreatedAt   *timestamppb.Timestamp    `json:"created_at,omitempty"`
	UpdatedAt   *timestamppb.Timestamp    `json:"updated_at,omitempty"`
}

// LockHandle represents exclusive access rights to a resource
type LockHandle struct {
	ResourcePath string                    `json:"resource_path"`
	HolderAgent  string                    `json:"holder_agent"`
	ExpiresAt    *timestamppb.Timestamp    `json:"expires_at,omitempty"`
	LockId       string                    `json:"lock_id"`
}

// CreateWorkUnitRequest is used to create a new work unit
type CreateWorkUnitRequest struct {
	ContextId     string           `json:"context_id"`
	AgentId       string           `json:"agent_id"`
	Type          WorkUnitType     `json:"type"`
	Meta          map[string]string `json:"meta,omitempty"`
	Payload       []byte           `json:"payload,omitempty"`
	Relationships []*Relationship  `json:"relationships,omitempty"`
}

// CreateWorkUnitResponse returns the created work unit
type CreateWorkUnitResponse struct {
	Unit *WorkUnit `json:"unit"`
}

// GetWorkUnitRequest retrieves a specific work unit by ID
type GetWorkUnitRequest struct {
	Id string `json:"id"`
}

// GetWorkUnitResponse returns the requested work unit
type GetWorkUnitResponse struct {
	Unit *WorkUnit `json:"unit"`
}

// ListWorkUnitsRequest retrieves multiple work units
type ListWorkUnitsRequest struct {
	ContextId string `json:"context_id"`
	Limit     int32  `json:"limit,omitempty"`
	Cursor    string `json:"cursor,omitempty"`
	Reverse   bool   `json:"reverse,omitempty"`
}

// ListWorkUnitsResponse returns the matching work units
type ListWorkUnitsResponse struct {
	Units      []*WorkUnit `json:"units"`
	NextCursor string      `json:"next_cursor,omitempty"`
}

// UpdateContextRequest modifies a context
type UpdateContextRequest struct {
	Id           string            `json:"id"`
	DisplayName  string            `json:"display_name,omitempty"`
	AddAgents    []string          `json:"add_agents,omitempty"`
	RemoveAgents []string          `json:"remove_agents,omitempty"`
	PinUnits     []string          `json:"pin_units,omitempty"`
	UnpinUnits   []string          `json:"unpin_units,omitempty"`
	Meta         map[string]string `json:"meta,omitempty"`
}

// UpdateContextResponse returns the updated context
type UpdateContextResponse struct {
	Context *Context `json:"context"`
}

// AcquireLockRequest requests a lock on a resource
type AcquireLockRequest struct {
	ResourcePath string `json:"resource_path"`
	AgentId      string `json:"agent_id"`
	TtlSeconds   int32  `json:"ttl_seconds,omitempty"`
}

// AcquireLockResponse returns lock information
type AcquireLockResponse struct {
	Lock *LockHandle `json:"lock"`
}

// ReleaseLockRequest releases a previously acquired lock
type ReleaseLockRequest struct {
	ResourcePath string `json:"resource_path"`
	AgentId      string `json:"agent_id"`
	LockId       string `json:"lock_id"`
}

// ReleaseLockResponse confirms the lock release
type ReleaseLockResponse struct {
	Released bool `json:"released"`
}

// SearchRequest searches for work units
type SearchRequest struct {
	Query       string            `json:"query,omitempty"`
	ContextId   string            `json:"context_id,omitempty"`
	AgentIds    []string          `json:"agent_ids,omitempty"`
	Types       []WorkUnitType    `json:"types,omitempty"`
	MetaFilters map[string]string `json:"meta_filters,omitempty"`
	Limit       int32             `json:"limit,omitempty"`
	Offset      int32             `json:"offset,omitempty"`
}

// SearchResponse returns search results
type SearchResponse struct {
	UnitIds      []string `json:"unit_ids"`
	TotalResults int32    `json:"total_results"`
}