import { SandboxType } from "./interface.js";
import { loadConfig, saveConfig, AppConfig } from "../../config.js";
import { existsSync } from "fs";
import { DAYTONA_API_KEY } from "../../config.js";

/**
 * Sets the sandbox type to use for command execution.
 * @param type The sandbox type to use: 'local' or 'daytona'.
 * @returns A message indicating the new sandbox type.
 */
export function setSandboxType(type: string): string {
  // Validate the sandbox type
  if (type !== "local" && type !== "daytona") {
    return `Error: Invalid sandbox type '${type}'. Valid types are 'local' and 'daytona'.`;
  }

  // If selecting Daytona, verify API key is set
  if (type === "daytona" && !DAYTONA_API_KEY) {
    return "Error: DAYTONA_API_KEY environment variable is required for Daytona sandbox. Please set it before continuing.";
  }

  // Load the current config
  const config = loadConfig();

  // Map the type string to SandboxType enum
  let sandboxType: SandboxType;
  if (type === "local") {
    // Use platform-specific local sandbox
    if (process.platform === "darwin") {
      sandboxType = SandboxType.MACOS_SEATBELT;
    } else if (process.platform === "linux") {
      sandboxType = SandboxType.LINUX_LANDLOCK;
    } else {
      sandboxType = SandboxType.NONE;
    }
  } else {
    // Use Daytona cloud sandbox
    sandboxType = SandboxType.DAYTONA;
  }

  // Update the config
  config.sandboxType = sandboxType;
  
  // If using Daytona, add default Daytona config if not present
  if (type === "daytona" && !config.daytonaConfig) {
    config.daytonaConfig = {
      autoStopInterval: 30 // Default to 30 minutes
    };
  }

  // Save the config
  saveConfig(config);

  // Return a success message
  let message = `Sandbox type set to '${type}'`;
  if (type === "daytona") {
    message += " (Daytona Cloud)";
  } else {
    message += ` (${sandboxType})`;
  }
  
  return message;
}

/**
 * Gets the current sandbox type from config.
 * @returns A message indicating the current sandbox type.
 */
export function getSandboxType(): string {
  // Load the current config
  const config = loadConfig();
  
  // Get the current sandbox type
  const sandboxType = config.sandboxType;

  // Map SandboxType to user-friendly name
  let typeDescription: string;
  switch (sandboxType) {
    case SandboxType.DAYTONA:
      typeDescription = "daytona (Daytona Cloud)";
      break;
    case SandboxType.MACOS_SEATBELT:
      typeDescription = "local (macOS Seatbelt)";
      break;
    case SandboxType.LINUX_LANDLOCK:
      typeDescription = "local (Linux Landlock)";
      break;
    case SandboxType.NONE:
      typeDescription = "local (No Sandbox)";
      break;
    default:
      // Default to platform-specific sandbox
      typeDescription = `local (${process.platform === "darwin" ? "macOS Seatbelt" : process.platform === "linux" ? "Linux Landlock" : "No Sandbox"})`;
  }

  return `Current sandbox type: ${typeDescription}`;
}

/**
 * Sets Daytona sandbox configuration options.
 * @param options The Daytona sandbox options to set.
 * @returns A message indicating the updated configuration.
 */
export function setDaytonaConfig(options: { autoStopInterval?: number }): string {
  // Load the current config
  const config = loadConfig();
  
  // Ensure Daytona config section exists
  if (!config.daytonaConfig) {
    config.daytonaConfig = {};
  }
  
  // Update auto-stop interval if provided
  if (options.autoStopInterval !== undefined) {
    config.daytonaConfig.autoStopInterval = options.autoStopInterval;
  }
  
  // Save the config
  saveConfig(config);
  
  // Return a success message
  return `Daytona sandbox configuration updated successfully`;
}

/**
 * Gets the current Daytona configuration.
 * @returns A message indicating the current Daytona configuration.
 */
export function getDaytonaConfig(): string {
  // Load the current config
  const config = loadConfig();
  
  // Check if Daytona config exists
  if (!config.daytonaConfig) {
    return "No Daytona configuration found.";
  }
  
  // Build the configuration message
  let message = "Current Daytona configuration:";
  
  // Add auto-stop interval
  const autoStopInterval = config.daytonaConfig.autoStopInterval;
  if (autoStopInterval !== undefined) {
    message += `\n- Auto-stop interval: ${autoStopInterval} minutes`;
    if (autoStopInterval === 0) {
      message += " (disabled)";
    }
  }
  
  return message;
}