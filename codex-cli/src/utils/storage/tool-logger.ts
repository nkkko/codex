import { logToolCall } from "./save-rollout.js";
import { getSessionId } from "../session.js";
import { log } from "../logger/log.js";

// Type definitions for various tool functions
export type GlobToolParams = {
  pattern: string;
  path?: string;
};

export type GrepToolParams = {
  pattern: string;
  path?: string;
  include?: string;
};

export type ViewParams = {
  file_path: string;
  offset?: number;
  limit?: number;
};

export type EditParams = {
  file_path: string;
  old_string: string;
  new_string: string;
  expected_replacements?: number;
};

export type ReplaceParams = {
  file_path: string;
  content: string;
};

export type WebFetchParams = {
  url: string;
  prompt: string;
};

// Tool registry type to track supported tools
export type ToolType = 
  | "shell" 
  | "apply_patch" 
  | "glob" 
  | "grep" 
  | "view" 
  | "edit" 
  | "replace" 
  | "readNotebook" 
  | "editNotebookCell" 
  | "webFetch";

/**
 * Universal tool logging wrapper
 * Use this function before and after any tool call to log both the request and response
 */
export async function withToolLogging<T>(
  toolName: ToolType,
  args: Record<string, unknown>,
  toolFn: () => Promise<T>
): Promise<T> {
  const sessionId = getSessionId();
  if (!sessionId) {
    log(`Failed to log tool call: No active session`);
    return toolFn();
  }

  const startTime = Date.now();
  let result: T;
  let error: Error | undefined;
  
  try {
    result = await toolFn();
    return result;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Convert result to string representation for logging
    let resultStr: string;
    try {
      if (result === undefined) {
        resultStr = "undefined";
      } else if (result === null) {
        resultStr = "null";
      } else if (typeof result === "object") {
        resultStr = JSON.stringify(result);
      } else {
        resultStr = String(result);
      }
    } catch (err) {
      resultStr = `[Object that cannot be stringified: ${err}]`;
    }
    
    try {
      logToolCall(
        sessionId,
        toolName,
        args,
        error ? `Error: ${error.message}` : resultStr,
        error ? 1 : 0,
        duration
      ).catch(err => log(`Failed to log tool call: ${err}`));
    } catch (err) {
      log(`Error logging tool call: ${err}`);
    }
  }
}

/**
 * Wrapper for GlobTool
 */
export async function logGlobTool(
  pattern: string,
  path?: string
): Promise<string[]> {
  const args: GlobToolParams = { pattern };
  if (path) args.path = path;
  
  // Here you would call the actual GlobTool function
  return withToolLogging("glob", args, async () => {
    // Placeholder - in real implementation, call the actual GlobTool function here
    // For example: return originalGlobTool(pattern, path);
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}

/**
 * Wrapper for GrepTool
 */
export async function logGrepTool(
  pattern: string,
  path?: string,
  include?: string
): Promise<string[]> {
  const args: GrepToolParams = { pattern };
  if (path) args.path = path;
  if (include) args.include = include;
  
  return withToolLogging("grep", args, async () => {
    // Placeholder - in real implementation, call the actual GrepTool function here
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}

/**
 * Wrapper for View tool
 */
export async function logViewTool(
  file_path: string,
  offset?: number,
  limit?: number
): Promise<string> {
  const args: ViewParams = { file_path };
  if (offset !== undefined) args.offset = offset;
  if (limit !== undefined) args.limit = limit;
  
  return withToolLogging("view", args, async () => {
    // Placeholder - in real implementation, call the actual View function here
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}

/**
 * Wrapper for Edit tool
 */
export async function logEditTool(
  file_path: string,
  old_string: string,
  new_string: string,
  expected_replacements?: number
): Promise<string> {
  const args: EditParams = { file_path, old_string, new_string };
  if (expected_replacements !== undefined) args.expected_replacements = expected_replacements;
  
  return withToolLogging("edit", args, async () => {
    // Placeholder - in real implementation, call the actual Edit function here
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}

/**
 * Wrapper for Replace tool
 */
export async function logReplaceTool(
  file_path: string,
  content: string
): Promise<string> {
  const args: ReplaceParams = { file_path, content };
  
  return withToolLogging("replace", args, async () => {
    // Placeholder - in real implementation, call the actual Replace function here
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}

/**
 * Wrapper for WebFetch tool
 */
export async function logWebFetchTool(
  url: string,
  prompt: string
): Promise<string> {
  const args: WebFetchParams = { url, prompt };
  
  return withToolLogging("webFetch", args, async () => {
    // Placeholder - in real implementation, call the actual WebFetch function here
    throw new Error("Not implemented - this is just a logging wrapper");
  });
}