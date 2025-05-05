# Daytona Cloud Sandbox Specification

## Overview

The Daytona Cloud Sandbox provides a secure, isolated execution environment for running code and commands in the Codex CLI. This document specifies the implementation details, architecture, and API for the Daytona sandbox integration.

## Architecture

### Components

1. **DaytonaSandboxProvider**
   - Singleton class that provides access to Daytona cloud environments
   - Manages sandbox lifecycle (creation, initialization, cleanup)
   - Handles file operations and command execution including full set of API endpoints available in Daytona API through TS SDK
   - Maps local paths to remote paths

2. **Interface Implementations**
   - Implements the standard sandbox interface defined in `interface.ts`
   - Provides `exec()` method for command execution
   - Provides file operations (upload/download)

3. **Error Handling & Recovery**
   - Multiple fallback methods for file operations
   - Progressive enhancement approach for commands
   - Resilient path mapping between local and remote environments

## Singleton Pattern

The Daytona sandbox implementation uses a singleton pattern to avoid creating multiple sandbox instances.

## Initialization Process

The initialization process follows these steps:

1. Create a new Daytona SDK client with the provided API key
2. Create a sandbox without speficying language param (as that will be depreciated )
3. Set auto-stop interval (default: 30 minutes)
4. Get root directories for file operations
5. Set up workspace directory for file operations
6. Mark as initialized and set up workspace in background

The initialization includes timeout handling to prevent hanging.

## Path Mapping

The sandbox maps local file paths to remote paths in the Daytona environment:

1. For relative paths (most common with apply_patch):
   - Map directly to the workspace directory
   - Example: `hello.py` → `/home/daytona/workspace/hello.py`

2. For absolute paths:
   - Extract relevant parts by filtering out system directories
   - Map to workspace preserving structure
   - Example: `/Users/username/project/file.py` → `/home/daytona/workspace/project/file.py`

3. Path caching:
   - Store mappings in memory for reuse
   - Log all path mapping operations for debugging

## File Operations

### File Upload

The file upload process includes fallbacks and verification:

1. **Direct Filesystem API**
   - Use Daytona SDK's `fs.write` if available
   - Verify file existence after write

2. **Verification**
   - Verify all file operations with `test -f` or similar
   - Log detailed diagnostics for failures

### File Download

File download uses a simple process:

1. Check if file exists on remote system
2. Use `cat` command to read file contents
3. Return content as string (for text files)

## Command Execution

The command execution strategy uses the following method:

1. **Direct Process API**:
   - Uses Daytona SDK's `process.exec` directly when available
   - Takes command, working directory, and environment variables

The implementation carefully handles error cases and avoids infinite recursion by using direct API calls instead of nested exec calls.

## Cleanup & Resource Management

The sandbox includes proper cleanup of resources:

1. **Background Initialization**:
   - Complete critical initialization first
   - Continue with workspace setup in background
   - Prevent blocking the main thread

2. **Exit Handlers**:
   - Register handlers for process exit and SIGINT
   - Perform synchronous cleanup on exit
   - "Fire and forget" shutdown for fast termination

3. **Resource Release**:
   - Clear all internal state
   - Remove sandbox via API
   - Handle timeouts during cleanup

## Error Handling Strategy

The error handling follows these principles:

1. **Graceful Degradation**:
   - Fall back to simpler methods when advanced ones fail
   - Multiple alternatives for each operation
   - Default safely when timeouts occur

2. **Detailed Logging**:
   - Log all operations and their results
   - Include context for error conditions
   - Provide diagnostics for troubleshooting

3. **Timeout Protection**:
   - Protect against hanging operations
   - Race against timeouts for critical functions
   - Clean exit paths when operations fail

## Security Considerations

The Daytona sandbox provides security through isolation:

1. **Environment Isolation**:
   - Commands run in isolated cloud container
   - No access to local machine resources
   - Separate filesystem from host

2. **Permission Handling**:
   - Create files with appropriate permissions
   - Ensure directories are accessible
   - Handle permission errors gracefully

## Integration Points

The integration with the Codex CLI happens through:

1. **SandboxType Enumeration**:
   - `SandboxType.DAYTONA` added to available options
   - Selected via configuration

2. **Apply Patch Integration**:
   - Handles file creation via the upload method
   - Maps paths correctly for patching

3. **Command Execution**:
   - Used by CLI to run user commands
   - Returns standardized ExecResult objects

## Implementation Challenges & Solutions

The implementation addresses several key challenges:

1. **Recursive Command Execution**:
   - Solved by using direct API calls instead of shell commands
   - Implemented specialized directExec method to prevent loops

2. **Path Mapping**:
   - Robust algorithm for handling both relative and absolute paths
   - Caching for performance
   - Special case handling for system directories

3. **File Operation Failures**:
   - Multiple fallback mechanisms for reliability
   - Multiple verification steps
   - Detailed error reporting

4. **Environment Differences**:
   - Handle differences between local and remote environments
   - Abstract away path differences
   - Handle different shell behaviors

## Configuration Options

The Daytona sandbox can be configured with several options:

1. **API Key**:
   - Required for authentication with Daytona service
   - Stored in environment variable `DAYTONA_API_KEY`

2. **Auto-Stop Interval**:
   - Time in minutes before auto-stopping idle sandboxes
   - Default: 30 minutes
   - Set to 0 to disable auto-stop

3. **Sandbox Type Config**:
   - Set the sandbox type in Codex CLI config
   - Use `sandboxType: "daytona.cloud"` in config file

## Testing Strategy

Testing the Daytona sandbox integration should include:

1. **Unit Tests**:
   - Path mapping functions
   - Command parsing
   - Error handling

2. **Integration Tests**:
   - File operations (create, read, verify)
   - Command execution
   - Cleanup procedures

3. **Error Case Testing**:
   - Network failures
   - Timeout handling
   - Permission errors
   - Cleanup during errors