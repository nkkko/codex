import type { ExecInput, ExecResult } from "./sandbox/interface.js";
import type { SpawnOptions } from "child_process";

import { process_patch } from "./apply-patch.js";
import { SandboxType } from "./sandbox/interface.js";
import { execWithSeatbelt } from "./sandbox/macos-seatbelt.js";
import { execWithDaytona, DaytonaSandboxProvider } from "./sandbox/daytona-cloud.js";
import { exec as rawExec } from "./sandbox/raw-exec.js";
import { getSandboxType } from "../session.js";
import { formatCommandForDisplay } from "../../format-command.js";
import fs from "fs";
import os from "os";

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 */
export function exec(
  { cmd, workdir, timeoutInMillis }: ExecInput,
  sandbox: SandboxType,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  // This is a temporary measure to understand what are the common base commands
  // until we start persisting and uploading rollouts

  const execForSandbox =
    sandbox === SandboxType.MACOS_SEATBELT ? execWithSeatbelt :
    sandbox === SandboxType.DAYTONA ? execWithDaytona : rawExec;

  const opts: SpawnOptions = {
    timeout: timeoutInMillis || DEFAULT_TIMEOUT_MS,
    ...(workdir ? { cwd: workdir } : {}),
  };
  const writableRoots = [process.cwd(), os.tmpdir()];
  return execForSandbox(cmd, opts, writableRoots, abortSignal);
}

export function execApplyPatch(patchText: string, sandbox?: SandboxType): Promise<ExecResult> {
  // This is a temporary measure to understand what are the common base commands
  // until we start persisting and uploading rollouts

  // If sandbox not explicitly specified, use the configured/default one
  const sandboxType = sandbox || getSandboxType();

  // For Daytona sandbox, use the Daytona provider
  if (sandboxType === SandboxType.DAYTONA) {
    const daytonaSandbox = DaytonaSandboxProvider.getInstance();
    // For Daytona, we need a special wrapper to make sure the response can be properly parsed
    return daytonaSandbox.applyPatch(patchText).then(result => {
      // Wrap the output in a JSON string that can be parsed by `parseToolCallOutput`
      // This is needed to work around the error "Cannot read properties of undefined (reading 'split')"
      // Set a non-empty string output to ensure it can be split later in the processing chain
      const wrappedOutput = JSON.stringify({
        output: result.stdout || patchText || "Patch applied successfully",
        metadata: {
          exit_code: result.exitCode,
          duration_seconds: 0
        }
      });
      
      return {
        stdout: wrappedOutput,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    });
  }

  // For other sandboxes, use the original implementation
  try {
    const result = process_patch(
      patchText,
      (p) => fs.readFileSync(p, "utf8"),
      (p, c) => fs.writeFileSync(p, c, "utf8"),
      (p) => fs.unlinkSync(p),
    );
    // Wrap the output in a JSON string that can be parsed by `parseToolCallOutput`
    const wrappedOutput = JSON.stringify({
      output: result,
      metadata: {
        exit_code: 0,
        duration_seconds: 0
      }
    });
    return Promise.resolve({
      stdout: wrappedOutput,
      stderr: "",
      exitCode: 0,
    });
  } catch (error: unknown) {
    // @ts-expect-error error might not be an object or have a message property.
    const stderr = String(error.message ?? error);
    // Wrap the error in a JSON string that can be parsed by `parseToolCallOutput`
    const wrappedOutput = JSON.stringify({
      output: "Error applying patch",
      metadata: {
        exit_code: 1,
        duration_seconds: 0,
        error: stderr
      }
    });
    return Promise.resolve({
      stdout: wrappedOutput,
      stderr: stderr,
      exitCode: 1,
    });
  }
}

export function getBaseCmd(cmd: Array<string>): string {
  const formattedCommand = formatCommandForDisplay(cmd);
  return formattedCommand.split(" ")[0] || cmd[0] || "<unknown>";
}
