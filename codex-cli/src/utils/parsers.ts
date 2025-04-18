import type {
  ExecInput,
  ExecOutputMetadata,
} from "./agent/sandbox/interface.js";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.mjs";

import { log } from "node:console";
import { formatCommandForDisplay } from "src/format-command.js";

// The console utility import is intentionally explicit to avoid bundlers from
// including the entire `console` module when only the `log` function is
// required.

export function parseToolCallOutput(toolCallOutput: string): {
  output: string;
  metadata: ExecOutputMetadata;
} {
  // Ensure we have a valid non-empty string to work with
  if (!toolCallOutput || typeof toolCallOutput !== 'string') {
    return {
      output: `Empty or invalid output`,
      metadata: {
        exit_code: 1,
        duration_seconds: 0,
      },
    };
  }

  try {
    // Try to parse as JSON
    const { output, metadata } = JSON.parse(toolCallOutput);
    
    // Ensure the output is a string to prevent split() errors
    return {
      output: typeof output === 'string' ? output : String(output || ''),
      metadata,
    };
  } catch (err) {
    // If the JSON parsing fails, check if this is a raw patch output
    // This handles cases where apply_patch output wasn't properly wrapped in JSON
    if (toolCallOutput.includes('*** Begin Patch') || 
        toolCallOutput.includes('*** Add File:') ||
        toolCallOutput.includes('Created ')) {
      return {
        output: toolCallOutput,
        metadata: {
          exit_code: 0,
          duration_seconds: 0,
        },
      };
    }

    // Default fallback
    return {
      output: `Failed to parse output: ${toolCallOutput.substring(0, 100)}${toolCallOutput.length > 100 ? '...' : ''}`,
      metadata: {
        exit_code: 1,
        duration_seconds: 0,
      },
    };
  }
}

export type CommandReviewDetails = {
  cmd: Array<string>;
  cmdReadableText: string;
};

/**
 * Tries to parse a tool call and, if successful, returns an object that has
 * both:
 * - an array of strings to use with `ExecInput` and `canAutoApprove()`
 * - a human-readable string to display to the user
 */
export function parseToolCall(
  toolCall: ResponseFunctionToolCall,
): CommandReviewDetails | undefined {
  const toolCallArgs = parseToolCallArguments(toolCall.arguments);
  if (toolCallArgs == null) {
    return undefined;
  }

  const { cmd } = toolCallArgs;
  const cmdReadableText = formatCommandForDisplay(cmd);

  return {
    cmd,
    cmdReadableText,
  };
}

/**
 * If toolCallArguments is a string of JSON that can be parsed into an object
 * with a "cmd" or "command" property that is an `Array<string>`, then returns
 * that array. Otherwise, returns undefined.
 */
export function parseToolCallArguments(
  toolCallArguments: string,
): ExecInput | undefined {
  let json: unknown;
  try {
    json = JSON.parse(toolCallArguments);
  } catch (err) {
    log(`Failed to parse toolCall.arguments: ${toolCallArguments}`);
    return undefined;
  }

  if (typeof json !== "object" || json == null) {
    return undefined;
  }

  const { cmd, command } = json as Record<string, unknown>;
  const commandArray = toStringArray(cmd) ?? toStringArray(command);
  if (commandArray == null) {
    return undefined;
  }

  // @ts-expect-error timeout and workdir may not exist on json.
  const { timeout, workdir } = json;
  return {
    cmd: commandArray,
    workdir: typeof workdir === "string" ? workdir : undefined,
    timeoutInMillis: typeof timeout === "number" ? timeout : undefined,
  };
}

function toStringArray(obj: unknown): Array<string> | undefined {
  if (Array.isArray(obj) && obj.every((item) => typeof item === "string")) {
    const arrayOfStrings: Array<string> = obj;
    return arrayOfStrings;
  } else {
    return undefined;
  }
}
