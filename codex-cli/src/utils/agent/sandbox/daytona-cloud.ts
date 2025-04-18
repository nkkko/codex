import type { ExecInput, ExecResult } from "./interface.js";
import type { SpawnOptions } from "child_process";

import { Daytona, DaytonaConfig, SandboxTargetRegion } from "@daytonaio/sdk";
import { log, isLoggingEnabled } from "../log.js";
import path from "path";
import os from "os";

/**
 * DaytonaSandboxProvider - responsible for managing Daytona Cloud sandbox operations
 * Implemented as a singleton to ensure only one sandbox instance per session
 */
export class DaytonaSandboxProvider {
  private static instance: DaytonaSandboxProvider | null = null;
  private daytona: Daytona | null = null;
  private sandbox: any | null = null;
  private initialized = false;
  private pathMapping = new Map<string, string>();
  private rootDir: string | null = null;
  private initPromise: Promise<void> | null = null;

  // Private constructor for singleton pattern
  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): DaytonaSandboxProvider {
    if (!DaytonaSandboxProvider.instance) {
      DaytonaSandboxProvider.instance = new DaytonaSandboxProvider();
    }
    return DaytonaSandboxProvider.instance;
  }

  /**
   * Initialize the Daytona sandbox
   * This sets up the connection to Daytona and creates a sandbox instance
   */
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

  /**
   * Internal implementation of initialization
   * Creates the Daytona client and sandbox instance
   */
  private async initializeInternal(): Promise<void> {
    if (isLoggingEnabled()) {
      log("[DaytonaSandbox] Initializing Daytona sandbox");
    }

    try {
      const apiKey = this.validateAPIKey();
      const apiUrl = process.env.DAYTONA_API_URL || undefined;
      const target = process.env.DAYTONA_TARGET || SandboxTargetRegion.US;

      // Create Daytona SDK client
      this.daytona = new Daytona({
        apiKey,
        apiUrl,
        target: target as SandboxTargetRegion,
      });

      // Create sandbox with configurable auto-stop interval (default 30 minutes)
      const autoStopInterval = process.env.DAYTONA_AUTO_STOP_INTERVAL 
        ? parseInt(process.env.DAYTONA_AUTO_STOP_INTERVAL, 10) 
        : 30;
        
      this.sandbox = await this.daytona.create({
        autoStopInterval,
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

  /**
   * Validates that the API key is available and has a reasonable format
   * @returns The validated API key
   * @throws Error if the API key is missing or invalid
   */
  private validateAPIKey(): string {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error("DAYTONA_API_KEY environment variable not set");
    }
    
    // Simple validation to ensure the API key has a reasonable format
    if (!apiKey.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      throw new Error("DAYTONA_API_KEY has invalid format - check your configuration");
    }
    
    return apiKey;
  }

  /**
   * Maps a local filesystem path to the corresponding path in the Daytona sandbox
   * @param localPath - The local path to be mapped
   * @returns The corresponding path in the Daytona sandbox
   */
  public mapPath(localPath: string): string {
    if (!this.initialized || !this.rootDir) {
      throw new Error("Daytona sandbox not initialized");
    }

    // Check if path is already mapped
    if (this.pathMapping.has(localPath)) {
      return this.pathMapping.get(localPath)!;
    }

    const remotePath = this.calculateRemotePath(localPath);
    
    // Cache the mapping
    this.pathMapping.set(localPath, remotePath);
    
    if (isLoggingEnabled()) {
      log(`[DaytonaSandbox] Mapped path: ${localPath} -> ${remotePath}`);
    }
    
    return remotePath;
  }

  /**
   * Calculates the appropriate remote path based on the local path characteristics
   * @param localPath - The local path to map
   * @returns The corresponding remote path in the sandbox
   */
  private calculateRemotePath(localPath: string): string {
    // Handle simple filenames (like "hello.py")
    if (!path.isAbsolute(localPath) && !localPath.includes('/') && !localPath.includes('\\')) {
      const remotePath = path.join(this.rootDir!, localPath);
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Simple filename mapped to home dir: ${localPath} -> ${remotePath}`);
      }
      
      return remotePath;
    } 
    
    // Handle absolute paths
    if (path.isAbsolute(localPath)) {
      const homeDir = os.homedir();
      
      // If path is inside home directory, map it accordingly
      if (localPath.startsWith(homeDir)) {
        const relativePath = path.relative(homeDir, localPath);
        return path.join(this.rootDir!, relativePath);
      } 
      
      // For other absolute paths, special handling
      const pathParts = localPath.split(path.sep).filter(p => p.length > 0);
      
      // Special handling for Daytona's own directories
      if (localPath.includes('/home/daytona')) {
        // If it's already a path in Daytona's directories, use it directly
        return localPath;
      }
      
      // Skip root and system directories
      const relevantParts = pathParts.slice(pathParts.findIndex(p => !this.isSystemDirectory(p, pathParts)));
      return path.join(this.rootDir!, ...relevantParts);
    }
    
    // For relative paths (common with apply_patch)
    return path.join(this.rootDir!, localPath);
  }

  /**
   * Determines if a path component is a system directory that should be skipped in path mapping
   * @param component - The path component to check
   * @param allParts - All parts of the full path
   * @returns true if this is a system directory to skip
   */
  private isSystemDirectory(component: string, allParts: string[]): boolean {
    // Don't skip 'home' if 'daytona' is present in the path
    if (component === 'home' && allParts.includes('daytona')) {
      return false;
    }
    
    // Standard system directories to skip
    return ['Users', 'usr', 'var', 'Library', 'System', 'Applications'].includes(component);
  }

  /**
   * Sets up common directory structure in the sandbox
   */
  private async setupWorkspace(): Promise<void> {
    if (!this.initialized || !this.sandbox) {
      throw new Error("Daytona sandbox not initialized");
    }

    // Create common directories that might be needed
    const commonDirectories = ['src', 'tests', 'docs', 'config'];
    
    const createDirPromises = commonDirectories.map(async (dir) => {
      try {
        await this.sandbox!.fs.createFolder(path.join(this.rootDir!, dir));
      } catch (error) {
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Warning: Failed to create directory ${dir}: ${error}`);
        }
      }
    });
    
    await Promise.allSettled(createDirPromises);
  }

  // Store session IDs for reuse
  private sessionMap = new Map<string, string>();
  private defaultSessionId = 'default-exec-session';

  /**
   * Execute a command in the sandbox using sessions for proper context
   * @param input - Command and execution parameters
   * @param _opts - Spawn options (not used directly, but maintained for interface compatibility)
   * @param _abortSignal - Signal to abort the command execution
   * @returns The execution result
   */
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
      // Ensure Daytona home directory exists if needed
      await this.ensureDaytonaHomeDirectory(cmd);
      
      // Re-initialize if needed (can happen if sandbox expired or connection was lost)
      if (!this.initialized || !this.sandbox) {
        if (isLoggingEnabled()) {
          log("[DaytonaSandbox] Re-initializing sandbox before command execution");
        }
        await this.initialize();
      }
      
      // Always default to user's home directory if no workdir specified
      const remoteWorkdir = workdir ? this.mapPath(workdir) : this.rootDir;
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Remote working directory: ${remoteWorkdir}`);
      }
      
      // Prepare the command with proper path handling
      let commandStr = this.prepareCommand(cmd);
      
      // Add cd to working directory if specified
      if (remoteWorkdir) {
        commandStr = `cd ${remoteWorkdir} && ${commandStr}`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Added working directory to command: ${commandStr}`);
        }
      }
      
      // Get or create a session ID for this command
      // Use a different session ID for workdir to maintain separate contexts
      const sessionKey = workdir || 'default';
      let sessionId = this.sessionMap.get(sessionKey);
      
      if (!sessionId) {
        sessionId = `exec-session-${sessionKey.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;
        this.sessionMap.set(sessionKey, sessionId);
        
        // Create a new session
        try {
          await this.sandbox.process.createSession(sessionId);
          
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Created new session: ${sessionId}`);
          }
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Error creating session: ${error}, using default session`);
          }
          // Fallback to default session
          sessionId = this.defaultSessionId;
          
          // Make sure default session exists
          try {
            await this.sandbox.process.createSession(sessionId);
          } catch (e) {
            // Ignore errors if session already exists
          }
        }
      }
      
      // Execute command in the session
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Executing command in session ${sessionId}: ${commandStr}`);
      }
      
      // Execute using session command with timeout if specified
      const sessionRequest = {
        command: commandStr,
        async: false,
        timeout: timeoutInMillis ? Math.floor(timeoutInMillis / 1000) : undefined
      };
      
      const cmdResponse = await this.sandbox.process.executeSessionCommand(
        sessionId,
        sessionRequest
      );
      
      let response = {
        result: cmdResponse.output || '',
        stderr: cmdResponse.error || '',
        exitCode: cmdResponse.exitCode || 0
      };
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Command response: ${JSON.stringify(response)}`);
      }
      
      // Get logs if needed to complete the output
      if (!response.result && cmdResponse.cmdId) {
        try {
          const logs = await this.getSessionCommandLogs(sessionId, cmdResponse.cmdId);
          response.result = logs;
          
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Retrieved logs for command: ${logs.substring(0, 100)}...`);
          }
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Error retrieving logs: ${error}`);
          }
        }
      }
      
      // Process response and add preview links for web servers if appropriate
      const processedResponse = this.processCommandResponse(response, commandStr);
      
      return processedResponse;
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
  
  /**
   * Retrieves logs for a command execution in a session
   * @param sessionId - The session ID
   * @param cmdId - The command ID
   * @returns The command logs as a string
   */
  private async getSessionCommandLogs(sessionId: string, cmdId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        let logs = '';
        
        // Use the log streaming method from Daytona SDK
        this.sandbox!.process.getSessionCommandLogs(
          sessionId,
          cmdId,
          // Callback function to accumulate logs
          (chunk: string) => {
            logs += chunk;
          }
        ).then(() => {
          resolve(logs);
        }).catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Ensures the /home/daytona directory exists if referenced in commands
   * @param cmd - The command to check for references to /home/daytona
   */
  private async ensureDaytonaHomeDirectory(cmd: string[]): Promise<void> {
    if (!cmd.some(arg => arg.includes('/home/daytona'))) {
      return;
    }
    
    try {
      // Check if directory exists
      const checkCmd = `test -d /home/daytona && echo "exists" || echo "missing"`;
      const checkResult = await this.sandbox!.process.executeCommand(checkCmd);
      
      if (checkResult.result?.trim() !== "exists") {
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Creating missing /home/daytona directory`);
        }
        
        try {
          await this.sandbox!.fs.createFolder('/home/daytona');
        } catch (innerErr) {
          // If API fails, try using mkdir command directly
          await this.sandbox!.process.executeCommand('mkdir -p /home/daytona');
        }
      }
    } catch (err) {
      // Log but continue - we'll let the command execution handle any remaining issues
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error checking/creating /home/daytona: ${err}`);
      }
    }
  }

  /**
   * Prepares a command string with proper path handling and shell wrapping as needed
   * @param cmd - The command array to prepare
   * @returns The prepared command string
   */
  private prepareCommand(cmd: string[]): string {
    let commandStr = cmd.join(' ');
    
    // Fix path for common file operations when simple filenames are used
    commandStr = this.fixSimpleFilenamePaths(commandStr);
    
    // Apply command-specific fixes and shell wrapping
    commandStr = this.applyCommandSpecificFixes(commandStr);
    
    return commandStr;
  }

  /**
   * Fixes paths for commands that operate on simple filenames
   * @param commandStr - The original command string
   * @returns The command string with fixed paths
   */
  private fixSimpleFilenamePaths(commandStr: string): string {
    const simpleFileCommandRegex = /^(rm|ls|cat|chmod|python|python3|head|tail|mkdir)\s+([^\/\\\s\-]+)(\s|$)/;
    const match = commandStr.match(simpleFileCommandRegex);
    
    if (match) {
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
    
    return commandStr;
  }

  /**
   * Applies special fixes for specific command types and wraps in shell if needed
   * @param commandStr - The command string to process
   * @returns The processed command string
   */
  private applyCommandSpecificFixes(commandStr: string): string {
    // Determine if command needs shell wrapping
    if (this.needsShellWrapping(commandStr) && !commandStr.startsWith('/bin/sh -c')) {
      const escapedCmd = commandStr.replace(/'/g, "'\\''");
      commandStr = `/bin/sh -c '${escapedCmd}'`;
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Wrapping command with shell: ${commandStr}`);
      }
    }
    
    // Apply special fixes for specific command types
    commandStr = this.fixPythonCommand(commandStr);
    commandStr = this.fixTimeoutCommand(commandStr);
    commandStr = this.fixSleepCommand(commandStr);
    commandStr = this.fixNohupCommand(commandStr);
    commandStr = this.fixFlaskCommand(commandStr);
    
    return commandStr;
  }

  /**
   * Determines if a command needs shell wrapping for proper execution
   * @param commandStr - The command string to check
   * @returns True if the command should be wrapped in a shell
   */
  private needsShellWrapping(commandStr: string): boolean {
    return (
      // Shell operators
      commandStr.includes(' > ') || 
      commandStr.includes(' | ') || 
      commandStr.includes(' && ') || 
      commandStr.includes(' ; ') || 
      commandStr.includes(' & ') ||
      // Special commands
      commandStr.includes('nohup ') ||
      // Commands with quotes or special characters
      commandStr.includes('"') ||
      commandStr.includes("'") || 
      commandStr.includes('`') ||
      commandStr.includes('$') ||
      // Python commands with arguments that need proper parsing
      (commandStr.startsWith('python') && (commandStr.includes('-c') || commandStr.includes('-m'))) ||
      (commandStr.startsWith('python3') && (commandStr.includes('-c') || commandStr.includes('-m'))) ||
      // Other commands that typically need shell interpretation
      commandStr.includes('echo') ||
      commandStr.includes('which') ||
      commandStr.includes('find') ||
      commandStr.includes('grep')
    );
  }

  /**
   * Applies specific fixes for Python commands
   * @param commandStr - The command string to fix
   * @returns The fixed command string
   */
  private fixPythonCommand(commandStr: string): string {
    if ((commandStr.includes('python -c') || commandStr.includes('python3 -c')) && 
        !commandStr.startsWith('/bin/sh -c')) {
      // Extract the Python code part
      const match = commandStr.match(/python3?\s+-c\s+['"](.+)['"]/);
      if (match) {
        const pythonCode = match[1];
        // Escape single quotes in the Python code
        const escapedCode = pythonCode.replace(/'/g, "'\\''");
        // Construct a properly quoted command
        commandStr = `/bin/sh -c 'python3 -c "${escapedCode}"'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Fixed Python -c command: ${commandStr}`);
        }
      }
    }
    
    return commandStr;
  }

  /**
   * Applies fixes for timeout command which doesn't work in Daytona
   * @param commandStr - The command string to fix
   * @returns The fixed command string
   */
  private fixTimeoutCommand(commandStr: string): string {
    if (commandStr.startsWith('timeout ') && !commandStr.startsWith('/bin/sh -c')) {
      // Extract the command being run after timeout
      const match = commandStr.match(/timeout\s+(?:-t\s+)?(\d+)\s+(.*)/);
      if (match) {
        const seconds = parseInt(match[1], 10);
        const actualCommand = match[2];
        
        // Replace with a background process that we kill after the timeout
        commandStr = `/bin/sh -c '${actualCommand} & pid=$!; sleep ${seconds}; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Replaced timeout command: ${commandStr}`);
        }
      }
    }
    
    return commandStr;
  }

  /**
   * Applies fixes for sleep command
   * @param commandStr - The command string to fix
   * @returns The fixed command string
   */
  private fixSleepCommand(commandStr: string): string {
    if (commandStr.startsWith('sleep ') && !commandStr.includes(' && ') && !commandStr.startsWith('/bin/sh -c')) {
      // Make sure sleep is properly formatted
      const match = commandStr.match(/sleep\s+(\d+)/);
      if (match) {
        const seconds = match[1];
        commandStr = `/bin/sh -c 'sleep ${seconds}'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Fixed sleep command: ${commandStr}`);
        }
      }
    }
    
    return commandStr;
  }

  /**
   * Applies fixes for nohup command
   * @param commandStr - The command string to fix
   * @returns The fixed command string
   */
  private fixNohupCommand(commandStr: string): string {
    if (commandStr.startsWith('nohup ') && !commandStr.startsWith('/bin/sh -c')) {
      // Extract the actual command after nohup
      const nohupCmd = commandStr.substring('nohup '.length);
      // Wrap in shell to ensure proper interpretation
      commandStr = `/bin/sh -c 'nohup ${nohupCmd.replace(/'/g, "'\\''")}'`;
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Fixed nohup command: ${commandStr}`);
      }
    }
    
    return commandStr;
  }

  /**
   * Applies special handling for Flask applications
   * @param commandStr - The command string to fix
   * @returns The fixed command string
   */
  private fixFlaskCommand(commandStr: string): string {
    if ((commandStr.includes('flask run') || 
        (commandStr.includes('python') && commandStr.includes('app.py'))) &&
        !commandStr.startsWith('/bin/sh -c')) {
      
      // Check if app is meant to be run in background
      const runInBackground = !commandStr.includes(' -w ') && !commandStr.includes(' --no-background');
      
      if (runInBackground && !commandStr.includes(' & ')) {
        // Let Flask app run in background and capture its PID
        // Use nohup to ensure it keeps running even if the connection is lost
        commandStr = `/bin/sh -c 'cd $(dirname ${commandStr.split(' ').pop()?.replace(/'/g, "'\\''")}); nohup ${commandStr.replace(/'/g, "'\\''")} > flask.log 2>&1 & echo "Flask app started with PID: $!"'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Modified Flask command to run in background: ${commandStr}`);
        }
      }
    }
    
    return commandStr;
  }

  /**
   * Processes command response and adds preview links for web servers
   * @param response - The raw command response from Daytona
   * @param commandStr - The command string that was executed
   * @returns The processed execution result
   */
  private processCommandResponse(response: any, commandStr: string): ExecResult {
    let stdout = response.result || '';
    
    // Debug the response content
    if (isLoggingEnabled()) {
      log(`[DaytonaSandbox] Processing command response for: ${commandStr}`);
      log(`[DaytonaSandbox] Raw stdout: ${stdout.substring(0, 100)}...`);
    }
    
    // Check if this is a directory listing command
    if (this.isDirectoryListCommand(commandStr)) {
      // Try to ensure directory listing is properly handled
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Detected directory listing command: ${commandStr}`);
      }
      
      // Let output pass through as is since we should have handled the directory context correctly
    }
    
    // Check if this command runs a web server
    if (this.isWebServerCommand(commandStr)) {
      const port = this.detectServerPort(stdout, commandStr);
      const serverType = this.determineServerType(commandStr);
      
      if (port) {
        try {
          // Add preview link information
          stdout = this.addPreviewLink(stdout, port, serverType);
          response.stderr = `PREVIEW LINK: ${this.getPreviewLink(port).url}`;
        } catch (err) {
          // Add fallback local access message
          stdout = this.addLocalAccessInfo(stdout, port, serverType, String(err));
          response.stderr = `LOCAL ACCESS: http://127.0.0.1:${port}/`;
        }
      }
    }
    
    // Convert from Daytona response format to our ExecResult format
    return {
      stdout: stdout,
      stderr: response.stderr || '',
      exitCode: response.exitCode || 0
    };
  }
  
  /**
   * Determines if a command is a directory listing command
   * @param commandStr - The command string
   * @returns True if this is a directory listing command
   */
  private isDirectoryListCommand(commandStr: string): boolean {
    // Match common directory listing commands
    return (
      commandStr.startsWith('ls ') || 
      commandStr === 'ls' || 
      commandStr.startsWith('dir ') || 
      commandStr === 'dir' || 
      commandStr.startsWith('find ') ||
      commandStr.includes(' -la') ||
      commandStr.includes(' -l ')
    );
  }

  /**
   * Determines if a command is likely to start a web server
   * @param commandStr - The command string
   * @returns True if this command is likely to start a web server
   */
  private isWebServerCommand(commandStr: string): boolean {
    return (
      // Flask
      commandStr.includes('flask run') || 
      (commandStr.includes('python') && commandStr.includes('app.py')) ||
      // Node.js
      commandStr.includes('node ') || 
      commandStr.includes('npm start') || 
      commandStr.includes('npm run dev') ||
      commandStr.includes('npx') ||
      // Ruby/Rails
      commandStr.includes('rails server') || 
      commandStr.includes('rails s') ||
      // Generic server indicators
      commandStr.includes('server') || 
      commandStr.includes('serve') ||
      // Common server frameworks
      commandStr.includes('express') ||
      commandStr.includes('http-server') ||
      commandStr.includes('live-server')
    );
  }

  /**
   * Detects the port used by a web server from command output
   * @param stdout - Command standard output
   * @param commandStr - The command string
   * @returns The detected port number, or a default port based on server type
   */
  private detectServerPort(stdout: string, commandStr: string): number {
    // Flask pattern: "Running on http://127.0.0.1:5000"
    const flaskMatch = stdout.match(/Running on http:\/\/.*?:(\d+)/);
    if (flaskMatch) {
      return parseInt(flaskMatch[1], 10);
    }
    
    // Node.js patterns: "listening on port 3000" or "started server on 0.0.0.0:3000"
    const nodeMatch = stdout.match(/(?:listening|started|running|server).+?(?:port|:)\s*(\d+)/i);
    if (nodeMatch) {
      return parseInt(nodeMatch[1], 10);
    }
    
    // Check for port in command directly
    const portFlagMatch = commandStr.match(/--port[= ](\d+)|-p\s+(\d+)/);
    if (portFlagMatch) {
      return parseInt(portFlagMatch[1] || portFlagMatch[2], 10);
    }
    
    // Default ports based on server type
    if (commandStr.includes('flask') || (commandStr.includes('python') && commandStr.includes('app.py'))) {
      return 5000; // Default Flask port
    } else if (commandStr.includes('rails')) {
      return 3000; // Default Rails port
    } else if (commandStr.includes('next') || commandStr.includes('vite')) {
      return 3000; // Default Next.js/Vite port
    }
    
    return 8000; // Generic default
  }

  /**
   * Determines the type of web server being run
   * @param commandStr - The command string
   * @returns A descriptive string for the server type
   */
  private determineServerType(commandStr: string): string {
    if (commandStr.includes('flask') || (commandStr.includes('python') && commandStr.includes('app.py'))) {
      return "Flask server";
    } else if (commandStr.includes('node') || commandStr.includes('npm') || commandStr.includes('npx')) {
      return "Node.js server";
    } else if (commandStr.includes('rails')) {
      return "Rails server";
    }
    
    return "Web server";
  }

  /**
   * Adds preview link information to command output
   * @param stdout - Original standard output
   * @param port - The server port number
   * @param serverType - Description of the server type
   * @returns The modified standard output with preview link
   */
  private addPreviewLink(stdout: string, port: number, serverType: string): string {
    const previewInfo = this.getPreviewLink(port);
    
    return stdout + `\n\n====== PREVIEW LINK ======\n` +
           `${previewInfo.url}\n` +
           `=========================\n\n` +
           `${serverType} is running and accessible at the URL above.\n` +
           `(You may need authentication token: ${previewInfo.token})\n`;
  }

  /**
   * Adds local access information when preview link generation fails
   * @param stdout - Original standard output
   * @param port - The server port number
   * @param serverType - Description of the server type
   * @param errorMessage - The error message from preview link generation
   * @returns The modified standard output with local access info
   */
  private addLocalAccessInfo(stdout: string, port: number, serverType: string, errorMessage: string): string {
    return stdout + `\n\n====== LOCAL ACCESS ======\n` +
           `http://127.0.0.1:${port}/\n` +
           `=========================\n\n` +
           `${serverType} is running locally.\n` + 
           `Unable to generate preview link: ${errorMessage}`;
  }

  /**
   * Upload a file to the sandbox
   * @param localPath - Path on the local filesystem
   * @param content - Content to write to the file
   * @returns True if upload was successful, false otherwise
   */
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

  /**
   * Download a file from the sandbox
   * @param remotePath - Path in the sandbox
   * @returns Content of the file as a string
   */
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
  
  /**
   * Generate a preview link for a port
   * @param port - The port number to generate a preview link for
   * @returns An object containing the preview link URL and authentication token
   */
  public getPreviewLink(port: number): { url: string; token: string } {
    if (!this.initialized || !this.sandbox) {
      throw new Error("Daytona sandbox not initialized");
    }
    
    try {
      // Try official SDK method first
      if (typeof this.sandbox.getPreviewLink === 'function') {
        const previewInfo = this.sandbox.getPreviewLink(port);
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Generated preview link for port ${port} using SDK method`);
        }
        
        return {
          url: previewInfo.url,
          token: previewInfo.token
        };
      } 
      
      // Fallback method - generate URL based on sandbox ID format
      if (!this.sandbox.id) {
        throw new Error("Sandbox ID not available");
      }
      
      const sandboxId = this.sandbox.id;
      const nodeId = sandboxId.substring(0, 6);
      const previewUrl = `https://${port}-${sandboxId}.${nodeId}.daytona.work`;
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Generated preview link for port ${port} using fallback method: ${previewUrl}`);
      }
      
      return {
        url: previewUrl,
        token: 'auth-required' // This is a placeholder in fallback mode
      };
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error generating preview link: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Apply a patch to files
   * @param patchText - The patch text to apply
   * @returns Execution result with status of patch application
   */
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
      
      const result = await this.processPatches(lines);
      
      return {
        stdout: result.successOutput || "Patch applied successfully",
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

  /**
   * Process patches line by line
   * @param lines - The lines of the patch file
   * @returns Object containing output message of the patch operation
   */
  private async processPatches(lines: string[]): Promise<{ successOutput: string }> {
    let currentFilePath = "";
    let currentFileContent = "";
    let addingFile = false;
    let successOutput = "";
    
    // Process the patch line by line (skipping first and last lines)
    for (let i = 1; i < lines.length - 1; i++) {
      const line = lines[i];
      
      if (line.startsWith("*** Add File: ")) {
        // Handle start of a file addition
        if (addingFile && currentFilePath) {
          // Save any previous file we were in the middle of processing
          await this.saveAddedFile(currentFilePath, currentFileContent, successOutput);
          currentFileContent = "";
        }
        
        currentFilePath = line.substring("*** Add File: ".length);
        addingFile = true;
      } else if (addingFile && line.startsWith("+")) {
        // Content line for file addition (strip the leading '+')
        currentFileContent += line.substring(1) + "\n";
      } else if (line.startsWith("*** End of File") || line.startsWith("*** Update File:") || line.startsWith("*** Delete File:")) {
        // Handle end of current file or transition to a different operation
        if (addingFile && currentFilePath) {
          successOutput = await this.saveAddedFile(currentFilePath, currentFileContent, successOutput);
          currentFilePath = "";
          currentFileContent = "";
          addingFile = false;
        }
        
        // Handle file deletion if needed
        if (line.startsWith("*** Delete File: ")) {
          const fileToDelete = line.substring("*** Delete File: ".length);
          successOutput = await this.deleteFile(fileToDelete, successOutput);
        }
      }
    }
    
    // Handle any remaining file operation at the end
    if (addingFile && currentFilePath) {
      successOutput = await this.saveAddedFile(currentFilePath, currentFileContent, successOutput);
    }
    
    return { successOutput };
  }

  /**
   * Saves an added file from a patch
   * @param filePath - Path of the file to add
   * @param content - Content of the file
   * @param currentOutput - Current success output string
   * @returns Updated success output string
   */
  private async saveAddedFile(filePath: string, content: string, currentOutput: string): Promise<string> {
    try {
      // Use mapPath to handle proper file path mapping
      const remotePath = this.mapPath(filePath);
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Creating file: ${remotePath} with ${content.length} bytes`);
      }
      
      // Ensure parent directory exists
      const dirPath = path.dirname(remotePath);
      try {
        await this.sandbox!.fs.createFolder(dirPath);
      } catch (dirErr) {
        // Ignore directory creation errors as it might already exist
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Directory creation note: ${String(dirErr)}`);
        }
      }
      
      // Create the file using the Daytona API
      const fileContent = new File([content], path.basename(remotePath));
      await this.sandbox!.fs.uploadFile(remotePath, fileContent);
      
      // Verify the file exists
      const checkCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
      const checkResult = await this.sandbox!.process.executeCommand(checkCmd);
      
      if (checkResult.result?.trim() === "exists") {
        // Add file creation to output for proper display in terminal
        currentOutput += `Created ${filePath}\n`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Successfully created file: ${remotePath}`);
        }
      } else {
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] File verification failed for: ${remotePath}, trying echo fallback`);
        }
        
        // Fall back to using echo with redirect for file creation
        const echoCmd = `echo '${content.replace(/'/g, "'\\''")}' > "${remotePath}"`;
        await this.sandbox!.process.executeCommand(echoCmd);
        
        currentOutput += `Created ${filePath} (using echo fallback)\n`;
      }
    } catch (fileErr) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error creating file ${filePath}: ${String(fileErr)}`);
      }
      currentOutput += `Error creating ${filePath}: ${String(fileErr)}\n`;
    }
    
    return currentOutput;
  }

  /**
   * Deletes a file as part of a patch operation
   * @param filePath - Path of the file to delete
   * @param currentOutput - Current success output string
   * @returns Updated success output string
   */
  private async deleteFile(filePath: string, currentOutput: string): Promise<string> {
    try {
      // Use mapPath to handle proper file path mapping
      const remotePath = this.mapPath(filePath);
      await this.sandbox!.fs.deleteFile(remotePath);
      
      // Add file deletion to output for proper display in terminal
      currentOutput += `Deleted ${filePath}\n`;
      
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Deleted file: ${remotePath}`);
      }
    } catch (delErr) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error deleting file ${filePath}: ${String(delErr)}`);
      }
      currentOutput += `Error deleting ${filePath}: ${String(delErr)}\n`;
    }
    
    return currentOutput;
  }

  /**
   * Cleanup and release resources
   * Removes the sandbox instance and clears state
   */
  public async cleanup(): Promise<void> {
    if (!this.initialized || !this.daytona || !this.sandbox) {
      return;
    }

    try {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Cleaning up sandbox ${this.sandbox.id}`);
      }
      
      // Clean up all sessions before removing the sandbox
      for (const [_, sessionId] of this.sessionMap) {
        try {
          await this.sandbox.process.deleteSession(sessionId);
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Deleted session: ${sessionId}`);
          }
        } catch (error) {
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Error deleting session ${sessionId}: ${error}`);
          }
          // Continue with other sessions even if one fails
        }
      }
      
      await this.daytona.remove(this.sandbox);
      
      // Clear state
      this.sandbox = null;
      this.initialized = false;
      this.pathMapping.clear();
      this.rootDir = null;
      this.initPromise = null;
      this.sessionMap.clear();
      
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

/**
 * Helper function to execute commands in a Daytona sandbox
 * @param cmd - Command array to execute
 * @param opts - Spawn options
 * @param writableRoots - Array of writable root directories (not used directly in this implementation)
 * @param abortSignal - Signal to abort the command execution
 * @returns The execution result
 */
export function execWithDaytona(
  cmd: Array<string>,
  opts: SpawnOptions,
  writableRoots: Array<string>,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  const daytonaSandbox = DaytonaSandboxProvider.getInstance();
  return daytonaSandbox.exec(
    { 
      cmd, 
      workdir: opts.cwd as string | undefined, 
      timeoutInMillis: opts.timeout as number | undefined 
    }, 
    opts, 
    abortSignal
  );
}

/**
 * Register exit handlers to ensure proper cleanup when the process exits
 */
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