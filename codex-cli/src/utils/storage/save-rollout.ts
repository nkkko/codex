import type { FileOperationLogEntry } from "./file-operations-log";
import type { ResponseItem } from "openai/resources/responses/responses";

import { loadConfig } from "../config";
import { log } from "../logger/log.js";
import fs from "fs/promises";
import os from "os";
import path from "path";


// Deprecated - using LOGS_ROOT for all files now
// const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const LOGS_ROOT = path.join(os.homedir(), ".codex", "logs");

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
  apiCalls?: Array<ApiCallData>;
  fileOperations?: Array<FileOperationLogEntry>;
  errors?: Array<{
    timestamp: string;
    message: string;
    code?: string;
    stack?: string;
    context?: Record<string, unknown>;
  }>;
}

async function saveRolloutAsync(
  sessionId: string,
  items: Array<ResponseItem>,
): Promise<void> {
  // Use the same logs directory as the conversation logs
  await fs.mkdir(LOGS_ROOT, { recursive: true });

  const timestamp = new Date().toISOString();
  const ts = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `rollout-${ts}-${sessionId}.json`;
  const filePath = path.join(LOGS_ROOT, filename);
  const config = loadConfig();

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          session: {
            timestamp,
            id: sessionId,
            instructions: config.instructions,
          },
          items,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    log(`error: failed to save rollout to ${filePath}: ${error}`);
  }
}

export function saveRollout(
  sessionId: string,
  items: Array<ResponseItem>,
): void {
  // Best-effort. We also do not log here in case of failure as that should be taken care of
  // by `saveRolloutAsync` already.
  saveRolloutAsync(sessionId, items).catch(() => {});
}

/**
 * Logs a full conversation with all interactions to a JSON file 
 * in ~/.codex/logs directory with format conversation-YYYY-MM-DD-sessionId.json
 */
export async function logConversation(
  conversationLog: ConversationLog,
): Promise<string> {
  await fs.mkdir(LOGS_ROOT, { recursive: true });

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${conversationLog.session.id}.json`;
  const filePath = path.join(LOGS_ROOT, filename);

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify(conversationLog, null, 2),
      "utf8",
    );
    return filePath;
  } catch (error) {
    log(`error: failed to save conversation log to ${filePath}: ${error}`);
    throw error;
  }
}

/**
 * Records a tool call (such as shell command execution) in the conversation log
 */
export function logToolCall(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  exitCode?: number,
  durationMs?: number,
): Promise<void> {
  return appendToConversationLog(sessionId, "toolCalls", {
    timestamp: new Date().toISOString(),
    toolName,
    args,
    result,
    exitCode,
    durationMs,
  });
}

/**
 * Records an API call to OpenAI in the conversation log
 */
export function logApiCall(
  sessionId: string,
  endpoint: string,
  requestId?: string,
  inputTokens?: number,
  outputTokens?: number, 
  totalTokens?: number,
  durationMs?: number,
  prompt?: string,
  response?: string,
): Promise<void> {
  return appendToConversationLog(sessionId, "apiCalls", {
    timestamp: new Date().toISOString(),
    endpoint,
    requestId,
    inputTokens,
    outputTokens,
    totalTokens,
    durationMs,
    prompt,
    response,
  });
}

/**
 * Updates the items array in the conversation log with the latest conversation state
 * Also extracts message content for easier analysis
 */
export async function updateConversationItems(
  sessionId: string,
  items: Array<ResponseItem>
): Promise<void> {
  if (!sessionId || !items || items.length === 0) {
    return;
  }

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${sessionId}.json`;
  const filePath = path.join(LOGS_ROOT, filename);
  
  try {
    // Ensure logs directory exists
    await fs.mkdir(LOGS_ROOT, { recursive: true });
    
    // Read existing log or create new one
    let conversationLog: ConversationLog;
    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      conversationLog = JSON.parse(fileContent);
    } catch (error) {
      // Create new log if file doesn't exist
      conversationLog = {
        session: {
          timestamp: new Date().toISOString(),
          id: sessionId,
          instructions: loadConfig().instructions || "",
          model: loadConfig().model,
          startedAt: new Date().toISOString(),
          status: "active"
        },
        items: [],
        messages: [],
      };
    }
    
    // Update items array
    conversationLog.items = items;
    
    // Extract message content for easier analysis
    if (!conversationLog.messages) {
      conversationLog.messages = [];
    }
    
    // Extract user and assistant messages carefully to avoid duplicates
    
    // First, let's analyze what messages we already have in the log
    const existingContentByRole: Record<string, Set<string>> = {
      user: new Set(),
      assistant: new Set(),
    };
    
    // Create an initial snapshot of existing messages
    if (conversationLog.messages && conversationLog.messages.length > 0) {
      for (const msg of conversationLog.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          existingContentByRole[msg.role].add(msg.content);
        }
      }
    } else {
      // Initialize empty messages array if it doesn't exist
      conversationLog.messages = [];
    }
    
    // Process new items to extract messages, adding only new ones
    const newMessages: Array<{timestamp: string; role: string; content: string}> = [];
    
    for (const item of items) {
      if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
        // Format content as string
        let content = "";
        if (item.content && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
              content += part.text || "";
            } else if (part.type === "image" && part.source) {
              content += `[Image: ${part.source.data || part.source.url || "embedded"}]`;
            }
          }
        }
        
        // Skip empty content
        if (!content) {
          continue;
        }
        
        // Skip if we already have this exact content for this role
        if (existingContentByRole[item.role].has(content)) {
          continue;
        }
        
        // Add to new messages
        newMessages.push({
          timestamp: item.created_at || new Date().toISOString(),
          role: item.role,
          content: content
        });
        
        // Mark as processed
        existingContentByRole[item.role].add(content);
      }
    }
    
    // Add only new messages to the log
    if (newMessages.length > 0) {
      conversationLog.messages.push(...newMessages);
    }
    
    // Write updated log
    await fs.writeFile(filePath, JSON.stringify(conversationLog, null, 2), 'utf8');
  } catch (error) {
    log(`Error updating conversation items: ${error}`);
  }
}

/**
 * Logs a session start event and initializes the conversation log
 */
export async function logSessionStart(
  sessionId: string, 
  model: string, 
  instructions: string,
  user?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${sessionId}.json`;
  const filePath = path.join(LOGS_ROOT, filename);
  
  // Create logs directory if needed
  await fs.mkdir(LOGS_ROOT, { recursive: true });
  
  // Create initial log file with session metadata
  try {
    const logData: ConversationLog = {
      session: {
        timestamp,
        id: sessionId,
        instructions,
        model,
        user,
        startedAt: timestamp,
        status: "active"
      },
      items: [],
    };
    
    await fs.writeFile(filePath, JSON.stringify(logData, null, 2), "utf8");
    log(`Created session log at ${filePath}`);
  } catch (error) {
    log(`Error creating session log: ${error}`);
  }
}

/**
 * Logs a session end event and updates the conversation log
 */
export async function logSessionEnd(
  sessionId: string,
  status: "completed" | "interrupted" | "errored" = "completed"
): Promise<void> {
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${sessionId}.json`;
  const filePath = path.join(LOGS_ROOT, filename);
  
  try {
    // Read existing log file
    let logData: ConversationLog;
    try {
      const fileContent = await fs.readFile(filePath, "utf8");
      logData = JSON.parse(fileContent);
    } catch (error) {
      // File doesn't exist, create minimal structure
      logData = {
        session: {
          timestamp: new Date().toISOString(),
          id: sessionId,
          instructions: "",
          status: "completed"
        },
        items: [],
      };
    }
    
    // Update session status and end time
    logData.session.endedAt = timestamp;
    logData.session.status = status;
    
    // Write updated log back to file
    await fs.writeFile(filePath, JSON.stringify(logData, null, 2), "utf8");
    log(`Updated session log with end status: ${status}`);
  } catch (error) {
    log(`Error updating session log: ${error}`);
  }
}

/**
 * Logs an error that occurred during conversation
 */
export function logError(
  sessionId: string,
  message: string,
  options: {
    code?: string;
    stack?: string;
    context?: Record<string, unknown>;
  } = {}
): Promise<void> {
  return appendToConversationLog(sessionId, "errors", {
    timestamp: new Date().toISOString(),
    message,
    code: options.code,
    stack: options.stack,
    context: options.context,
  });
}

/**
 * Helper function to append data to an existing conversation log file
 */
type ToolCallData = {
  timestamp: string;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  exitCode?: number;
  durationMs?: number;
};

type ApiCallData = {
  timestamp: string;
  endpoint: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  prompt?: string;
  response?: string;
};

type ErrorLogData = {
  timestamp: string;
  message: string;
  code?: string;
  stack?: string;
  context?: Record<string, unknown>;
};

async function appendToConversationLog(
  sessionId: string,
  section: "toolCalls" | "apiCalls" | "errors" | "fileOperations",
  data: ToolCallData | ApiCallData | ErrorLogData | FileOperationLogEntry,
): Promise<void> {
  await fs.mkdir(LOGS_ROOT, { recursive: true });

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${sessionId}.json`;
  const filePath = path.join(LOGS_ROOT, filename);
  
  try {
    // Check if file exists, if not create a basic structure
    let conversationLog: ConversationLog;
    try {
      const fileContent = await fs.readFile(filePath, "utf8");
      conversationLog = JSON.parse(fileContent);
    } catch (error) {
      // File doesn't exist or can't be read, create new
      conversationLog = {
        session: {
          timestamp: new Date().toISOString(),
          id: sessionId,
          instructions: "",
        },
        items: [],
      };
    }

    // Initialize section if it doesn't exist
    if (!conversationLog[section]) {
      conversationLog[section] = [];
    }

    // Add data to section (type assertion to handle section-specific data types)
    if (section === "toolCalls" && "toolName" in data) {
      (conversationLog.toolCalls as Array<ToolCallData>)?.push(data as ToolCallData);
    } else if (section === "apiCalls" && "endpoint" in data) {
      (conversationLog.apiCalls as Array<ApiCallData>)?.push(data as ApiCallData);
    } else if (section === "errors" && "message" in data) {
      if (!conversationLog.errors) {
        conversationLog.errors = [];
      }
      conversationLog.errors.push(data as ErrorLogData);
    } else if (section === "fileOperations" && "type" in data) {
      if (!conversationLog.fileOperations) {
        conversationLog.fileOperations = [];
      }
      conversationLog.fileOperations.push(data as FileOperationLogEntry);
    }

    // Write back to file
    await fs.writeFile(
      filePath,
      JSON.stringify(conversationLog, null, 2),
      "utf8",
    );
  } catch (error) {
    log(`error: failed to append to conversation log ${filePath}: ${error}`);
  }
}