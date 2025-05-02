import type { ExecResult } from "./interface.js";
import type { SpawnOptions } from "child_process";

import { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import { log, isLoggingEnabled } from "../log.js";
import * as path from "path";
import { Buffer } from "buffer";

// Global singleton instance of the Daytona sandbox provider
let globalDaytonaSandboxInstance: DaytonaSandboxProvider | null = null;

/**
 * Daytona Cloud Sandbox implementation
 * Provides a secure, cloud-based execution environment with full Linux capabilities.
 */
export class DaytonaSandboxProvider {
  private daytona: Daytona;
  private sandbox: DaytonaSandbox | null = null;
  private workspaceDir: string = "";
  private userRootDir: string = "";
  private initialized: boolean = false;
  private initializing: boolean = false;
  private localToRemotePaths: Map<string, string> = new Map();
  private apiKey: string;
  private initializePromise: Promise<void> | null = null;

  /**
   * Get the global singleton instance of DaytonaSandboxProvider
   */
  public static getInstance(apiKey: string): DaytonaSandboxProvider {
    if (!globalDaytonaSandboxInstance) {
      console.error(`[Daytona] Creating new Daytona sandbox instance`);
      globalDaytonaSandboxInstance = new DaytonaSandboxProvider(apiKey);
      
      // Register cleanup handlers
      process.on('exit', () => {
        console.error('[Daytona] Process exiting, cleaning up sandbox');
        if (globalDaytonaSandboxInstance) {
          try {
            // Synchronous cleanup since we're in exit handler
            globalDaytonaSandboxInstance.cleanupSync();
          } catch (err) {
            console.error(`[Daytona] Error during exit cleanup: ${err}`);
          }
        }
      });
      
      // Handle SIGINT (Ctrl+C)
      process.on('SIGINT', () => {
        console.error('[Daytona] SIGINT received, cleaning up sandbox');
        if (globalDaytonaSandboxInstance) {
          globalDaytonaSandboxInstance.cleanup()
            .then(() => {
              console.error('[Daytona] Sandbox cleanup completed');
              // process.exit will be called by the main CLI
            })
            .catch(err => {
              console.error(`[Daytona] Error during SIGINT cleanup: ${err}`);
              // process.exit will be called by the main CLI
            });
        }
      });
    }
    
    return globalDaytonaSandboxInstance;
  }

  /**
   * Private constructor - use getInstance() instead
   */
  private constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("DAYTONA_API_KEY is required for Daytona sandbox");
    }
    this.apiKey = apiKey;
    this.daytona = new Daytona({ apiKey });
    
    // Don't auto-initialize in constructor
    console.error(`[Daytona] Daytona sandbox provider created`);
  }

  /**
   * Initialize the Daytona sandbox. Must be called before any operations.
   */
  public async initialize(): Promise<void> {
    // If already initialized, just return immediately
    if (this.initialized) return;
    
    // If initialization is in progress, wait for it with a timeout
    if (this.initializing && this.initializePromise) {
      console.error("[Daytona] Initialization already in progress, waiting with timeout...");
      
      try {
        // Add a timeout to prevent hanging forever
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Initialization timeout after 10 seconds"));
          }, 10000); // 10 second timeout
        });
        
        // Race the timeout against the initialization
        await Promise.race([this.initializePromise, timeoutPromise]);
        return;
      } catch (error) {
        console.error(`[Daytona] Initialization timeout or error: ${error}`);
        this.initializing = false;
        this.initializePromise = null;
        // Continue with a new initialization attempt
      }
    }
    
    // Set flag to prevent multiple initializations
    this.initializing = true;
    
    // Create promise for other callers to wait on, with a timeout
    try {
      this.initializePromise = Promise.race([
        this._initialize(), 
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Initialization timeout after 20 seconds"));
          }, 20000); // 20 second timeout
        })
      ]);
      
      await this.initializePromise;
    } catch (error) {
      console.error(`[Daytona] Initialization failed with timeout or error: ${error}`);
      this.initialized = false;
      throw error;
    } finally {
      this.initializing = false;
      this.initializePromise = null;
    }
  }
  
  /**
   * Internal initialization implementation
   */
  private async _initialize(): Promise<void> {
    if (this.initialized) return;

    if (isLoggingEnabled()) {
      log("[Daytona] Initializing Daytona sandbox...");
    }
    
    console.error("[Daytona] Initializing Daytona sandbox...");

    try {
      console.error("[Daytona] Creating Daytona sandbox...");
      // Create the sandbox with a shorter timeout
      this.sandbox = await this.daytona.create({
        language: "typescript", // Base language for the sandbox
        autoStopInterval: 30, // Auto-stop after 30 minutes of inactivity
      });

      if (!this.sandbox) {
        throw new Error("Sandbox creation failed - returned null");
      }

      if (isLoggingEnabled()) {
        log(`[Daytona] Sandbox created with ID: ${this.sandbox.id}`);
      }
      
      console.error(`[Daytona] Sandbox created with ID: ${this.sandbox.id}`);

      // Set simple defaults to avoid hanging on API calls
      this.userRootDir = "/home/daytona";
      this.workspaceDir = "/home/daytona/workspace";
      
      // Try to get the real user root dir, but don't hang if it fails
      try {
        const rootDirPromise = this.sandbox.getUserRootDir();
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => {
            reject(new Error("getUserRootDir timeout after 5 seconds"));
          }, 5000);
        });
        
        this.userRootDir = await Promise.race([rootDirPromise, timeoutPromise]);
        this.workspaceDir = path.join(this.userRootDir, "workspace");
      } catch (e) {
        console.error(`[Daytona] Using default paths due to error: ${e}`);
        // Keep using the defaults we set earlier
      }
      
      console.error(`[Daytona] Using root dir: ${this.userRootDir}`);
      console.error(`[Daytona] Using workspace dir: ${this.workspaceDir}`);
      
      // Mark as initialized early so other operations don't wait for setup
      this.initialized = true;
      console.error("[Daytona] Sandbox initialization completed successfully");
      
      // Continue with workspace setup in the background
      this.setupWorkspace().catch(err => {
        console.error(`[Daytona] Background workspace setup error: ${err}`);
      });
      
    } catch (error) {
      this.initialized = false;
      this.sandbox = null;
      console.error(`[Daytona] Failed to initialize sandbox: ${error}`);
      log(`[Daytona] Failed to initialize sandbox: ${error}`);
      throw new Error(`Failed to initialize Daytona sandbox: ${error}`);
    }
  }
  
  /**
   * Set up the workspace directory and test file in the background
   * This is separate from initialization to prevent blocking
   */
  private async setupWorkspace(): Promise<void> {
    if (!this.sandbox) return;
    
    try {
      // First try creating the workspace directory using the FS API
      if (this.sandbox.fs && typeof this.sandbox.fs.createFolder === 'function') {
        console.error(`[Daytona] Using FS API to create workspace directory: ${this.workspaceDir}`);
        try {
          await this.sandbox.fs.createFolder(this.workspaceDir, "755");
          console.error(`[Daytona] Workspace directory created successfully with FS API`);
        } catch (fsError) {
          console.error(`[Daytona] FS API workspace creation failed: ${fsError}`);
          // Fall back to shell method
          await this.createWorkspaceWithShell();
        }
      } else {
        // No FS API available, use shell method
        await this.createWorkspaceWithShell();
      }
      
      // Create a test file to verify write permissions
      try {
        if (this.sandbox.fs && typeof this.sandbox.fs.write === 'function') {
          console.error(`[Daytona] Using FS API to create test file`);
          const testFilePath = path.join(this.workspaceDir, "test_write_permissions.txt");
          const testContent = "Test file to verify write permissions";
          await this.sandbox.fs.write(testFilePath, testContent);
          console.error(`[Daytona] Test file created successfully with FS API`);
        } else {
          // Use Python which is more reliable across environments
          const testFilePath = path.join(this.workspaceDir, "test_write_permissions.txt");
          const testContent = "Test file to verify write permissions";
          
          const pythonCode = `
import os

try:
    # Create directory if it doesn't exist
    os.makedirs("${this.workspaceDir}", exist_ok=True)
    
    # Write content to file
    with open("${testFilePath}", "w") as f:
        f.write("${testContent}")
    
    # Set permissions
    os.chmod("${testFilePath}", 0o666)
    
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {str(e)}")
`;
          const pythonResult = await this.sandbox.process.codeRun(pythonCode);
          
          if (pythonResult.result && pythonResult.result.includes("SUCCESS")) {
            console.error(`[Daytona] Test file created successfully with Python method`);
          } else {
            console.error(`[Daytona] Python test file creation failed: ${pythonResult.result}`);
            throw new Error(`Failed to create test file: ${pythonResult.result}`);
          }
        }
      } catch (fileError) {
        console.error(`[Daytona] Error creating test file: ${fileError}`);
      }
      
      // List directory to verify structure
      try {
        const lsResult = await this.exec(
          ["ls", "-la", this.workspaceDir],
          {},
          [],
          undefined
        );
        
        console.error(`[Daytona] Workspace directory contents: ${lsResult.stdout}`);
      } catch (lsError) {
        console.error(`[Daytona] Error listing workspace: ${lsError}`);
      }
    } catch (error) {
      console.error(`[Daytona] Workspace setup error: ${error}`);
    }
  }
  
  /**
   * Create workspace directory using shell commands - fallback method
   */
  private async createWorkspaceWithShell(): Promise<void> {
    try {
      console.error(`[Daytona] Using shell commands to create workspace: ${this.workspaceDir}`);
      
      // Try with more permissions
      const mkdirResult = await this.exec(
        ["bash", "-c", `mkdir -p "${this.workspaceDir}" && chmod 777 "${this.workspaceDir}"`],
        {},
        [],
        undefined
      );
      
      if (mkdirResult.exitCode !== 0) {
        console.error(`[Daytona] Warning: Error creating workspace dir: ${mkdirResult.stderr}`);
        // Try an alternative command with sudo if available
        const sudoResult = await this.exec(
          ["bash", "-c", `sudo mkdir -p "${this.workspaceDir}" && sudo chmod 777 "${this.workspaceDir}" || true`],
          {},
          [],
          undefined
        );
        console.error(`[Daytona] Sudo mkdir attempt result: ${sudoResult.exitCode}`);
      } else {
        console.error(`[Daytona] Workspace directory created successfully with shell command`);
      }
    } catch (error) {
      console.error(`[Daytona] Shell workspace creation failed: ${error}`);
    }
  }

  /**
   * Execute a command in the Daytona sandbox.
   */
  public async exec(
    cmd: Array<string>,
    opts: SpawnOptions,
    _writableRoots: Array<string>,
    abortSignal?: AbortSignal
  ): Promise<ExecResult> {
    // If not initialized, try to initialize
    if (!this.initialized || !this.sandbox) {
      try {
        await this.initialize();
      } catch (error) {
        // If initialization fails, return an error result
        console.error(`[Daytona] Failed to initialize sandbox: ${error}`);
        return {
          stdout: "",
          stderr: `Failed to initialize Daytona sandbox: ${error}`,
          exitCode: 1,
        };
      }
    }

    // Double-check that initialization worked
    if (!this.sandbox) {
      return {
        stdout: "",
        stderr: "Daytona sandbox failed to initialize",
        exitCode: 1,
      };
    }

    // Map the working directory
    const workdir = opts.cwd ? this.mapLocalToRemotePath(opts.cwd as string) : this.userRootDir;
    const timeoutInMillis = opts.timeout || 30000; // Default 30 seconds
    
    // Convert environment variables if present
    const env: Record<string, string> = {};
    if (opts.env) {
      Object.entries(opts.env).forEach(([key, value]) => {
        if (value !== undefined) {
          env[key] = value.toString();
        }
      });
    }

    try {
      if (isLoggingEnabled()) {
        log(`[Daytona] Executing command: ${cmd.join(" ")} in ${workdir}`);
      }
      console.error(`[Daytona] Executing command: ${cmd.join(" ")} in ${workdir}`);

      // Handle abort signal
      if (abortSignal?.aborted) {
        return {
          stdout: "",
          stderr: "Command was aborted before execution",
          exitCode: 1,
        };
      }

      // Try to use the process API directly if available
      if (this.sandbox.process && typeof this.sandbox.process.exec === 'function') {
        try {
          console.error(`[Daytona] Using direct process.exec API`);
          const commandString = cmd.join(" ");
          
          // Execute using the direct process API
          const processResult = await this.sandbox.process.exec(commandString, workdir, env);
          
          return {
            stdout: processResult.stdout || "",
            stderr: processResult.stderr || "",
            exitCode: processResult.exitCode || 0
          };
        } catch (directApiError) {
          console.error(`[Daytona] Direct process API failed: ${directApiError}, falling back to codeRun`);
          // Fall back to codeRun method
        }
      }
      
      // Fall back to direct shell commands since Python codeRun fails with TypeScript errors
      // Create a direct bash call with proper output redirection
      const commandString = cmd.join(" ");
      
      // Format environment variables for bash
      const envStr = Object.entries(env)
        .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
        .join(" ");
      
      // Don't try to create workspace dir here - would cause infinite recursion
      console.error(`[Daytona] Using workdir: ${workdir}`);
      // The directory should already exist from initialization
      
      // Instead of using shell redirect chains, let's use a simpler approach
      // that directly returns the command result
      let fullCommand = '';
      
      if (workdir) {
        fullCommand = `cd "${workdir}" && ${envStr} ${commandString}`;
      } else {
        fullCommand = `${envStr} ${commandString}`;
      }
      
      try {
        // Use direct exec to avoid recursion
        console.error(`[Daytona] Executing with directExec: ${fullCommand.substring(0, 80)}...`);
        return await this.directExec(fullCommand);
      } catch (error) {
        console.error(`[Daytona] Error with shell execution: ${error}`);
        return {
          stdout: "",
          stderr: `Shell execution error: ${error}`,
          exitCode: 1
        };
      }
    } catch (error) {
      log(`[Daytona] Execution error: ${error}`);
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  /**
   * Map a local file path to a remote path in the Daytona sandbox.
   * This is the critical function that determines where files are created in the Daytona environment.
   */
  public mapLocalToRemotePath(localPath: string): string {
    // If we've already mapped this path, return the cached mapping
    if (this.localToRemotePaths.has(localPath)) {
      console.error(`[Daytona] Using cached path mapping for ${localPath}: ${this.localToRemotePaths.get(localPath)}`);
      return this.localToRemotePaths.get(localPath)!;
    }

    // If it's already an absolute path that could exist in the sandbox (like /home/daytona),
    // just return it as is - but only if we're sure it's a Daytona path, not a local path
    if (
      (localPath.startsWith('/home/daytona/') || localPath === '/home/daytona') || 
      localPath === this.userRootDir || 
      (this.userRootDir && localPath.startsWith(this.userRootDir))
    ) {
      console.error(`[Daytona] Using original remote path: ${localPath}`);
      return localPath;
    }

    // Default workspace directory is /home/daytona/workspace if not yet initialized
    const effectiveWorkspaceDir = this.workspaceDir || '/home/daytona/workspace';
    let remotePath = '';
    
    // Handle relative paths first (most common case with apply_patch)
    if (!path.isAbsolute(localPath)) {
      console.error(`[Daytona] Mapping relative path directly to workspace: ${localPath}`);
      // For relative paths, just put them directly in the workspace
      remotePath = path.posix.join(effectiveWorkspaceDir, localPath);
    } else {
      // For absolute paths on the local machine, map to workspace structure
      console.error(`[Daytona] Mapping absolute path: ${localPath}`);
      
      // Extract the relevant part of the path (remove OS-specific parts)
      let relativePath = localPath;
      
      // Remove drive letter for Windows paths
      relativePath = relativePath.replace(/^[A-Za-z]:/, '');
      
      // Standard approach: extract path components
      const pathParts = relativePath.split(/[/\\]+/).filter(p => p.length > 0);
      
      // Skip well-known system directories like 'Users', 'home', 'tmp', etc.
      const skipDirs = ['Users', 'home', 'tmp', 'var', 'usr'];
      let startIndex = 0;
      
      // Find first component that isn't in skipDirs
      for (let i = 0; i < pathParts.length; i++) {
        if (skipDirs.includes(pathParts[i])) {
          // Skip this directory and potentially the username that follows
          startIndex = i + 1;
          // If this is Users or home, also skip the username
          if (pathParts[i] === 'Users' || pathParts[i] === 'home') {
            startIndex = i + 2;
          }
        } else {
          break;
        }
      }
      
      // Rebuild path from relevant parts
      const relevantParts = pathParts.slice(startIndex);
      
      // Handle rare case when we might end up with empty path after filtering
      if (relevantParts.length === 0) {
        // Default to plain filename at workspace root
        const filename = path.basename(localPath);
        remotePath = path.posix.join(effectiveWorkspaceDir, filename);
        console.error(`[Daytona] Path filtering resulted in empty path, using filename: ${filename}`);
      } else {
        // Join with forward slashes to ensure proper paths in Linux environment
        remotePath = path.posix.join(effectiveWorkspaceDir, ...relevantParts);
      }
    }
    
    console.error(`[Daytona] Mapped ${localPath} -> ${remotePath}`);
    
    // Store the mapping for future use
    this.localToRemotePaths.set(localPath, remotePath);
    
    return remotePath;
  }

  /**
   * Direct execution method that doesn't use this.exec to avoid recursion
   * Only used by internal file operations
   */
  private async directExec(cmd: string): Promise<{stdout: string, stderr: string, exitCode: number}> {
    if (!this.sandbox || !this.sandbox.process) {
      return {
        stdout: "",
        stderr: "Sandbox or process not available",
        exitCode: 1
      };
    }
    
    try {
      // Use direct process API if available 
      if (typeof this.sandbox.process.exec === 'function') {
        console.error(`[Daytona] Using direct process.exec for: ${cmd.substring(0, 40)}...`);
        const result = await this.sandbox.process.exec(cmd, this.userRootDir);
        return {
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          exitCode: result.exitCode || 0
        };
      } else {
        // Define a simpler approach using a command that won't recursively call
        // Use one of these language runtimes which should be available
        const bashJsRunner = `
        try {
          const { execSync } = require('child_process');
          try {
            const stdout = execSync('${cmd.replace(/'/g, "\\'")}', {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'] 
            });
            console.log("SUCCESS: " + stdout);
          } catch (error) {
            console.log("ERROR: " + (error.stderr || "Unknown error"));
            console.log("CODE: " + (error.status || 1));
          }
        } catch (e) {
          console.log("RUNNER_ERROR: " + e.message);
        }`;
        
        console.error(`[Daytona] Using JS runner for command`);
        const result = await this.sandbox.process.codeRun(bashJsRunner);
        
        // Parse the new format output
        const output = result.result || "";
        
        // Get stdout from success case
        let stdout = '';
        if (output.includes("SUCCESS: ")) {
          stdout = output.split("SUCCESS: ")[1];
          return { stdout, stderr: '', exitCode: 0 };
        }
        
        // Get error info 
        let stderr = '';
        let exitCode = 1;
        
        if (output.includes("ERROR: ")) {
          stderr = output.split("ERROR: ")[1];
          if (output.includes("CODE: ")) {
            const codeStr = output.split("CODE: ")[1];
            exitCode = parseInt(codeStr, 10) || 1;
          }
        } else if (output.includes("RUNNER_ERROR: ")) {
          stderr = output.split("RUNNER_ERROR: ")[1];
        }
        
        return { stdout, stderr, exitCode };
      }
    } catch (error) {
      console.error(`[Daytona] Direct exec error: ${error}`);
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      };
    }
  }
  
  /**
   * Upload a file to the Daytona sandbox.
   */
  public async uploadFile(localPath: string, content: string): Promise<void> {
    // If not initialized, try to initialize
    if (!this.initialized || !this.sandbox) {
      try {
        await this.initialize();
      } catch (error) {
        console.error(`[Daytona] Failed to initialize sandbox for file upload: ${error}`);
        throw new Error(`Failed to initialize Daytona sandbox for file upload: ${error}`);
      }
    }

    // Double-check that initialization worked
    if (!this.sandbox) {
      throw new Error("Daytona sandbox failed to initialize for file upload");
    }

    const remotePath = this.mapLocalToRemotePath(localPath);
    console.error(`[Daytona] uploadFile: local=${localPath}, remote=${remotePath}`);
    
    try {
      // Ensure parent directory exists with proper permissions (this is critical)
      const remoteDir = path.dirname(remotePath);
      console.error(`[Daytona] Creating directory structure: ${remoteDir}`);
      
      // Create using direct fs API if available
      try {
        if (this.sandbox.fs && typeof this.sandbox.fs.createFolder === 'function') {
          console.error(`[Daytona] Using direct FS API to create directory: ${remoteDir}`);
          await this.sandbox.fs.createFolder(remoteDir, "755");
          console.error(`[Daytona] Directory created successfully with FS API`);
        } else {
          throw new Error("Direct FS API not available");
        }
      } catch (fsError) {
        console.error(`[Daytona] FS API directory creation failed: ${fsError}`);
        // Fall back to shell commands
        try {
          console.error(`[Daytona] Trying shell mkdir command`);
          await this.exec(
            ["bash", "-c", `mkdir -p "${remoteDir}" && chmod 777 "${remoteDir}"`],
            {},
            [],
            undefined
          );
        } catch (shellError) {
          console.error(`[Daytona] Shell mkdir failed: ${shellError}`);
        }
      }
      
      // Upload the file using the most reliable method first - direct FS API
      console.error(`[Daytona] Attempting to upload file to ${remotePath}`);
      
      // Try using the direct FS API first (most reliable)
      if (this.sandbox.fs && typeof this.sandbox.fs.write === 'function') {
        console.error(`[Daytona] Using direct filesystem API`);
        try {
          await this.sandbox.fs.write(remotePath, content);
          
          // Verify file exists using fs.getFileDetails if available
          try {
            if (typeof this.sandbox.fs.getFileDetails === 'function') {
              const fileDetails = await this.sandbox.fs.getFileDetails(remotePath);
              console.error(`[Daytona] File verification successful: ${fileDetails.name}`);
              return;
            }
          } catch (verifyError) {
            console.error(`[Daytona] File verification failed with FS API: ${verifyError}`);
          }
          
          // Fall back to shell verification if FS API verification fails
          const verifyResult = await this.exec(
            ["test", "-f", remotePath], 
            {}, 
            [], 
            undefined
          );
          
          if (verifyResult.exitCode === 0) {
            console.error(`[Daytona] File created successfully with direct API`);
            return;
          } else {
            console.error(`[Daytona] Direct API write verification failed, trying alternative methods`);
          }
        } catch (directApiError) {
          console.error(`[Daytona] Direct API write failed: ${directApiError}, trying alternative methods`);
        }
      }
      
      // If we get here, try using direct exec for file writing (avoiding recursion)
      console.error(`[Daytona] Trying direct file write method`);
      try {
        // First create directory using direct exec to avoid recursion
        console.error(`[Daytona] Ensuring directory exists with direct exec: ${remoteDir}`);
        const mkdirCmd = `mkdir -p "${remoteDir}"`;
        await this.directExec(mkdirCmd);
        
        // Try to write the file using pure echo commands with direct exec
        const fileContent = content.replace(/'/g, "'\\''");
        const fileWriteCommand = `echo '${fileContent}' > "${remotePath}"`;
        console.error(`[Daytona] Running direct echo command to write file`);
        
        try {
          // First attempt - simple echo to file with direct exec
          const echoResult = await this.directExec(fileWriteCommand);
          
          if (echoResult.exitCode === 0) {
            console.error(`[Daytona] Echo command successful`);
            
            // Verify file exists using direct exec
            const verifyCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
            const verifyResult = await this.directExec(verifyCmd);
            
            if (verifyResult.stdout.includes("exists")) {
              console.error(`[Daytona] File verified with test -f`);
              
              // Make file readable/writable using direct exec
              const chmodCmd = `chmod 666 "${remotePath}"`;
              await this.directExec(chmodCmd);
              
              console.error(`[Daytona] File permissions set to 666`);
              return;
            }
          }
        } catch (echoError) {
          console.error(`[Daytona] Echo method failed: ${echoError}`);
        }
        
        // More direct approach - use a temporary file with direct exec
        try {
          const tempPath = `/tmp/codex_temp_${Date.now()}.txt`;
          const tempWriteCmd = `echo '${content.replace(/'/g, "'\\''").replace(/\n/g, "\\n")}' > "${tempPath}"`;
          
          console.error(`[Daytona] Trying to write to temp file ${tempPath}`);
          
          // Create temp file using direct exec
          const tempResult = await this.directExec(tempWriteCmd);
          
          if (tempResult.exitCode === 0) {
            // Move temp file to actual location using direct exec
            const mvCmd = `cp "${tempPath}" "${remotePath}" && chmod 666 "${remotePath}"`;
            const mvResult = await this.directExec(mvCmd);
            
            if (mvResult.exitCode === 0) {
              console.error(`[Daytona] File copy from temp successful`);
              
              // Verify file exists using direct exec
              const checkCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
              const verifyResult = await this.directExec(checkCmd);
              
              if (verifyResult.stdout.includes("exists")) {
                console.error(`[Daytona] File verified with direct exec`);
                return;
              }
            }
          }
        } catch (tempError) {
          console.error(`[Daytona] Temp file method failed: ${tempError}`);
        }
        
        // Last resort - try writing with base64 encoding (avoids escaping issues)
        try {
          const encodedContent = Buffer.from(content).toString('base64');
          const base64Cmd = `echo '${encodedContent}' | base64 --decode > ${remotePath} && chmod 666 ${remotePath}`;
          
          console.error(`[Daytona] Trying base64 method`);
          
          const base64Result = await this.exec(
            ["bash", "-c", base64Cmd],
            {},
            [],
            undefined
          );
          
          if (base64Result.exitCode === 0) {
            console.error(`[Daytona] Base64 write method successful`);
            
            // Verify file exists
            const verifyResult = await this.exec(
              ["test", "-f", remotePath],
              {},
              [],
              undefined
            );
            
            if (verifyResult.exitCode === 0) {
              return;
            }
          }
        } catch (base64Error) {
          console.error(`[Daytona] Base64 method failed: ${base64Error}`);
        }
      } catch (directExecError) {
        console.error(`[Daytona] Direct exec file write method failed: ${directExecError}`);
      }
      
      // Last attempt - use touch & direct file write via dd or tee
      console.error(`[Daytona] Trying final direct file write methods`);
      try {
        // First touch the file to create it and make it writable with direct exec
        const touchCmd = `touch "${remotePath}" && chmod 666 "${remotePath}"`;
        await this.directExec(touchCmd);
        
        // Try dd command for direct byte writing with direct exec
        const base64Content = Buffer.from(content).toString('base64');
        const ddCommand = `echo '${base64Content}' | base64 -d | dd of="${remotePath}" bs=1024`;
        
        console.error(`[Daytona] Trying dd method with direct exec`);
        const ddResult = await this.directExec(ddCommand);
        
        // Verify file exists and has content with direct exec
        const checkSizeCmd = `test -s "${remotePath}" && echo "has_content" || echo "empty"`;
        const sizeResult = await this.directExec(checkSizeCmd);
        
        if (sizeResult.stdout.includes("has_content")) {
          console.error(`[Daytona] File created successfully with dd method`);
          return;
        }
        
        // Try tee command (another alternative) with direct exec
        const teeCommand = `echo '${content.replace(/'/g, "'\\''").replace(/\n/g, "\\n")}' | tee "${remotePath}" > /dev/null`;
        console.error(`[Daytona] Trying tee method with direct exec`);
        
        const teeResult = await this.directExec(teeCommand);
        
        // Verify file exists with direct exec
        const verifyCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
        const verifyResult = await this.directExec(verifyCmd);
        
        if (verifyResult.stdout.includes("exists")) {
          console.error(`[Daytona] File created successfully with tee method`);
          return;
        }
        
        // If all these fail, try one more approach with simplified file write using direct exec
        // Create a simplified, minimal command to write the file
        const simpleCommand = `printf "${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" > "${remotePath}" && chmod 666 "${remotePath}"`;
        console.error(`[Daytona] Trying simplified file write approach`);
        
        // Execute the simplified command
        const simpleResult = await this.directExec(simpleCommand);
        
        // Check if file was created
        const finalCheckCmd = `test -f "${remotePath}" && echo "success" || echo "failed"`;
        const finalCheck = await this.directExec(finalCheckCmd);
            
        if (finalCheck.stdout.includes("success")) {
          console.error(`[Daytona] File created successfully with simplified approach`);
          return;
        }
      } catch (finalError) {
        console.error(`[Daytona] Final file write methods failed: ${finalError}`);
      }
      
      // If we get here, all methods failed
      throw new Error("All file upload methods failed");
    } catch (error) {
      console.error(`[Daytona] Failed to upload file: ${error}`);
      log(`[Daytona] Failed to upload file: ${error}`);
      throw new Error(`Failed to upload file to Daytona sandbox: ${error}`);
    }
  }

  /**
   * Ensure a directory exists in the Daytona sandbox.
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    if (!this.sandbox) return;
    
    try {
      console.error(`[Daytona] Creating directory: ${dirPath}`);
      
      // Use direct exec to avoid recursion
      const mkdirCmd = `mkdir -p "${dirPath}" && chmod 755 "${dirPath}"`;
      const result = await this.directExec(mkdirCmd);
      
      console.error(`[Daytona] Directory creation result: exitCode=${result.exitCode}, stderr=${result.stderr}`);
      
      if (result.exitCode !== 0) {
        throw new Error(`Failed to create directory: ${result.stderr}`);
      }
    } catch (e) {
      console.error(`[Daytona] Error creating directory ${dirPath}: ${e}`);
      if (isLoggingEnabled()) {
        log(`[Daytona] Error creating directory ${dirPath}: ${e}`);
      }
      
      // Don't throw here - let the operation continue even if directory creation fails
      // The upload might still work if the directory already exists
    }
  }

  /**
   * Download a file from the Daytona sandbox.
   */
  public async downloadFile(remotePath: string): Promise<string> {
    // If not initialized, try to initialize
    if (!this.initialized || !this.sandbox) {
      try {
        await this.initialize();
      } catch (error) {
        console.error(`[Daytona] Failed to initialize sandbox for file download: ${error}`);
        return ""; // Return empty string if initialization fails
      }
    }

    // Double-check that initialization worked
    if (!this.sandbox) {
      console.error(`[Daytona] Sandbox failed to initialize for file download`);
      return ""; // Return empty string if sandbox is not initialized
    }

    try {
      if (isLoggingEnabled()) {
        log(`[Daytona] Downloading file from ${remotePath}`);
      }
      console.error(`[Daytona] Downloading file from ${remotePath}`);
      
      // Check if file exists
      const checkResult = await this.exec(
        ["test", "-f", remotePath], 
        {}, 
        [], 
        undefined
      );
      
      if (checkResult.exitCode !== 0) {
        console.error(`[Daytona] File not found: ${remotePath}`);
        return ""; // Return empty string for files that don't exist
      }
      
      // Use cat to read the file contents
      const catResult = await this.exec(
        ["cat", remotePath], 
        {}, 
        [], 
        undefined
      );
      
      if (catResult.exitCode !== 0) {
        console.error(`[Daytona] Error reading file: ${catResult.stderr}`);
        return ""; // Return empty if we can't read it
      }
      
      console.error(`[Daytona] File read successfully, content length: ${catResult.stdout.length}`);
      return catResult.stdout;
    } catch (error) {
      console.error(`[Daytona] Failed to download file: ${error}`);
      log(`[Daytona] Failed to download file: ${error}`);
      
      // Return empty string for any errors
      return "";
    }
  }

  /**
   * Clean up resources when done (asynchronous version).
   */
  public async cleanup(): Promise<void> {
    if (this.sandbox) {
      try {
        const sandboxId = this.sandbox.id;
        console.error(`[Daytona] Cleaning up sandbox ${sandboxId}`);
        
        if (isLoggingEnabled()) {
          log(`[Daytona] Cleaning up sandbox ${sandboxId}`);
        }
        
        // Store sandbox locally to avoid race conditions
        const sandbox = this.sandbox;
        
        // Reset state immediately to prevent other operations during cleanup
        this.sandbox = null;
        this.initialized = false;
        this.initializing = false;
        this.initializePromise = null;
        this.localToRemotePaths.clear();
        
        // Clear the global instance
        if (globalDaytonaSandboxInstance === this) {
          globalDaytonaSandboxInstance = null;
        }
        
        // Remove the sandbox with timeout
        try {
          const removePromise = this.daytona.remove(sandbox);
          const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error("Sandbox removal timeout after 5 seconds"));
            }, 5000);
          });
          
          await Promise.race([removePromise, timeoutPromise]);
          console.error(`[Daytona] Sandbox ${sandboxId} cleanup completed`);
        } catch (removeError) {
          // Still consider cleanup successful even if the remove API fails
          console.error(`[Daytona] Sandbox removal API error: ${removeError}`);
          console.error(`[Daytona] Local cleanup completed for sandbox ${sandboxId}`);
        }
      } catch (error) {
        console.error(`[Daytona] Failed to clean up sandbox: ${error}`);
        log(`[Daytona] Failed to clean up sandbox: ${error}`);
      }
    }
  }
  
  /**
   * Clean up resources when done (synchronous version for process.exit).
   * This method can't make async calls to the API, but we'll use a fire-and-forget approach.
   */
  public cleanupSync(): void {
    if (this.sandbox) {
      try {
        const sandboxId = this.sandbox.id;
        const sandbox = this.sandbox;
        console.error(`[Daytona] Synchronous cleanup for sandbox ${sandboxId}`);
        
        // Clean up local state immediately
        this.sandbox = null;
        this.initialized = false;
        this.initializing = false;
        this.initializePromise = null;
        this.localToRemotePaths.clear();
        
        // Clear the global instance
        if (globalDaytonaSandboxInstance === this) {
          globalDaytonaSandboxInstance = null;
        }
        
        // Try a "fire and forget" removal
        // This may not complete before process exit, but it's worth trying
        try {
          this.daytona.remove(sandbox).catch(e => {
            // We can't handle this since we're exiting
          });
          console.error(`[Daytona] Cleanup request sent for sandbox ${sandboxId}`);
        } catch (e) {
          // Ignore errors during exit
        }
      } catch (error) {
        console.error(`[Daytona] Failed to clean up sandbox synchronously: ${error}`);
        if (isLoggingEnabled()) {
          log(`[Daytona] Failed to clean up sandbox synchronously: ${error}`);
        }
      }
    }
  }
}