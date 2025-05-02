import fs from "fs/promises";
import path from "path";
import os from "os";
import { log } from "../logger/log.js";
import { getSessionId } from "../session.js";

const LOGS_ROOT = path.join(os.homedir(), ".codex", "logs");

/**
 * Type definitions for file operation logging
 */
export type FileOperationType = "read" | "write" | "append" | "delete" | "move" | "edit" | "stat" | "glob" | "grep";

export interface FileOperationLogEntry {
  timestamp: string;
  sessionId: string;
  type: FileOperationType;
  path: string;
  targetPath?: string; // For move operations
  size?: number;       // Size in bytes for read/write
  pattern?: string;    // For glob/grep operations
  success: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * Log a file operation to the conversation archive
 */
export async function logFileOperation(
  type: FileOperationType,
  filePath: string,
  options: {
    targetPath?: string;
    size?: number;
    pattern?: string;
    success?: boolean;
    error?: string;
    durationMs?: number;
  } = {}
): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) {
    log("Failed to log file operation: No active session");
    return;
  }

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `conversation-${dateStr}-${sessionId}.json`;
  const filePath_absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

  const logEntry: FileOperationLogEntry = {
    timestamp,
    sessionId,
    type,
    path: filePath_absolute,
    targetPath: options.targetPath,
    size: options.size,
    pattern: options.pattern,
    success: options.success !== false, // Default to true if not specified
    error: options.error,
    durationMs: options.durationMs,
  };

  try {
    await fs.mkdir(LOGS_ROOT, { recursive: true });
    const logFilePath = path.join(LOGS_ROOT, filename);
    
    // Read existing log file or create new structure
    let logData: any;
    try {
      const fileContent = await fs.readFile(logFilePath, "utf8");
      logData = JSON.parse(fileContent);
    } catch (error) {
      // File doesn't exist or can't be parsed, create new log structure
      logData = {
        session: {
          timestamp: new Date().toISOString(),
          id: sessionId,
          instructions: "",
        },
        items: [],
        toolCalls: [],
        apiCalls: [],
        fileOperations: [],
      };
    }

    // Ensure fileOperations array exists
    if (!logData.fileOperations) {
      logData.fileOperations = [];
    }

    // Add the new file operation entry
    logData.fileOperations.push(logEntry);

    // Write updated log back to file
    await fs.writeFile(logFilePath, JSON.stringify(logData, null, 2), "utf8");
  } catch (error) {
    log(`Failed to log file operation: ${error}`);
  }
}

/**
 * Wrapper for fs.readFile that logs the operation
 */
export async function readFileWithLogging(
  filePath: string, 
  options?: { encoding?: BufferEncoding; flag?: string }
): Promise<string | Buffer> {
  const startTime = Date.now();
  let success = false;
  let error: Error | undefined;
  let content: string | Buffer;
  
  try {
    content = await fs.readFile(filePath, options);
    success = true;
    return content;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    const size = success && typeof content === "string" 
      ? Buffer.byteLength(content, "utf8") 
      : success && Buffer.isBuffer(content) 
        ? content.length 
        : undefined;
        
    logFileOperation("read", filePath, {
      size,
      success,
      error: error?.message,
      durationMs: duration
    }).catch(err => log(`Failed to log file read operation: ${err}`));
  }
}

/**
 * Wrapper for fs.writeFile that logs the operation
 */
export async function writeFileWithLogging(
  filePath: string,
  data: string | Buffer | Uint8Array,
  options?: fs.WriteFileOptions
): Promise<void> {
  const startTime = Date.now();
  let success = false;
  let error: Error | undefined;
  
  try {
    await fs.writeFile(filePath, data, options);
    success = true;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    const size = typeof data === "string" 
      ? Buffer.byteLength(data, "utf8") 
      : Buffer.isBuffer(data) || data instanceof Uint8Array 
        ? data.length 
        : undefined;
        
    logFileOperation("write", filePath, {
      size,
      success,
      error: error?.message,
      durationMs: duration
    }).catch(err => log(`Failed to log file write operation: ${err}`));
  }
}

/**
 * Wrapper for fs.appendFile that logs the operation
 */
export async function appendFileWithLogging(
  filePath: string,
  data: string | Uint8Array,
  options?: fs.WriteFileOptions
): Promise<void> {
  const startTime = Date.now();
  let success = false;
  let error: Error | undefined;
  
  try {
    await fs.appendFile(filePath, data, options);
    success = true;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    const size = typeof data === "string" 
      ? Buffer.byteLength(data, "utf8") 
      : data instanceof Uint8Array 
        ? data.length 
        : undefined;
        
    logFileOperation("append", filePath, {
      size,
      success,
      error: error?.message,
      durationMs: duration
    }).catch(err => log(`Failed to log file append operation: ${err}`));
  }
}

/**
 * Wrapper for fs.unlink that logs the operation
 */
export async function unlinkFileWithLogging(filePath: string): Promise<void> {
  const startTime = Date.now();
  let success = false;
  let error: Error | undefined;
  
  try {
    await fs.unlink(filePath);
    success = true;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    logFileOperation("delete", filePath, {
      success,
      error: error?.message,
      durationMs: duration
    }).catch(err => log(`Failed to log file delete operation: ${err}`));
  }
}

/**
 * Wrapper for fs.rename that logs the operation
 */
export async function renameFileWithLogging(oldPath: string, newPath: string): Promise<void> {
  const startTime = Date.now();
  let success = false;
  let error: Error | undefined;
  
  try {
    await fs.rename(oldPath, newPath);
    success = true;
  } catch (err) {
    error = err as Error;
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    logFileOperation("move", oldPath, {
      targetPath: newPath,
      success,
      error: error?.message,
      durationMs: duration
    }).catch(err => log(`Failed to log file move operation: ${err}`));
  }
}