package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Base URL for the Engram API
	baseURL = "http://localhost:8080"
	// WebSocket URL for real-time updates
	wsURL = "ws://localhost:8080/stream"
)

// WorkUnit represents a work unit in the system
type WorkUnit struct {
	ID          string                 `json:"id,omitempty"`
	ContextID   string                 `json:"context_id"`
	AgentID     string                 `json:"agent_id"`
	Type        string                 `json:"type"`
	Timestamp   string                 `json:"ts,omitempty"`
	Meta        map[string]string      `json:"meta,omitempty"`
	Payload     string                 `json:"payload"`
	Relationships []map[string]interface{} `json:"relationships,omitempty"`
}

// WorkUnitResponse represents a response for work unit operations
type WorkUnitResponse struct {
	WorkUnit *WorkUnit `json:"work_unit"`
}

// CreateContext creates a new context in the system
func createContext(displayName string) (string, error) {
	// Create context request
	reqBody := map[string]interface{}{
		"display_name": displayName,
		"add_agents":   []string{"client-example"},
	}
	
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}
	
	// Create unique ID
	id := fmt.Sprintf("ctx-%d", time.Now().UnixNano())
	
	// Send request
	resp, err := http.DefaultClient.Do(&http.Request{
		Method: "PATCH",
		URL:    &url.URL{Scheme: "http", Host: "localhost:8080", Path: fmt.Sprintf("/contexts/%s", id)},
		Body:   io.NopCloser(bytes.NewBuffer(jsonData)),
		Header: http.Header{
			"Content-Type": {"application/json"},
			"X-Agent-ID":   {"client-example"},
		},
	})
	
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to create context: %s %s", resp.Status, string(body))
	}
	
	return id, nil
}

// CreateWorkUnit creates a new work unit in the system
func createWorkUnit(contextID, payload string, unitType string) (*WorkUnit, error) {
	// Create work unit request
	workUnit := &WorkUnit{
		ContextID: contextID,
		AgentID:   "client-example",
		Type:      unitType,
		Payload:   payload,
		Meta: map[string]string{
			"source": "example-client",
			"tag":    "example",
		},
	}
	
	jsonData, err := json.Marshal(workUnit)
	if err != nil {
		return nil, err
	}
	
	// Send request
	resp, err := http.DefaultClient.Do(&http.Request{
		Method: "POST",
		URL:    &url.URL{Scheme: "http", Host: "localhost:8080", Path: "/workunit"},
		Body:   io.NopCloser(bytes.NewBuffer(jsonData)),
		Header: http.Header{
			"Content-Type": {"application/json"},
			"X-Agent-ID":   {"client-example"},
		},
	})
	
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to create work unit: %s %s", resp.Status, string(body))
	}
	
	// Parse response
	var response WorkUnitResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, err
	}
	
	return response.WorkUnit, nil
}

// AcquireLock acquires a lock on a resource
func acquireLock(resourcePath string, ttlSeconds int) error {
	// Create lock request
	reqBody := map[string]interface{}{
		"resource_path": resourcePath,
		"agent_id":      "client-example",
		"ttl_seconds":   ttlSeconds,
	}
	
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	
	// Send request
	resp, err := http.DefaultClient.Do(&http.Request{
		Method: "POST",
		URL:    &url.URL{Scheme: "http", Host: "localhost:8080", Path: "/locks"},
		Body:   io.NopCloser(bytes.NewBuffer(jsonData)),
		Header: http.Header{
			"Content-Type": {"application/json"},
			"X-Agent-ID":   {"client-example"},
		},
	})
	
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to acquire lock: %s %s", resp.Status, string(body))
	}
	
	return nil
}

// ReleaseLock releases a lock on a resource
func releaseLock(resourcePath, lockID string) error {
	// Send request
	req, err := http.NewRequest(
		"DELETE",
		fmt.Sprintf("%s/locks/%s?agent_id=client-example&lock_id=%s", baseURL, resourcePath, lockID),
		nil,
	)
	if err != nil {
		return err
	}
	
	req.Header.Set("X-Agent-ID", "client-example")
	
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to release lock: %s %s", resp.Status, string(body))
	}
	
	return nil
}

// StreamUpdates connects to the WebSocket endpoint and receives updates
func streamUpdates(contextID string) error {
	// Connect to WebSocket
	c, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("%s?context=%s", wsURL, contextID), nil)
	if err != nil {
		return err
	}
	defer c.Close()
	
	// Handle interrupts
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	
	// Handle incoming messages
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, message, err := c.ReadMessage()
			if err != nil {
				fmt.Println("WebSocket read error:", err)
				return
			}
			fmt.Printf("Received: %s\n", message)
		}
	}()
	
	// Send periodic pings
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-done:
			return nil
		case <-ticker.C:
			// Send ping
			if err := c.WriteMessage(websocket.TextMessage, []byte(`{"action":"ping"}`)); err != nil {
				return err
			}
		case <-interrupt:
			// Close gracefully
			err := c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			if err != nil {
				return err
			}
			select {
			case <-done:
			case <-time.After(time.Second):
			}
			return nil
		}
	}
}

func main() {
	// Create a context
	contextID, err := createContext("Example Client")
	if err != nil {
		fmt.Println("Failed to create context:", err)
		return
	}
	fmt.Println("Created context:", contextID)
	
	// Start streaming updates in a goroutine
	go func() {
		if err := streamUpdates(contextID); err != nil {
			fmt.Println("Streaming error:", err)
		}
	}()
	
	// Create several work units
	for i := 0; i < 5; i++ {
		workUnit, err := createWorkUnit(
			contextID,
			fmt.Sprintf("This is message #%d from the example client", i+1),
			"MESSAGE",
		)
		if err != nil {
			fmt.Println("Failed to create work unit:", err)
			continue
		}
		fmt.Printf("Created work unit: %s\n", workUnit.ID)
		
		// Sleep to spread out the messages
		time.Sleep(time.Second)
	}
	
	// Acquire a lock
	resourcePath := "example/resource.txt"
	if err := acquireLock(resourcePath, 30); err != nil {
		fmt.Println("Failed to acquire lock:", err)
	} else {
		fmt.Printf("Acquired lock on %s\n", resourcePath)
		
		// Create a work unit showing we acquired the lock
		workUnit, err := createWorkUnit(
			contextID,
			fmt.Sprintf("Acquired lock on %s", resourcePath),
			"TASK_STATUS",
		)
		if err != nil {
			fmt.Println("Failed to create work unit:", err)
		} else {
			fmt.Printf("Created status update: %s\n", workUnit.ID)
		}
		
		// Wait for a while
		time.Sleep(5 * time.Second)
		
		// Release the lock
		if err := releaseLock(resourcePath, "lock-id"); err != nil {
			fmt.Println("Failed to release lock:", err)
		} else {
			fmt.Printf("Released lock on %s\n", resourcePath)
		}
	}
	
	// Wait for user to terminate
	fmt.Println("\nPress Ctrl+C to exit")
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	fmt.Println("Exiting...")
}