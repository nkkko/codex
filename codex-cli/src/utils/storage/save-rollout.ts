import type { ResponseItem } from "openai/resources/responses/responses";

import { loadConfig } from "../config";
import { log } from "../logger/log.js";
import fs from "fs/promises";
import os from "os";
import path from "path";

const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const LOGS_ROOT = path.join(os.homedir(), ".codex", "logs");

// Import the FileOperationLogEntry type from file-operations-log.ts
import type { FileOperationLogEntry } from "./file-operations-log";

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
  await fs.mkdir(SESSIONS_ROOT, { recursive: true });

  const timestamp = new Date().toISOString();
  const ts = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `rollout-${ts}-${sessionId}.json`;
  const filePath = path.join(SESSIONS_ROOT, filename);
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
): Promise<void> {
  return appendToConversationLog(sessionId, "apiCalls", {
    timestamp: new Date().toISOString(),
    endpoint,
    requestId,
    inputTokens,
    outputTokens,
    totalTokens,
    durationMs,
  });
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
      (conversationLog.toolCalls as ToolCallData[])?.push(data as ToolCallData);
    } else if (section === "apiCalls" && "endpoint" in data) {
      (conversationLog.apiCalls as ApiCallData[])?.push(data as ApiCallData);
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