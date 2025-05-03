# Codex CLI Conversation Logger

A comprehensive logging system for Codex CLI that captures and archives all interactions between users and the AI assistant. This feature automatically tracks all conversations, tool usage, and API calls, storing them in JSON files for later analysis.

## Features

- Complete conversation archiving (user inputs, AI responses)
- Tool usage tracking (shell commands, file operations)
- API call logging with token usage metrics
- File operation tracking (read/write/append/delete/move)
- Session lifecycle management (start/end timestamps, status tracking)
- Error logging with context
- In-session reporting via `/report` command

## Installation

### Local Installation

1. Clone the repository and build the project:
   ```bash
   git clone https://github.com/yourusername/codex-cli.git
   cd codex-cli
   npm install
   npm run build
   ```

2. Link the package globally:
   ```bash
   npm link
   ```

### Add to System Path on macOS

1. Create a symbolic link in a directory that's in your PATH:
   ```bash
   sudo ln -s "$(pwd)/bin/codex" /usr/local/bin/codex
   ```

2. Alternatively, add the bin directory to your PATH in your shell profile:
   ```bash
   echo 'export PATH="$PATH:/path/to/codex-cli/bin"' >> ~/.zshrc
   # or for bash
   echo 'export PATH="$PATH:/path/to/codex-cli/bin"' >> ~/.bash_profile
   ```

3. Reload your shell configuration:
   ```bash
   source ~/.zshrc  # or source ~/.bash_profile
   ```

## Usage

### Viewing Logs

Conversation logs are stored in `~/.codex/logs/` directory. Each session has its own JSON file with comprehensive logs.

```bash
# List all conversation sessions
ls -la ~/.codex/logs/

# View a specific conversation log
cat ~/.codex/logs/conversation-YYYY-MM-DD-sessionId.json
```

### Generating Reports

Use the `/report` command during a Codex CLI session to view statistics about the current conversation:

```
/report
```

This will display a detailed report including:
- Session ID and status
- Start time and duration
- Number of messages exchanged
- API calls with token usage statistics (input, output, total)
- Tool calls breakdown by type
- File operations summary by operation type
- Any errors encountered

Example output:
```
📊 Conversation Report: conversation-2025-05-02-482eeb7befdd432fa812e180c67a1a26.json

Session ID: 482eeb7befdd432fa812e180c67a1a26
Status: active
Started: 5/2/2025, 5:06:26 PM
Duration: In progress
Messages: 0
Tool Calls: 0
API Calls: 2
File Operations: 0

Token Usage:
    * Input: 1,074
    * Output: 79
    * Total: 1,153

Log file: /Users/nikola/.codex/logs/conversation-2025-05-02-482eeb7befdd432fa812e180c67a1a26.json
```

### Log File Structure

The conversation logs are stored as JSON files with the following structure:

```json
{
  "session": {
    "timestamp": "2025-05-02T15:06:26.046Z",
    "id": "482eeb7befdd432fa812e180c67a1a26",
    "instructions": "",
    "model": "o4-mini",
    "startedAt": "2025-05-02T15:06:26.046Z",
    "status": "active"
  },
  "items": [],
  "messages": [
    {
      "timestamp": "2025-05-02T15:06:40.123Z",
      "role": "user",
      "content": "hi"
    },
    {
      "timestamp": "2025-05-02T15:06:49.486Z",
      "role": "assistant",
      "content": "Hello! How can I assist you today?"
    }
  ],
  "apiCalls": [
    {
      "timestamp": "2025-05-02T15:06:46.772Z",
      "endpoint": "responses.create",
      "durationMs": 1036,
      "prompt": "You are operating as and within the Codex CLI, a terminal-based agentic coding assistant..."
    },
    {
      "timestamp": "2025-05-02T15:06:49.486Z",
      "endpoint": "responses.create",
      "requestId": "resp_6814df86afb081928c71a52b6732970e0627ab6b1d49665a",
      "inputTokens": 1074,
      "outputTokens": 79,
      "totalTokens": 1153,
      "response": "Hello! How can I assist you today?"
    }
  ],
  "toolCalls": [],
  "fileOperations": [],
  "errors": []
}
```

### Programmatic Access

You can access or manipulate the logs programmatically using the functions in `src/utils/storage/save-rollout.ts`:

```typescript
import { 
  logConversation, 
  logToolCall, 
  logApiCall, 
  logSessionStart,
  logSessionEnd,
  logError
} from '/path/to/codex-cli/src/utils/storage/save-rollout';

// Start a new session log
await logSessionStart('session-id', 'model-name', 'instructions');

// Log an API call
await logApiCall('session-id', 'endpoint', 'requestId', inputTokens, outputTokens, totalTokens);

// Log a tool call
await logToolCall('session-id', 'toolName', {arg1: 'value'}, 'result');

// Log an error
await logError('session-id', 'Error message', {code: 'ERROR_CODE'});

// End the session
await logSessionEnd('session-id', 'completed');
```

## Implementation Details

The conversation logging system consists of several key components:

### Core Files

- `src/utils/storage/save-rollout.ts`: Main interface for logging operations
- `src/utils/storage/file-operations-log.ts`: Wrappers for file system operations
- `src/utils/storage/tool-logger.ts`: Universal tool logging wrapper

### Recent Enhancements

- Fixed duplicate report messages by adding unique IDs
- Added user messages and API response content to logs
- Added session lifecycle tracking with timestamps
- Improved token usage tracking and reporting

### Key Data Structures

The `ConversationLog` interface in `save-rollout.ts` defines the structure:

```typescript
export interface ConversationLog {
  session: {
    timestamp: string;
    id: string;
    instructions: string;
    model?: string;
    user?: string;
    startedAt?: string;
    endedAt?: string;
    status?: "active" | "completed" | "interrupted" | "errored";
  };
  items: Array<ResponseItem>;
  messages?: Array<{
    timestamp: string;
    role: string;
    content: string;
  }>;
  toolCalls?: Array<ToolCallData>;
  apiCalls?: Array<{
    timestamp: string;
    endpoint: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    prompt?: string;
    response?: string;
  }>;
  fileOperations?: Array<FileOperationLogEntry>;
  errors?: Array<{
    timestamp: string;
    message: string;
    code?: string;
    stack?: string;
    context?: Record<string, unknown>;
  }>;
}
```

### File Operations Tracking

The file operations logger in `file-operations-log.ts` provides wrappers for common file operations:

- `readFileWithLogging`: Logs read operations
- `writeFileWithLogging`: Logs write operations
- `appendFileWithLogging`: Logs append operations
- `unlinkFileWithLogging`: Logs delete operations
- `renameFileWithLogging`: Logs move operations

### Tool Usage Tracking

The `withToolLogging` function in `tool-logger.ts` provides a universal wrapper for all tool calls:

```typescript
export async function withToolLogging<T>(
  toolName: ToolType,
  args: Record<string, unknown>,
  toolFn: () => Promise<T>
): Promise<T>
```

## Performance Considerations

The logging system is designed to be lightweight and should not impact the performance of Codex CLI significantly. All logging operations are asynchronous and do not block the main conversation flow. However, logs can accumulate over time, so consider periodically cleaning up old log files.