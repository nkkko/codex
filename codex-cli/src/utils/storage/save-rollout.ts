import type { ResponseItem } from "openai/resources/responses/responses";

import { loadConfig } from "../config";
import { log } from "../logger/log.js";
import fs from "fs/promises";
import os from "os";
import path from "path";

const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const LOGS_ROOT = path.join(os.homedir(), ".codex", "logs");

export interface ConversationLog {
  session: {
    timestamp: string;
    id: string;
    instructions: string;
    model?: string;
    user?: string;
  };
  items: Array<ResponseItem>;
  toolCalls?: Array<ToolCallData>;
  apiCalls?: Array<ApiCallData>;
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

async function appendToConversationLog(
  sessionId: string,
  section: "toolCalls" | "apiCalls",
  data: ToolCallData | ApiCallData,
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