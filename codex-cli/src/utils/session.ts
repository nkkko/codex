import { SandboxType } from "./agent/sandbox/interface.js";

export const CLI_VERSION = "0.1.2504161510"; // Must be in sync with package.json.
export const ORIGIN = "codex_cli_ts";

export type TerminalChatSession = {
  /** Globally unique session identifier */
  id: string;
  /** The OpenAI username associated with this session */
  user: string;
  /** Version identifier of the Codex CLI that produced the session */
  version: string;
  /** The model used for the conversation */
  model: string;
  /** ISO timestamp noting when the session was persisted */
  timestamp: string;
  /** Optional custom instructions that were active for the run */
  instructions: string;
  /** The sandbox type used for command execution */
  sandboxType?: string;
};

let sessionId = "";

/**
 * Update the globally tracked session identifier.
 * Passing an empty string clears the current session.
 */
export function setSessionId(id: string): void {
  sessionId = id;
}

/**
 * Retrieve the currently active session identifier, or an empty string when
 * no session is active.
 */
export function getSessionId(): string {
  return sessionId;
}

let currentModel = "";
let currentSandboxType: SandboxType = SandboxType.NONE;

/**
 * Record the model that is currently being used for the conversation.
 * Setting an empty string clears the record so the next agent run can update it.
 */
export function setCurrentModel(model: string): void {
  currentModel = model;
}

/**
 * Return the model that was last supplied to {@link setCurrentModel}.
 * If no model has been recorded yet, an empty string is returned.
 */
export function getCurrentModel(): string {
  return currentModel;
}

/**
 * Record the sandbox type currently being used for command execution.
 */
export function setSandboxType(type: SandboxType): void {
  currentSandboxType = type;
  // Also set as environment variable for child processes
  process.env.CODEX_SANDBOX_TYPE = type;
}

/**
 * Get the current sandbox type used for command execution.
 * Prioritizes environment variable, then falls back to the stored value.
 */
export function getSandboxType(): SandboxType {
  // Environment variable overrides the session value (useful for tests and configuration)
  if (process.env.CODEX_SANDBOX_TYPE) {
    const envSandbox = process.env.CODEX_SANDBOX_TYPE;
    if (Object.values(SandboxType).includes(envSandbox as SandboxType)) {
      return envSandbox as SandboxType;
    }
  }
  
  // Fallback to session value
  return currentSandboxType;
}
