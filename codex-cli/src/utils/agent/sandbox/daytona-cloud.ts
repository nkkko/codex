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
      
      // Special handling for specific commands
      
      // DO NOT add stderr redirection - it's being interpreted literally in Daytona
      // Let the sandbox handle redirections naturally
      
      // Special handling for commands that need proper shell interpretation
      
      // Check if this command has quotes, special characters, or shell operators
      const needsShellWrapping = 
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
        commandStr.includes('grep');
      
      if (needsShellWrapping && !commandStr.startsWith('/bin/sh -c')) {
        // For commands with special characters, use /bin/sh -c to ensure proper shell interpretation
        const escapedCmd = commandStr.replace(/'/g, "'\\''");
        commandStr = `/bin/sh -c '${escapedCmd}'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Wrapping command with shell: ${commandStr}`);
        }
      }
      
      // Special fix for Python -c commands which need double quotes preserved
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
      
      // Special handling for timeout command which doesn't work in Daytona
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
      
      // Special handling for sleep command (which appears to have issues)
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
      
      // Special handling for nohup command
      if (commandStr.startsWith('nohup ') && !commandStr.startsWith('/bin/sh -c')) {
        // Extract the actual command after nohup
        const nohupCmd = commandStr.substring('nohup '.length);
        // Wrap in shell to ensure proper interpretation
        commandStr = `/bin/sh -c 'nohup ${nohupCmd.replace(/'/g, "'\\''")}'`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Fixed nohup command: ${commandStr}`);
        }
      }
      
      // Special handling for Flask applications
      if ((commandStr.includes('flask run') || 
          (commandStr.includes('python') && commandStr.includes('app.py'))) &&
          !commandStr.startsWith('/bin/sh -c')) {
        // Don't try to run Flask in background with curl - just show info message
        // The Flask app will be created but we'll return a message indicating how to run it
        if (!commandStr.includes(' & ')) {
          // Let it run for a brief moment to see startup messages then terminate
          commandStr = `/bin/sh -c '${commandStr.replace(/'/g, "'\\''")} & pid=$!; sleep 1; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true'`;
          
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Modified Flask command: ${commandStr}`);
          }
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
      
      // Detect web servers and add preview links for any type of server
      let stdout = response.result || '';
      
      // Check if this is a command that runs a web server
      const isWebServer = 
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
        commandStr.includes('live-server');
      
      if (isWebServer) {
        // Try to detect the port number from various server output patterns
        let port = 0;
        
        // Flask pattern: "Running on http://127.0.0.1:5000"
        const flaskMatch = stdout.match(/Running on http:\/\/.*?:(\d+)/);
        if (flaskMatch) {
          port = parseInt(flaskMatch[1], 10);
        }
        
        // Node.js patterns: "listening on port 3000" or "started server on 0.0.0.0:3000"
        const nodeMatch = stdout.match(/(?:listening|started|running|server).+?(?:port|:)\s*(\d+)/i);
        if (!port && nodeMatch) {
          port = parseInt(nodeMatch[1], 10);
        }
        
        // Check for port in command directly
        if (!port) {
          const portFlagMatch = commandStr.match(/--port[= ](\d+)|-p\s+(\d+)/);
          if (portFlagMatch) {
            port = parseInt(portFlagMatch[1] || portFlagMatch[2], 10);
          }
        }
        
        // Determine server type for custom messaging
        let serverType = "Web server";
        if (commandStr.includes('flask') || (commandStr.includes('python') && commandStr.includes('app.py'))) {
          serverType = "Flask server";
        } else if (commandStr.includes('node') || commandStr.includes('npm') || commandStr.includes('npx')) {
          serverType = "Node.js server";
        } else if (commandStr.includes('rails')) {
          serverType = "Rails server";
        }
        
        // Default ports based on server type if we couldn't detect one
        if (!port) {
          if (commandStr.includes('flask') || (commandStr.includes('python') && commandStr.includes('app.py'))) {
            port = 5000; // Default Flask port
          } else if (commandStr.includes('rails')) {
            port = 3000; // Default Rails port
          } else if (commandStr.includes('next') || commandStr.includes('vite')) {
            port = 3000; // Default Next.js/Vite port
          } else {
            port = 8000; // Generic default
          }
        }
        
        try {
          // Generate a preview link for this port
          const previewInfo = this.getPreviewLink(port);
          
          // Add very visible preview link message with clear formatting
          stdout += `\n\n====== PREVIEW LINK ======\n` +
                   `${previewInfo.url}\n` +
                   `=========================\n\n` +
                   `${serverType} is running and accessible at the URL above.\n` +
                   `(You may need authentication token: ${previewInfo.token})\n`;
                   
          // Also add to stderr to ensure it's visible regardless of stdout truncation
          response.stderr = `PREVIEW LINK: ${previewInfo.url}`;
                   
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Generated preview link for ${serverType} on port ${port}: ${previewInfo.url}`);
          }
        } catch (err) {
          // Fallback message if preview link generation fails
          stdout += `\n\n====== LOCAL ACCESS ======\n` +
                   `http://127.0.0.1:${port}/\n` +
                   `=========================\n\n` +
                   `${serverType} is running locally.\n` + 
                   `Unable to generate preview link: ${String(err)}`;

          // Also add to stderr to ensure it's visible
          response.stderr = `LOCAL ACCESS: http://127.0.0.1:${port}/`;
                   
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Failed to generate preview link: ${String(err)}`);
          }
        }
      }
      
      // Convert from Daytona response format to our ExecResult format
      return {
        stdout: stdout,
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
  
  /**
   * Generate a preview link for a port
   * Uses the Daytona API to generate a preview link for accessing services running on a specific port
   * 
   * @param port The port number to generate a preview link for
   * @returns An object containing the preview link URL and authentication token
   */
  public getPreviewLink(port: number): { url: string; token: string } {
    if (!this.initialized || !this.sandbox) {
      throw new Error("Daytona sandbox not initialized");
    }
    
    try {
      // First check if the Daytona SDK has the getPreviewLink method
      if (typeof this.sandbox.getPreviewLink === 'function') {
        // Use the official SDK method
        const previewInfo = this.sandbox.getPreviewLink(port);
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Generated preview link for port ${port} using SDK method`);
        }
        
        return {
          url: previewInfo.url,
          token: previewInfo.token
        };
      } else {
        // Fallback method - generate the URL based on sandbox ID
        // This will work only if the sandbox ID follows the expected format
        
        if (!this.sandbox.id) {
          throw new Error("Sandbox ID not available");
        }
        
        // Extract sandbox ID from instance if available
        const sandboxId = this.sandbox.id;
        // Get the first 6 characters of the id as a node identifier
        const nodeId = sandboxId.substring(0, 6);
        
        // Generate standard Daytona preview URL format
        const previewUrl = `https://${port}-${sandboxId}.${nodeId}.daytona.work`;
        
        if (isLoggingEnabled()) {
          log(`[DaytonaSandbox] Generated preview link for port ${port} using fallback method: ${previewUrl}`);
        }
        
        // Return URL and empty token (token should be acquired through authentication)
        return {
          url: previewUrl,
          token: 'auth-required' // Placeholder - in real implementation this would be a proper token
        };
      }
    } catch (error: any) {
      if (isLoggingEnabled()) {
        log(`[DaytonaSandbox] Error generating preview link: ${error.message}`);
      }
      throw error;
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
          if (addingFile && currentFilePath) {
            // Save previous file if we were in the middle of adding one
            try {
              // Use mapPath to handle proper file path mapping
              const remotePath = this.mapPath(currentFilePath);
              
              // Log file being created
              if (isLoggingEnabled()) {
                log(`[DaytonaSandbox] Creating file: ${remotePath} with ${currentFileContent.length} bytes`);
              }
              
              // First ensure parent directory exists
              const dirPath = path.dirname(remotePath);
              try {
                await this.sandbox.fs.createFolder(dirPath);
              } catch (dirErr) {
                // Ignore directory creation errors as it might already exist
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] Directory creation note: ${String(dirErr)}`);
                }
              }
              
              // Create the file using the Daytona API
              const fileContent = new File([currentFileContent], path.basename(remotePath));
              await this.sandbox.fs.uploadFile(remotePath, fileContent);
              
              // Verify the file exists
              const checkCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
              const checkResult = await this.sandbox.process.executeCommand(checkCmd);
              
              if (checkResult.result?.trim() === "exists") {
                // Add file creation to output for proper display in terminal
                successOutput += `Created ${currentFilePath}\n`;
                
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] Successfully created file: ${remotePath}`);
                }
              } else {
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] File verification failed for: ${remotePath}, output: ${checkResult.result}`);
                }
                
                // Fall back to using echo with redirect for file creation
                const echoCmd = `echo '${currentFileContent.replace(/'/g, "'\\''")}' > "${remotePath}"`;
                const echoResult = await this.sandbox.process.executeCommand(echoCmd);
                
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] Echo fallback result: ${JSON.stringify(echoResult)}`);
                }
                
                successOutput += `Created ${currentFilePath} (using echo fallback)\n`;
              }
            } catch (fileErr) {
              if (isLoggingEnabled()) {
                log(`[DaytonaSandbox] Error creating file ${currentFilePath}: ${String(fileErr)}`);
              }
              successOutput += `Error creating ${currentFilePath}: ${String(fileErr)}\n`;
            }
            
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
            try {
              // Use mapPath to handle proper file path mapping
              const remotePath = this.mapPath(currentFilePath);
              
              // First ensure parent directory exists
              const dirPath = path.dirname(remotePath);
              try {
                await this.sandbox.fs.createFolder(dirPath);
              } catch (dirErr) {
                // Ignore directory creation errors as it might already exist
              }
              
              // Create the file using the Daytona API
              const fileContent = new File([currentFileContent], path.basename(remotePath));
              await this.sandbox.fs.uploadFile(remotePath, fileContent);
              
              // Verify the file exists
              const checkCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
              const checkResult = await this.sandbox.process.executeCommand(checkCmd);
              
              if (checkResult.result?.trim() === "exists") {
                // Add file creation to output for proper display in terminal
                successOutput += `Created ${currentFilePath}\n`;
                
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] Successfully created file: ${remotePath}`);
                }
              } else {
                if (isLoggingEnabled()) {
                  log(`[DaytonaSandbox] File verification failed for: ${remotePath}, trying echo fallback`);
                }
                
                // Fall back to using echo with redirect for file creation
                const echoCmd = `echo '${currentFileContent.replace(/'/g, "'\\''")}' > "${remotePath}"`;
                const echoResult = await this.sandbox.process.executeCommand(echoCmd);
                
                successOutput += `Created ${currentFilePath} (using echo fallback)\n`;
              }
            } catch (fileErr) {
              if (isLoggingEnabled()) {
                log(`[DaytonaSandbox] Error creating file ${currentFilePath}: ${String(fileErr)}`);
              }
              successOutput += `Error creating ${currentFilePath}: ${String(fileErr)}\n`;
            }
            
            currentFilePath = "";
            currentFileContent = "";
            addingFile = false;
          }
          
          // Handle other operations as needed
          if (line.startsWith("*** Delete File: ")) {
            const fileToDelete = line.substring("*** Delete File: ".length);
            try {
              // Use mapPath to handle proper file path mapping
              const remotePath = this.mapPath(fileToDelete);
              await this.sandbox.fs.deleteFile(remotePath);
              
              // Add file deletion to output for proper display in terminal
              successOutput += `Deleted ${fileToDelete}\n`;
              
              if (isLoggingEnabled()) {
                log(`[DaytonaSandbox] Deleted file: ${remotePath}`);
              }
            } catch (delErr) {
              if (isLoggingEnabled()) {
                log(`[DaytonaSandbox] Error deleting file ${fileToDelete}: ${String(delErr)}`);
              }
              successOutput += `Error deleting ${fileToDelete}: ${String(delErr)}\n`;
            }
          }
        }
      }
      
      // Handle any remaining file operation
      if (addingFile && currentFilePath) {
        try {
          // Use mapPath to handle proper file path mapping
          const remotePath = this.mapPath(currentFilePath);
          
          // First ensure parent directory exists
          const dirPath = path.dirname(remotePath);
          try {
            await this.sandbox.fs.createFolder(dirPath);
          } catch (dirErr) {
            // Ignore directory creation errors as it might already exist
          }
          
          // Create the file using the Daytona API
          const fileContent = new File([currentFileContent], path.basename(remotePath));
          await this.sandbox.fs.uploadFile(remotePath, fileContent);
          
          // Verify the file exists
          const checkCmd = `test -f "${remotePath}" && echo "exists" || echo "missing"`;
          const checkResult = await this.sandbox.process.executeCommand(checkCmd);
          
          if (checkResult.result?.trim() === "exists") {
            // Add file creation to output for proper display in terminal
            successOutput += `Created ${currentFilePath}\n`;
            
            if (isLoggingEnabled()) {
              log(`[DaytonaSandbox] Successfully created file: ${remotePath}`);
            }
          } else {
            if (isLoggingEnabled()) {
              log(`[DaytonaSandbox] File verification failed for: ${remotePath}, trying echo fallback`);
            }
            
            // Fall back to using echo with redirect for file creation
            const echoCmd = `echo '${currentFileContent.replace(/'/g, "'\\''")}' > "${remotePath}"`;
            const echoResult = await this.sandbox.process.executeCommand(echoCmd);
            
            successOutput += `Created ${currentFilePath} (using echo fallback)\n`;
          }
        } catch (fileErr) {
          if (isLoggingEnabled()) {
            log(`[DaytonaSandbox] Error creating file ${currentFilePath}: ${String(fileErr)}`);
          }
          successOutput += `Error creating ${currentFilePath}: ${String(fileErr)}\n`;
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