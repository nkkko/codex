package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nkkko/engram-v3/pkg/proto"
)

// Client is an HTTP client for interacting with the Engram API
type Client struct {
	baseURL     string
	httpClient  *http.Client
	agentID     string
	headers     http.Header
	websocketDialer *websocket.Dialer
	timeout     time.Duration
}

// ClientOption is a function that configures a Client
type ClientOption func(*Client)

// WithTimeout sets the request timeout
func WithTimeout(timeout time.Duration) ClientOption {
	return func(c *Client) {
		c.timeout = timeout
		c.httpClient.Timeout = timeout
	}
}

// WithAgentID sets the agent ID for requests
func WithAgentID(agentID string) ClientOption {
	return func(c *Client) {
		c.agentID = agentID
		c.headers.Set("X-Agent-ID", agentID)
	}
}

// WithHeaders sets additional HTTP headers
func WithHeaders(headers map[string]string) ClientOption {
	return func(c *Client) {
		for k, v := range headers {
			c.headers.Set(k, v)
		}
	}
}

// New creates a new Engram API client
func New(baseURL string, options ...ClientOption) *Client {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")

	client := &Client{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		agentID:    "engram-client",
		headers:    headers,
		websocketDialer: websocket.DefaultDialer,
		timeout:    10 * time.Second,
	}

	// Apply options
	for _, option := range options {
		option(client)
	}

	// Ensure agent ID is set in headers
	client.headers.Set("X-Agent-ID", client.agentID)

	return client
}

// CreateContext creates or updates a context
func (c *Client) CreateContext(ctx context.Context, displayName string, agentIDs []string) (*proto.Context, error) {
	// Create context request
	req := &proto.UpdateContextRequest{
		Id:          fmt.Sprintf("ctx-%d", time.Now().UnixNano()),
		DisplayName: displayName,
		AddAgents:   agentIDs,
	}

	// Add client agent ID if not included
	hasClientAgent := false
	for _, id := range agentIDs {
		if id == c.agentID {
			hasClientAgent = true
			break
		}
	}
	if !hasClientAgent {
		req.AddAgents = append(req.AddAgents, c.agentID)
	}

	// Make request
	resp, err := c.do(ctx, "PATCH", fmt.Sprintf("/contexts/%s", req.Id), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Context *proto.Context `json:"context"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Context, nil
}

// GetContext retrieves a context by ID
func (c *Client) GetContext(ctx context.Context, id string) (*proto.Context, error) {
	// Make request
	resp, err := c.do(ctx, "GET", fmt.Sprintf("/contexts/%s", id), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Context *proto.Context `json:"context"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Context, nil
}

// UpdateContext updates an existing context
func (c *Client) UpdateContext(ctx context.Context, req *proto.UpdateContextRequest) (*proto.Context, error) {
	// Make request
	resp, err := c.do(ctx, "PATCH", fmt.Sprintf("/contexts/%s", req.Id), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Context *proto.Context `json:"context"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Context, nil
}

// CreateWorkUnit creates a new work unit
func (c *Client) CreateWorkUnit(ctx context.Context, req *proto.CreateWorkUnitRequest) (*proto.WorkUnit, error) {
	// Set agent ID if not provided
	if req.AgentId == "" {
		req.AgentId = c.agentID
	}

	// Make request
	resp, err := c.do(ctx, "POST", "/workunit", req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		WorkUnit *proto.WorkUnit `json:"work_unit"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.WorkUnit, nil
}

// GetWorkUnit retrieves a work unit by ID
func (c *Client) GetWorkUnit(ctx context.Context, id string) (*proto.WorkUnit, error) {
	// Make request
	resp, err := c.do(ctx, "GET", fmt.Sprintf("/workunit/%s", id), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		WorkUnit *proto.WorkUnit `json:"work_unit"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.WorkUnit, nil
}

// ListWorkUnits retrieves work units for a context
func (c *Client) ListWorkUnits(ctx context.Context, contextID string, limit int, cursor string, reverse bool) ([]*proto.WorkUnit, string, error) {
	// Build URL
	path := fmt.Sprintf("/workunits/%s?limit=%d", contextID, limit)
	if cursor != "" {
		path += "&cursor=" + url.QueryEscape(cursor)
	}
	if reverse {
		path += "&reverse=true"
	}

	// Make request
	resp, err := c.do(ctx, "GET", path, nil)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		WorkUnits  []*proto.WorkUnit `json:"work_units"`
		NextCursor string        `json:"next_cursor"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, "", fmt.Errorf("failed to decode response: %w", err)
	}

	return response.WorkUnits, response.NextCursor, nil
}

// AcquireLock acquires a lock on a resource
func (c *Client) AcquireLock(ctx context.Context, resourcePath string, ttlSeconds int) (*proto.LockHandle, error) {
	// Create lock request
	req := struct {
		ResourcePath string `json:"resource_path"`
		AgentID      string `json:"agent_id"`
		TTLSeconds   int    `json:"ttl_seconds"`
	}{
		ResourcePath: resourcePath,
		AgentID:      c.agentID,
		TTLSeconds:   ttlSeconds,
	}

	// Make request
	resp, err := c.do(ctx, "POST", "/locks", req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Lock *proto.LockHandle `json:"lock"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Lock, nil
}

// ReleaseLock releases a lock on a resource
func (c *Client) ReleaseLock(ctx context.Context, resourcePath, lockID string) (bool, error) {
	// Build URL
	path := fmt.Sprintf("/locks/%s?agent_id=%s&lock_id=%s", 
		url.PathEscape(resourcePath),
		url.QueryEscape(c.agentID),
		url.QueryEscape(lockID))

	// Make request
	resp, err := c.do(ctx, "DELETE", path, nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Released bool `json:"released"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return false, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Released, nil
}

// GetLock retrieves information about a lock
func (c *Client) GetLock(ctx context.Context, resourcePath string) (*proto.LockHandle, error) {
	// Make request
	resp, err := c.do(ctx, "GET", fmt.Sprintf("/locks/%s", url.PathEscape(resourcePath)), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Lock *proto.LockHandle `json:"lock"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Lock, nil
}

// Search searches for work units
func (c *Client) Search(ctx context.Context, query, contextID string, agentIDs []string, types []string, metaFilters map[string]string, limit, offset int) ([]string, int, error) {
	// Create search request
	req := struct {
		Query       string            `json:"query"`
		ContextID   string            `json:"context_id,omitempty"`
		AgentIDs    []string          `json:"agent_ids,omitempty"`
		Types       []string          `json:"types,omitempty"`
		MetaFilters map[string]string `json:"meta_filters,omitempty"`
		Limit       int               `json:"limit,omitempty"`
		Offset      int               `json:"offset,omitempty"`
	}{
		Query:       query,
		ContextID:   contextID,
		AgentIDs:    agentIDs,
		Types:       types,
		MetaFilters: metaFilters,
		Limit:       limit,
		Offset:      offset,
	}

	// Make request
	resp, err := c.do(ctx, "POST", "/search", req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	// Parse response
	var response struct {
		Results    []string `json:"results"`
		TotalCount int      `json:"total_count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, 0, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Results, response.TotalCount, nil
}

// Subscribe creates a subscription for real-time updates
func (c *Client) Subscribe(contextID string) (*Subscription, error) {
	// Build WebSocket URL
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, err
	}
	
	// Convert to WebSocket scheme
	if u.Scheme == "http" {
		u.Scheme = "ws"
	} else if u.Scheme == "https" {
		u.Scheme = "wss"
	}
	
	// Add path and query
	u.Path = "/stream"
	q := u.Query()
	q.Set("context", contextID)
	u.RawQuery = q.Encode()
	
	// Connect to WebSocket
	headers := make(http.Header)
	headers.Set("X-Agent-ID", c.agentID)
	conn, _, err := c.websocketDialer.Dial(u.String(), headers)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to WebSocket: %w", err)
	}
	
	// Create subscription
	sub := &Subscription{
		Conn:      conn,
		Events:    make(chan *proto.WorkUnit, 100),
		Done:      make(chan struct{}),
		contextID: contextID,
	}
	
	// Start receiving events
	go sub.receiveEvents()
	
	return sub, nil
}

// SubscribeSSE creates a subscription using Server-Sent Events
func (c *Client) SubscribeSSE(ctx context.Context, contextID string) (*SSESubscription, error) {
	// Not fully implemented yet
	return nil, fmt.Errorf("SSE subscription not implemented")
}

// do makes an HTTP request
func (c *Client) do(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	// Create URL
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, err
	}
	u.Path = path
	
	// Create request body
	var bodyReader io.Reader
	if body != nil {
		jsonData, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(jsonData)
	}
	
	// Create request
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bodyReader)
	if err != nil {
		return nil, err
	}
	
	// Set headers
	for k, v := range c.headers {
		req.Header[k] = v
	}
	
	// Make request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	
	// Check for errors
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		
		// Try to parse error message
		body, _ := io.ReadAll(resp.Body)
		
		var errResp struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(body, &errResp); err == nil && errResp.Error != "" {
			return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, errResp.Error)
		}
		
		return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, resp.Status)
	}
	
	return resp, nil
}

// Subscription represents a WebSocket subscription for real-time updates
type Subscription struct {
	Conn      *websocket.Conn
	Events    chan *proto.WorkUnit
	Done      chan struct{}
	contextID string
}

// receiveEvents processes WebSocket messages
func (s *Subscription) receiveEvents() {
	defer func() {
		close(s.Events)
		close(s.Done)
		s.Conn.Close()
	}()
	
	for {
		_, message, err := s.Conn.ReadMessage()
		if err != nil {
			// Connection closed
			return
		}
		
		// Parse message
		var event proto.WorkUnit
		if err := json.Unmarshal(message, &event); err != nil {
			// Try to parse as heartbeat
			var heartbeat struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(message, &heartbeat); err == nil && heartbeat.Type == "heartbeat" {
				// Heartbeat, ignore
				continue
			}
			
			// Unknown message format
			continue
		}
		
		// Send event to channel
		select {
		case s.Events <- &event:
			// Event sent
		default:
			// Channel is full, drop event
		}
	}
}

// Close closes the subscription
func (s *Subscription) Close() error {
	// Send close message
	err := s.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	
	// Wait for done signal
	select {
	case <-s.Done:
		// Closed normally
	case <-time.After(time.Second):
		// Force close
		s.Conn.Close()
	}
	
	return err
}

// SSESubscription represents a Server-Sent Events subscription
type SSESubscription struct {
	Events chan *proto.WorkUnit
	Done   chan struct{}
	cancel context.CancelFunc
}

// Close closes the SSE subscription
func (s *SSESubscription) Close() error {
	s.cancel()
	return nil
}