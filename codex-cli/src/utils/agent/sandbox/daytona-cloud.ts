import type { ExecInput, ExecResult } from "./interface.js";
import type { SpawnOptions } from "child_process";

import { Daytona, DaytonaConfig, SandboxTargetRegion } from "@daytonaio/sdk";
import { log, isLoggingEnabled } from "../log.js";
import path from "path";
import os from "os";

// Class to handle all Daytona Cloud Sandbox operations
export class DaytonaSandboxProvider {
  private static instance: DaytonaSandboxProvider | null = null;
  private daytona: Daytona | null = null;
  private sandbox: any | null = null;
  private initialized: boolean = false;
  private pathMapping: Map<string, string> = new Map();
  private rootDir: string | null = null;
  private initPromise: Promise<void> | null = null;

  // Private constructor for singleton pattern
  private constructor() {}

  // Get singleton instance
  public static getInstance(): DaytonaSandboxProvider {
    if (!DaytonaSandboxProvider.instance) {
      DaytonaSandboxProvider.instance = new DaytonaSandboxProvider();
    }
    return DaytonaSandboxProvider.instance;
  }

  // Initialize the Daytona sandbox
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initializeInternal();
    return this.initPromise;
  }

  private async initializeInternal(): Promise<void> {
    if (isLoggingEnabled()) {
      log("[DaytonaSandbox] Initializing Daytona sandbox");
    }

    try {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) {
        throw new Error("DAYTONA_API_KEY environment variable not set");
      }

      const apiUrl = process.env.DAYTONA_API_URL || undefined;
      const target = process.env.DAYTONA_TARGET || SandboxTargetRegion.US;

      // Create Daytona SDK client
      this.daytona = new Daytona({
        apiKey,
        apiUrl,
        target: target as SandboxTargetRegion,
      });

      // Create sandbox without specifying language (will be deprecated)
      this.sandbox = await this.daytona.create({
        autoStopInterval: 30, // Default 30 minutes
      });

      if (!this.sandbox) {
        throw new Error("Failed to create Daytona sandbox");
      }

      // Get root directory for file operations
      this.rootDir = await this.sandbox.getUserRootDir();

      if (!this.rootDir) {
        throw new Error("Failed to get sandbox root directory");
      }

      this.initialized = true;

      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Initialized sandbox ID: ${this.sandbox.id}`);
        log(`[DaytonaSandbox] Root directory: ${this.rootDir}`);
      }

      // Set up workplace directory in background
      this.setupWorkspace().catch((err) => {
        log(`[DaytonaSandbox] Error setting up workspace: ${err.message}`);
      });
    } catch (error: any) {
      const message = error.message || String(error);
      log(`[DaytonaSandbox] Initialization error: ${message}`);
      throw error;
    }
  }

  // Map a local path to a remote path
  public mapPath(localPath: string): string {
    if (!this.initialized || !this.rootDir) {
      throw new Error("Daytona sandbox not initialized");
    }

    // Check if path is already mapped
    if (this.pathMapping.has(localPath)) {
      return this.pathMapping.get(localPath)!;
    }

    let remotePath: string;

    // Handle special case for simple filenames in apply_patch
    if (!path.isAbsolute(localPath) && !localPath.includes('/') && !localPath.includes('\\')) {
      // For simple filenames (like "hello.py"), place them in the user's home directory
      remotePath = path.join(this.rootDir, localPath);
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Simple filename mapped to home dir: ${localPath} -> ${remotePath}`);
      }
    } else if (path.isAbsolute(localPath)) {
      // For absolute paths, extract relevant parts by filtering out system directories
      const homeDir = os.homedir();
      
      // If path is inside home directory, map it accordingly
      if (localPath.startsWith(homeDir)) {
        const relativePath = path.relative(homeDir, localPath);
        remotePath = path.join(this.rootDir, relativePath);
      } else {
        // For other absolute paths, use the filename and preserve directory structure where possible
        const pathParts = localPath.split(path.sep).filter(p => p.length > 0);
        // Skip root and system directories, keep project-like directories
        const relevantParts = pathParts.slice(pathParts.findIndex(
          p => !['Users', 'home', 'usr', 'var', 'Library', 'System', 'Applications'].includes(p)
        ));
        
        remotePath = path.join(this.rootDir, ...relevantParts);
      }
    } else {
      // For relative paths (common with apply_patch)
      remotePath = path.join(this.rootDir, localPath);
    }

    // Cache the mapping
    this.pathMapping.set(localPath, remotePath);
    
    if (isLoggingEnabled()) {
      log(`[DaytonaSandbox] Mapped path: ${localPath} -> ${remotePath}`);
    }
    
    return remotePath;
  }

  // Setup workspace directory
  private async setupWorkspace(): Promise<void> {
    if (!this.initialized || !this.sandbox) {
      throw new Error("Daytona sandbox not initialized");
    }

    // Create common directories that might be needed
    const dirs = ['src', 'tests', 'docs', 'config'];
    
    for (const dir of dirs) {
      try {
        await this.sandbox.fs.createFolder(path.join(this.rootDir!, dir));
      } catch (error) {
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Warning: Failed to create directory ${dir}: ${error}`);
        }
      }
    }
  }

  // Execute a command in the sandbox
  public async exec(
    input: ExecInput,
    _opts: SpawnOptions,
    _abortSignal?: AbortSignal
  ): Promise<ExecResult> {
    if (!this.initialized || !this.sandbox) {
      await this.initialize();
    }

    const { cmd, workdir, timeoutInMillis } = input;
    
    if (isLoggingEnabled()) {
      log(`[DaytonaSandbox] Executing command: ${cmd.join(' ')}`);
      if (workdir) {
        log(`[DaytonaSandbox] Working directory: ${workdir}`);
      }
    }

    try {
      // Always default to user's home directory if no workdir specified
      // This ensures commands run in the same directory where files are created
      const remoteWorkdir = workdir ? this.mapPath(workdir) : this.rootDir;
      
      // Log the remote working directory for debugging
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Remote working directory: ${remoteWorkdir}`);
      }
      
      // For file operations like rm, ls, cat on a simple filename, make sure we look in the home dir
      let commandStr = cmd.join(' ');
      
      // Fix path for common file operations when simple filenames are used
      if (/^(rm|ls|cat|chmod|python|python3|head|tail)\s+([^\/\\\s\-]+)(\s|$)/.test(commandStr)) {
        const cmdParts = commandStr.split(' ');
        const command = cmdParts[0];
        const arg = cmdParts[1];
        
        // Only modify if the argument is a simple filename (not a path or option)
        if (arg && !arg.startsWith('-') && !arg.includes('/') && !arg.includes('\\')) {
          // Construct a full path to the user's home directory
          cmdParts[1] = path.join(this.rootDir!, arg);
          commandStr = cmdParts.join(' ');
          
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Modified command to use full path: ${commandStr}`);
          }
        }
      }
      
      // Execute the command
      // Add stderr redirection for commands that might not show output
      if (commandStr.includes('python3 --version') || commandStr.includes('python --version') || 
          commandStr.startsWith('which') || commandStr.includes('hello.py')) {
        // For commands that might not show output directly, redirect stderr to stdout
        commandStr = `${commandStr} 2>&1`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Added stderr redirection: ${commandStr}`);
        }
      }
      
      const response = await this.sandbox.process.executeCommand(
        commandStr,
        remoteWorkdir,
        undefined,
        timeoutInMillis ? Math.floor(timeoutInMillis / 1000) : undefined
      );
      
      // Log full response for debugging
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Command response: ${JSON.stringify(response)}`);
      }
      
      // Convert from Daytona response format to our ExecResult format
      return {
        stdout: response.result || '',
        stderr: response.stderr || '',
        exitCode: response.exitCode || 0
      };
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error executing command: ${error.message}`);
      }
      
      return {
        stdout: '',
        stderr: error.message || String(error),
        exitCode: 1
      };
    }
  }

  // Upload a file to the sandbox
  public async uploadFile(localPath: string, content: string): Promise<boolean> {
    if (!this.initialized || !this.sandbox) {
      await this.initialize();
    }

    const remotePath = this.mapPath(localPath);
    
    try {
      // Ensure parent directory exists
      const parentDir = path.dirname(remotePath);
      if (parentDir !== this.rootDir) {
        try {
          await this.sandbox.fs.createFolder(parentDir);
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Warning: Failed to create directory ${parentDir}: ${error}`);
          }
          // Continue anyway, createFolder might fail if directory already exists
        }
      }

      // Create file content object
      const fileContent = new File([content], path.basename(remotePath));
      
      // Upload the file
      await this.sandbox.fs.uploadFile(remotePath, fileContent);
      
      // Verify the file exists
      const verifyCmd = `test -f ${remotePath} && echo "exists" || echo "missing"`;
      const verifyResult = await this.sandbox.process.executeCommand(verifyCmd);
      
      if (verifyResult.result?.trim() !== "exists") {
        throw new Error(`Failed to verify file existence: ${remotePath}`);
      }
      
      return true;
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error uploading file ${localPath}: ${error.message}`);
      }
      return false;
    }
  }

  // Download a file from the sandbox
  public async downloadFile(remotePath: string): Promise<string> {
    if (!this.initialized || !this.sandbox) {
      await this.initialize();
    }

    try {
      // Check if file exists
      const checkCmd = `test -f ${remotePath} && echo "exists" || echo "missing"`;
      const checkResult = await this.sandbox.process.executeCommand(checkCmd);
      
      if (checkResult.result?.trim() !== "exists") {
        throw new Error(`File does not exist: ${remotePath}`);
      }
      
      // Use cat command to get file contents
      const catCmd = `cat ${remotePath}`;
      const catResult = await this.sandbox.process.executeCommand(catCmd);
      
      return catResult.result || '';
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error downloading file ${remotePath}: ${error.message}`);
      }
      return '';
    }
  }

  // Apply a patch to files
  public async applyPatch(patchText: string): Promise<ExecResult> {
    if (!this.initialized || !this.sandbox) {
      await this.initialize();
    }

    try {
      // Parse the patch text to extract file operations
      const lines = patchText.trim().split("\n");
      if (!lines[0]?.startsWith("*** Begin Patch") || lines[lines.length - 1] !== "*** End Patch") {
        throw new Error("Invalid patch format");
      }
      
      let currentFilePath = "";
      let currentFileContent = "";
      let addingFile = false;
      let successOutput = "";
      
      // Process the patch line by line
      for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i];
        
        if (line.startsWith("*** Add File: ")) {
          // Handle file addition
          if (addingFile) {
            // Save previous file if we were in the middle of adding one
            // Use mapPath to handle proper file path mapping
            const remotePath = this.mapPath(currentFilePath);
            const fileContent = new File([currentFileContent], path.basename(remotePath));
            await this.sandbox.fs.uploadFile(remotePath, fileContent);
            
            // Add file creation to output for proper display in terminal
            successOutput += `Created ${currentFilePath}\n`;
            currentFileContent = "";
          }
          
          currentFilePath = line.substring("*** Add File: ".length);
          addingFile = true;
        } else if (addingFile && line.startsWith("+")) {
          // Content line for file addition (strip the leading '+')
          currentFileContent += line.substring(1) + "\n";
        } else if (line.startsWith("*** End of File") || line.startsWith("*** Update File:") || line.startsWith("*** Delete File:")) {
          // Save the current file before moving to the next operation
          if (addingFile && currentFilePath) {
            // Use mapPath to handle proper file path mapping
            const remotePath = this.mapPath(currentFilePath);
            const fileContent = new File([currentFileContent], path.basename(remotePath));
            await this.sandbox.fs.uploadFile(remotePath, fileContent);
            
            // Add file creation to output for proper display in terminal
            successOutput += `Created ${currentFilePath}\n`;
            
            if (isLoggingEnabled()) {
              log(`[DaytonaSandbox] Created file: ${remotePath}`);
            }
            
            currentFilePath = "";
            currentFileContent = "";
            addingFile = false;
          }
          
          // Handle other operations as needed
          if (line.startsWith("*** Delete File: ")) {
            const fileToDelete = line.substring("*** Delete File: ".length);
            // Use mapPath to handle proper file path mapping
            const remotePath = this.mapPath(fileToDelete);
            await this.sandbox.fs.deleteFile(remotePath);
            
            // Add file deletion to output for proper display in terminal
            successOutput += `Deleted ${fileToDelete}\n`;
            
            if (isLoggingEnabled()) {
              log(`[DaytonaSandbox] Deleted file: ${remotePath}`);
            }
          }
        }
      }
      
      // Handle any remaining file operation
      if (addingFile && currentFilePath) {
        // Use mapPath to handle proper file path mapping
        const remotePath = this.mapPath(currentFilePath);
        const fileContent = new File([currentFileContent], path.basename(remotePath));
        await this.sandbox.fs.uploadFile(remotePath, fileContent);
        
        // Add file creation to output for proper display in terminal
        successOutput += `Created ${currentFilePath}\n`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Created file: ${remotePath}`);
        }
      }
      
      // Return simple output with file operations performed
      return {
        stdout: successOutput || "Patch applied successfully",
        stderr: "",
        exitCode: 0
      };
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error applying patch: ${error.message}`);
      }
      
      return {
        stdout: "",
        stderr: error.message || String(error),
        exitCode: 1
      };
    }
  }

  // Cleanup and release resources
  public async cleanup(): Promise<void> {
    if (!this.initialized || !this.daytona || !this.sandbox) {
      return;
    }

    try {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Cleaning up sandbox ${this.sandbox.id}`);
      }
      
      await this.daytona.remove(this.sandbox);
      
      // Clear state
      this.sandbox = null;
      this.initialized = false;
      this.pathMapping.clear();
      this.rootDir = null;
      this.initPromise = null;
      
      if (isLoggingEnabled()) {
        log('[DaytonaSandbox] Cleanup completed');
      }
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error during cleanup: ${error.message}`);
      }
    }
  }
}

// Export the exec function for Daytona sandbox
export function execWithDaytona(
  cmd: Array<string>,
  opts: SpawnOptions,
  writableRoots: Array<string>,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  const daytonaSandbox = DaytonaSandboxProvider.getInstance();
  return daytonaSandbox.exec({ cmd, workdir: opts.cwd as string | undefined, timeoutInMillis: opts.timeout as number | undefined }, opts, abortSignal);
}

// Register exit handlers to ensure proper cleanup
function registerExitHandlers(): void {
  const cleanup = async () => {
    try {
      const daytonaSandbox = DaytonaSandboxProvider.getInstance();
      await daytonaSandbox.cleanup();
    } catch (error) {
      // Silently ignore errors during exit
    } finally {
      process.exit(0);
    }
  };

  // Register handlers for clean exit
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Register exit handlers immediately
registerExitHandlers();