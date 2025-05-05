# Conversation Archiving for Codex CLI - Technical Specification

## Overview

This document outlines the implementation of a conversation archiving system for Codex CLI, a terminal-based AI coding assistant. The feature enables comprehensive logging of interactions between users and the AI assistant, including tool calls, API requests, and token usage statistics.

## Goals

1. Save the full interaction between user and AI assistant
2. Track all tool usages (shell commands, file operations, etc.)
3. Monitor API calls to OpenAI models with token usage metrics
4. Provide a command for users to view conversation statistics
5. Create a persistent, structured archive of conversations

## Architecture

### Data Storage

Conversations are stored in JSON files at:
- `~/.codex/logs/conversation-{date}-{sessionId}.json`

Each log file follows this structure:
```typescript
interface ConversationLog {
  session: {
    timestamp: string;      // ISO timestamp of session start
    id: string;             // Unique session identifier
    instructions: string;   // Custom instructions provided
    model?: string;         // Model used (e.g., "o4-mini")
    user?: string;          // User identifier
  };
  items: Array<ResponseItem>; // All conversation messages
  toolCalls?: Array<ToolCallData>; // Tool execution records
  apiCalls?: Array<ApiCallData>;  // OpenAI API call records
}

type ToolCallData = {
  timestamp: string;        // When the tool was called
  toolName: string;         // Tool name (e.g., "shell")
  args: Record<string, unknown>; // Arguments passed to tool
  result: string;           // Output from tool execution
  exitCode?: number;        // Exit code (for shell commands)
  durationMs?: number;      // Execution time in milliseconds
};

type ApiCallData = {
  timestamp: string;        // When the API was called
  endpoint: string;         // API endpoint (e.g., "responses.create")
  requestId?: string;       // Unique request identifier
  inputTokens?: number;     // Input/prompt tokens used
  outputTokens?: number;    // Output/completion tokens used
  totalTokens?: number;     // Total tokens consumed
  durationMs?: number;      // Request duration in milliseconds
};
```

### Components

The implementation consists of these key components:

1. **Storage Module** (`src/utils/storage/save-rollout.ts`):
   - Defines data structures for conversation logs
   - Provides functions to save and update log files
   - Handles file I/O operations

2. **API Call Logging** (`src/utils/agent/agent-loop.ts`):
   - Intercepts OpenAI API calls
   - Records request/response data
   - Captures token usage metrics

3. **Tool Call Logging** (`src/utils/agent/handle-exec-command.ts`):
   - Captures shell commands and other tool invocations
   - Records execution results and performance metrics

4. **Report Command** (`src/components/chat/terminal-chat-input.tsx`):
   - Implements `/report` slash command
   - Generates statistics from conversation logs
   - Displays summary to user

## Implementation Details

### 1. Storage Module

Enhance the existing `save-rollout.ts` with new types and functions:

```typescript
// Define types for log data structures
export interface ConversationLog { ... }
type ToolCallData = { ... }
type ApiCallData = { ... }

// Function to save a complete conversation log
export async function logConversation(log: ConversationLog): Promise<string> {
  // Create logs directory if needed
  // Format filename based on date and session ID
  // Write log file to disk
  // Return file path
}

// Function to log a tool call
export function logToolCall(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  exitCode?: number,
  durationMs?: number
): Promise<void> {
  // Add tool call record to conversation log
}

// Function to log an API call
export function logApiCall(
  sessionId: string,
  endpoint: string,
  requestId?: string,
  inputTokens?: number,
  outputTokens?: number,
  totalTokens?: number,
  durationMs?: number
): Promise<void> {
  // Add API call record to conversation log
}
```

### 2. API Call Logging

Integrate logging into the agent loop:

1. Record API call start time before making requests
2. Log basic call information immediately
3. Update log with token usage when response is received:

```typescript
// Before API call
const apiCallStartTime = Date.now();

// Make the API call
stream = await responseCall({ /* API parameters */ });

// Log the call
const apiCallDuration = Date.now() - apiCallStartTime;
logApiCall(
  this.sessionId,
  this.provider === "openai" ? "responses.create" : "chat.completions",
  undefined,
  undefined,
  undefined,
  undefined,
  apiCallDuration
).catch(err => log(`Failed to log API call: ${err}`));

// When receiving response with token usage
if (event.response.usage) {
  const usage = event.response.usage;
  const inputTokens = (usage as any).input_tokens ?? (usage as any).prompt_tokens;
  const outputTokens = (usage as any).output_tokens ?? (usage as any).completion_tokens;
  logApiCall(
    this.sessionId,
    this.provider === "openai" ? "responses.create" : "chat.completions",
    event.response.id,
    inputTokens,
    outputTokens,
    usage.total_tokens,
    undefined // Duration was already logged
  ).catch(err => log(`Failed to log API call tokens: ${err}`));
}
```

### 3. Tool Call Logging

Integrate logging into the tool execution flow:

```typescript
// After executing a tool (e.g., shell command)
try {
  const sessionId = getSessionId();
  if (sessionId) {
    logToolCall(
      sessionId,
      applyPatchCommand ? "apply_patch" : "shell",
      {
        command: execInput.cmd, 
        workdir: workdir || process.cwd(),
        timeout: execInput.timeoutInMillis
      },
      stdout || stderr,
      exitCode,
      duration
    ).catch(err => log(`Failed to log tool call: ${err}`));
  }
} catch (err) {
  log(`Error logging tool call: ${err}`);
}
```

### 4. Report Command

Add a new slash command for viewing conversation statistics:

1. Add `/report` to `SLASH_COMMANDS` array in `src/utils/slash-commands.ts`:
```typescript
{
  command: "/report", 
  description: "Generate a summary report of the current conversation with stats",
}
```

2. Implement command handler in `terminal-chat-input.tsx`:
```typescript
// Report command handler
if (inputValue === "/report") {
  setInput("");
  
  try {
    // Get the current session ID
    const sessionId = getSessionId();
    if (!sessionId) {
      // Show error if no active session
      return;
    }
    
    // Find existing logs for this session
    const files = await fs.readdir(LOGS_ROOT);
    const sessionFiles = files.filter(file => 
      file.includes(sessionId) && file.startsWith('conversation-')
    );
    
    if (sessionFiles.length === 0) {
      // Create new log if none exists
      const conversationLog = {
        session: { /* session metadata */ },
        items: items || [],
      };
      const logPath = await logConversation(conversationLog);
      // Display confirmation
      return;
    }
    
    // Load and analyze the most recent log
    const mostRecent = sessionFiles.sort().pop()!;
    const filePath = path.join(LOGS_ROOT, mostRecent);
    const fileContent = await fs.readFile(filePath, 'utf8');
    const log = JSON.parse(fileContent);
    
    // Generate statistics
    const toolCallCount = log.toolCalls?.length || 0;
    const apiCallCount = log.apiCalls?.length || 0;
    const messageCount = log.items.length;
    
    // Count token usage
    let totalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0;
    if (log.apiCalls) {
      for (const call of log.apiCalls) {
        if (call.totalTokens) totalTokens += call.totalTokens;
        if (call.inputTokens) totalInputTokens += call.inputTokens;
        if (call.outputTokens) totalOutputTokens += call.outputTokens;
      }
    }
    
    // Display report to user
    // Include session info, message count, tool/API calls, token usage
  } catch (error) {
    // Handle errors
  }
}
```

## User Experience

When a user types `/report`, they will see a summary like:

```
📊 Conversation Report: conversation-2025-05-02-abc123def456.json

Session ID: abc123def456
Started: 5/2/2025, 10:15:32 AM
Messages: 24
Tool Calls: 8
API Calls: 12

Token Usage:
- Input: 4,562
- Output: 3,198
- Total: 7,760

Log file: /Users/username/.codex/logs/conversation-2025-05-02-abc123def456.json
```

## Testing

Test the implementation by:

1. Starting a new conversation session
2. Executing various commands (both successful and failed)
3. Running `/report` to view statistics
4. Examining log files in `~/.codex/logs/`
5. Verifying accurate tracking of:
   - Message interactions
   - Tool calls with outputs
   - API calls with token usage

## Future Enhancements

Possible extensions to this feature:
1. Add conversation exporting to different formats (CSV, HTML)
2. Implement session filtering and search in logs directory
3. Create visualizations for token usage patterns
4. Add support for log retention policies
5. Implement encryption for sensitive conversation data

## Dependencies

This implementation depends on:
- Node.js fs/promises API
- OpenAI API responses
- Existing codex session management

No additional external packages are required beyond what's already in the project.