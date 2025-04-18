import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaytonaSandboxProvider, execWithDaytona } from "../src/utils/agent/sandbox/daytona-cloud";
import { ExecResult } from "../src/utils/agent/sandbox/interface";

// Mock the Daytona SDK
vi.mock("@daytonaio/sdk", () => {
  const mockSandbox = {
    id: "mock-sandbox-id",
    getUserRootDir: vi.fn().mockResolvedValue("/home/daytona/workspace"),
    process: {
      executeCommand: vi.fn(),
      codeRun: vi.fn(),
    },
    fs: {
      createFolder: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      deleteFile: vi.fn(),
    },
  };

  const mockDaytona = {
    create: vi.fn().mockResolvedValue(mockSandbox),
    remove: vi.fn(),
  };

  return {
    Daytona: vi.fn(() => mockDaytona),
    SandboxTargetRegion: {
      US: "us",
      EU: "eu",
    },
  };
});

// Mock environment variables
vi.stubEnv("DAYTONA_API_KEY", "mock-api-key");

describe("DaytonaSandboxProvider", () => {
  let daytonaSandbox: DaytonaSandboxProvider;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Get singleton instance
    daytonaSandbox = DaytonaSandboxProvider.getInstance();
  });

  afterEach(async () => {
    await daytonaSandbox.cleanup();
  });

  it("should initialize the Daytona sandbox", async () => {
    await daytonaSandbox.initialize();
    
    // Check initialization
    expect(daytonaSandbox["initialized"]).toBe(true);
    expect(daytonaSandbox["sandbox"]).not.toBeNull();
    expect(daytonaSandbox["rootDir"]).toBe("/home/daytona/workspace");
  });

  it("should map paths correctly", async () => {
    await daytonaSandbox.initialize();
    
    // Test relative path
    const remotePath1 = daytonaSandbox.mapPath("test.js");
    expect(remotePath1).toBe("/home/daytona/workspace/test.js");
    
    // Test absolute path within home dir
    const homeDir = process.env.HOME || "/home/user";
    const remotePath2 = daytonaSandbox.mapPath(`${homeDir}/project/test.js`);
    expect(remotePath2).toBe("/home/daytona/workspace/project/test.js");
    
    // Test caching
    const remotePath3 = daytonaSandbox.mapPath("test.js");
    expect(remotePath3).toBe("/home/daytona/workspace/test.js");
  });

  it("should execute commands", async () => {
    await daytonaSandbox.initialize();
    
    // Mock execution response
    const mockResult = {
      result: "command output",
      stderr: "",
      exitCode: 0,
    };
    daytonaSandbox["sandbox"].process.executeCommand.mockResolvedValue(mockResult);
    
    // Execute command
    const result = await daytonaSandbox.exec(
      { cmd: ["echo", "hello"], workdir: undefined, timeoutInMillis: undefined },
      {},
    );
    
    // Check result
    expect(result).toEqual({
      stdout: "command output",
      stderr: "",
      exitCode: 0,
    });
    
    // Verify command was executed
    expect(daytonaSandbox["sandbox"].process.executeCommand).toHaveBeenCalledWith(
      "echo hello",
      "/home/daytona/workspace",
      undefined,
      undefined
    );
  });

  it("should handle errors during execution", async () => {
    await daytonaSandbox.initialize();
    
    // Mock execution error
    daytonaSandbox["sandbox"].process.executeCommand.mockRejectedValue(new Error("Command failed"));
    
    // Execute command
    const result = await daytonaSandbox.exec(
      { cmd: ["invalid", "command"], workdir: undefined, timeoutInMillis: undefined },
      {},
    );
    
    // Check result
    expect(result).toEqual({
      stdout: "",
      stderr: "Command failed",
      exitCode: 1,
    });
  });
});

describe("execWithDaytona", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should pass the command to DaytonaSandboxProvider", async () => {
    const mockExec = vi.spyOn(DaytonaSandboxProvider.prototype, "exec").mockResolvedValue({
      stdout: "test output",
      stderr: "",
      exitCode: 0,
    } as ExecResult);
    
    const result = await execWithDaytona(
      ["echo", "test"],
      { cwd: "/test", timeout: 5000 },
      [],
    );
    
    expect(result).toEqual({
      stdout: "test output",
      stderr: "",
      exitCode: 0,
    });
    
    expect(mockExec).toHaveBeenCalledWith(
      { cmd: ["echo", "test"], workdir: "/test", timeoutInMillis: 5000 },
      { cwd: "/test", timeout: 5000 },
      undefined,
    );
  });
});