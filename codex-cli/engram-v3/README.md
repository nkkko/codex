# Engram v3

A real-time multi-agent collaboration engine with ultra-low latency communication and deterministic context handling.

## Overview

Engram v3 is a platform that enables multiple AI agents to collaborate effectively in real-time. It provides a shared workspace, communication bus, and memory system that prioritizes extremely low latency for interactions and state synchronization.

## Key Features

- Ultra-low-latency capture, store, query, and stream of "Work Units" (< 5 ms local)
- Deterministic context grouping and real-time fan-out to interested agents
- Pluggable locking/concurrency management for shared artifacts
- High-performance in-memory event queue with persistent storage
- Hybrid search capabilities (keyword and semantic)

## Architecture

Engram is built on several core design principles:

1. **Immutable Work Units**: All information is captured as immutable records, allowing for consistent state management.

2. **Event-Driven Architecture**: Internal components communicate via an event system for loose coupling and scaling.

3. **Context-Centric Organization**: Related work units are grouped into contexts, allowing agents to share workspaces.

4. **Append-Only Storage with Indexes**: The storage layer uses an append-only log with efficient indexes for fast retrieval.

5. **Real-Time Fan-Out**: Changes are broadcast to interested agents with minimal latency.

The system is built using a modular architecture with these key components:

- **API Gateway**: High-performance HTTP/gRPC interface
- **Event Router**: Manages work unit distribution
- **Storage Engine**: Append-only log + Key-Value store for durability
- **Notifier**: WebSocket/SSE hub for real-time updates
- **Lock Manager**: Handles resource access control
- **Search Index**: Provides fast retrieval capabilities

## Getting Started

### Prerequisites

- Go 1.21+ or Rust 1.76+
- RocksDB
- Protocol Buffers compiler

### Installation

```bash
# Clone the repository
git clone https://github.com/nkkko/engram-v3.git
cd engram-v3

# Install dependencies
go mod download

# Build the project
make build

# Run the server
./bin/engram
```

### Docker Setup

For containerized deployment:

```bash
# Build the Docker image
make docker-build

# Run the container
make docker-run
```

## Configuration

Engram can be configured via command-line flags, environment variables, or a configuration file. For a full list of configuration options, see the example configuration file:

```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your settings
```

Key configuration options:

```bash
# Using command-line flags
./bin/engram --addr=:8080 --data-dir=./data --log-level=debug

# Using environment variables
export ENGRAM_ADDR=:8080
export ENGRAM_DATA_DIR=./data
./bin/engram
```

## API Surface

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workunit` | POST | Create a new work unit |
| `/workunit/{id}` | GET | Retrieve a specific work unit |
| `/workunits/{contextId}` | GET | List work units for a context |
| `/contexts/{id}` | PATCH | Modify a context |
| `/contexts/{id}` | GET | Get a context |
| `/stream?context={id}` | WebSocket | Stream updates in real-time |
| `/stream-sse?context={id}` | SSE | Stream updates using Server-Sent Events |
| `/locks` | POST | Acquire a lock on a resource |
| `/locks/{resource}` | DELETE | Release a lock |
| `/locks/{resource}` | GET | Get lock information |
| `/search` | POST | Search for work units |

## Performance

Engram v3 is designed for ultra-low latency operations:

- Single WorkUnit write: ≤ 1 ms p99
- Stream fan-out latency: ≤ 5 ms end-to-end
- Query of last 100 units: ≤ 2 ms

## Example Usage

```go
package main

import (
    "fmt"
    "github.com/nkkko/engram-v3/client"
)

func main() {
    // Create a client
    c := client.New("http://localhost:8080")
    
    // Create a context
    ctx, err := c.CreateContext("Example Context")
    if err != nil {
        panic(err)
    }
    
    // Create a work unit
    unit, err := c.CreateWorkUnit(client.WorkUnit{
        ContextID: ctx.ID,
        AgentID:   "agent-1",
        Type:      "MESSAGE",
        Payload:   "Hello, Engram!",
    })
    if err != nil {
        panic(err)
    }
    
    fmt.Printf("Created work unit: %s\n", unit.ID)
    
    // Subscribe to updates
    subscription, err := c.Subscribe(ctx.ID)
    if err != nil {
        panic(err)
    }
    
    for event := range subscription.Events {
        fmt.Printf("Received: %+v\n", event)
    }
}
```

For more examples, see the [examples](./examples) directory.

## Development

```bash
# Run tests
make test

# Run benchmarks
make bench

# Format code
make fmt

# Lint code
make lint

# Generate protobuf code
make proto
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Contact

Nikola - [github.com/nkkko](https://github.com/nkkko)