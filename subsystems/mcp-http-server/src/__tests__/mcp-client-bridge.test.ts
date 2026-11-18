/**
 * Integration tests for {@link startMcpClientBridge}.
 *
 * Spawns the real `test-mcp-server.ts` fixture via tsx so that the tests
 * exercise a genuine stdio MCP transport end-to-end rather than mocking
 * the SDK internals.
 *
 * Scenarios:
 * - Tool discovery: `tools` / `toolNames` reflect the server's initial tool list
 * - `tools` getter returns full {@link McpBridgedTool} objects (name, description, inputSchema)
 * - `callTool` proxies the call and returns the server's response
 * - `callTool` throws after `close` (closed-state guard)
 * - `close` tears down the transport and child process cleanly
 * - `onToolsChanged` is invoked when the server sends `tools/list_changed`
 * - `handle.tools` is live-updated when `onToolsChanged` fires
 * - A start cancelled through `signal` ends with the signal's reason and leaves no subprocess behind
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startMcpClientBridge, type McpClientBridgeHandle } from '../mcp-client-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/test-mcp-server.ts');

/**
 * Walk up from `startDir` looking for a bin script in `node_modules/.bin`,
 * mirroring Node's own resolution so hoisted workspace deps are found.
 * @param name - Bin script name to find.
 * @param startDir - Directory to start walking from.
 */
function resolveBin(name: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot find "${name}" in any ancestor node_modules/.bin of ${startDir}`);
    }
    dir = parent;
  }
}

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const TSX_BIN = resolveBin('tsx', PACKAGE_ROOT);
const MCP_FIXTURE_TIMEOUT_MS = 15_000;

/**
 * Start a bridge connected to the fixture MCP server.
 * @param onToolsChanged - Optional callback for tool-list change notifications.
 * @returns The connected bridge handle.
 */
async function startFixtureBridge(
  onToolsChanged?: (tools: { name: string }[]) => void,
): Promise<McpClientBridgeHandle> {
  return startMcpClientBridge({
    command: TSX_BIN,
    args: [FIXTURE_PATH],
    extensionName: 'test-extension',
    onToolsChanged,
    env: process.env as Record<string, string>,
  });
}

/**
 * Wait for a condition while guaranteeing both timers are cleared on success
 * and timeout.
 * @param condition - Poll predicate that resolves the wait once true.
 * @param timeoutMs - Maximum time to wait before rejecting.
 * @param intervalMs - Polling interval.
 * @param timeoutMessage - Error message used when the timeout elapses.
 * @returns Promise resolving once the condition is true.
 */
function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs: number,
  timeoutMessage: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timers: {
      deadline?: ReturnType<typeof setTimeout>;
      poll?: ReturnType<typeof setInterval>;
    } = {};

    const cleanup = (): void => {
      if (timers.deadline !== undefined) clearTimeout(timers.deadline);
      if (timers.poll !== undefined) clearInterval(timers.poll);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    timers.deadline = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
    }, timeoutMs);

    timers.poll = setInterval(() => {
      if (condition()) {
        finish(resolve);
      }
    }, intervalMs);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startMcpClientBridge', { timeout: MCP_FIXTURE_TIMEOUT_MS }, () => {
  let handle: McpClientBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close().catch(() => {
        // Ignore close errors in afterEach; the process may already be gone.
      });
      handle = undefined;
    }
  });

  // =========================================================================
  // Tool discovery
  // =========================================================================

  it('discovers tools from the MCP server on connect', async () => {
    handle = await startFixtureBridge();

    expect(handle.toolNames).toContain('echo');
    expect(handle.toolNames).toHaveLength(1);
  });

  it('toolNames is an array of strings', async () => {
    handle = await startFixtureBridge();

    expect(Array.isArray(handle.toolNames)).toBe(true);
    for (const name of handle.toolNames) {
      expect(typeof name).toBe('string');
    }
  });

  it('tools getter returns full McpBridgedTool descriptors', async () => {
    handle = await startFixtureBridge();

    expect(handle.tools).toHaveLength(1);
    const echo = handle.tools[0];
    expect(echo).toMatchObject({
      name: 'echo',
      description: expect.any(String),
      inputSchema: expect.any(Object),
    });
  });

  it('toolNames is derived from tools and stays consistent', async () => {
    handle = await startFixtureBridge();

    expect(handle.toolNames).toEqual(handle.tools.map((t) => t.name));
  });

  // =========================================================================
  // callTool
  // =========================================================================

  it('proxies callTool to the MCP server and returns the result', async () => {
    handle = await startFixtureBridge();

    const result = await handle.callTool('echo', { message: 'hello world' });

    expect(result).toHaveProperty('content');
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('returns isError when calling an unknown tool', async () => {
    handle = await startFixtureBridge();

    const result = await handle.callTool('nonexistent', {});

    expect(result).toHaveProperty('isError', true);
  });

  // =========================================================================
  // close
  // =========================================================================

  it('close resolves without error', async () => {
    handle = await startFixtureBridge();
    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined; // already closed — prevent afterEach double-close
  });

  it('close is idempotent — second call resolves without error', async () => {
    handle = await startFixtureBridge();
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined; // already closed — prevent afterEach double-close
  });

  it('callTool throws after close', async () => {
    handle = await startFixtureBridge();
    await handle.close();
    await expect(handle.callTool('echo', { message: 'hi' })).rejects.toThrow('MCP bridge is closed');
    handle = undefined; // already closed — prevent afterEach double-close
  });

  // =========================================================================
  // onToolsChanged
  // =========================================================================

  it('calls onToolsChanged when the server sends tools/list_changed', async () => {
    const toolChanges: string[][] = [];

    handle = await startFixtureBridge((tools) => {
      toolChanges.push(tools.map((t) => t.name));
    });

    expect(handle.toolNames).toEqual(['echo']);
    expect(toolChanges).toEqual([]);

    // Explicitly trigger the update after observing initial state; elapsed
    // time since connection does not establish that ordering under load.
    await handle.callTool('echo', { message: 'enable add', enableAddTool: true });
    await waitForCondition(() => toolChanges.length > 0, 4000, 50, 'Timed out waiting for onToolsChanged');

    const updatedNames = toolChanges[toolChanges.length - 1];
    expect(updatedNames).toEqual(['echo', 'add']);
  });

  it('handle.tools is live-updated after tools/list_changed', async () => {
    let notified = false;
    handle = await startFixtureBridge(() => {
      notified = true;
    });

    // Verify initial state: only echo
    expect(handle.tools.map((t) => t.name)).toEqual(['echo']);
    expect(notified).toBe(false);

    await handle.callTool('echo', { message: 'enable add', enableAddTool: true });
    await waitForCondition(() => notified, 4000, 50, 'Timed out waiting for handle.tools live update');

    // After notification: internal list must contain both tools.
    expect(handle.toolNames).toEqual(['echo', 'add']);
    expect(handle.tools.map((t) => t.name)).toEqual(handle.toolNames);
  });

  // =========================================================================
  // Bus integration
  // =========================================================================

  it('registers MCP tools on the bus and executes them through ToolSubjects', async () => {
    const bus = createBusInstance();
    handle = await startMcpClientBridge({
      command: TSX_BIN,
      args: [FIXTURE_PATH],
      extensionName: 'test-extension',
      env: process.env as Record<string, string>,
      bus,
    });

    const listed = await bus.request(ToolSubjects.list, {});
    expect(listed.toolsets).toContainEqual(
      expect.objectContaining({
        name: 'test-extension',
        version: '1.0.0',
        toolCount: 1,
      }),
    );
    expect(listed.tools).toContainEqual(
      expect.objectContaining({
        name: 'echo',
        description: expect.any(String),
        toolsetName: 'test-extension',
        inputSchema: expect.any(Object),
      }),
    );

    const result = await bus.request(ToolSubjects.execute, {
      toolName: 'echo',
      input: { message: 'hello bus' },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        content: [{ type: 'text', text: 'hello bus' }],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Start cancellation
// ---------------------------------------------------------------------------

/** Script of an MCP server that records its PID and then never answers the handshake. */
const SILENT_SERVER_SCRIPT = `
require('node:fs').appendFileSync(process.env.SILENT_SERVER_PID_FILE, process.pid + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Whether a process exists.
 * @param pid - Process ID.
 * @returns `true` when signal 0 can be delivered.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('startMcpClientBridge start cancellation', { timeout: MCP_FIXTURE_TIMEOUT_MS }, () => {
  const tempDirs: string[] = [];
  const spawnedPids: number[] = [];

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, which is what the tests want.
      }
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Prepare a PID file for the silent server.
   * @returns Path of the file the server appends its PID to, and a reader of the recorded PIDs.
   */
  function preparePidFile(): { readonly file: string; readonly pids: () => number[] } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-bridge-cancel-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'server.pids');
    writeFileSync(file, '');
    const pids = (): number[] =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(Number);
    return { file, pids };
  }

  /**
   * Start a bridge whose server never answers the handshake.
   * @param file - PID file the server appends its PID to.
   * @param signal - Cancels the start.
   * @returns The pending start.
   */
  function startSilentBridge(file: string, signal: AbortSignal): Promise<McpClientBridgeHandle> {
    return startMcpClientBridge({
      command: process.execPath,
      args: ['-e', SILENT_SERVER_SCRIPT],
      extensionName: 'silent-extension',
      env: { ...(process.env as Record<string, string>), SILENT_SERVER_PID_FILE: file },
      signal,
    });
  }

  it('ends a start that waits for the handshake with the signal reason and stops the subprocess', async () => {
    const { file, pids } = preparePidFile();
    const controller = new AbortController();
    const reason = new Error('boot cancelled');
    const starting = startSilentBridge(file, controller.signal);
    const rejected = expect(starting).rejects.toBe(reason);

    await vi.waitFor(() => expect(pids()).toHaveLength(1), { timeout: 10_000 });
    const [pid] = pids();
    spawnedPids.push(pid as number);
    expect(isAlive(pid as number)).toBe(true);
    const abortedAt = Date.now();
    controller.abort(reason);

    // Without the signal the handshake would wait for the SDK's 60 s request timeout.
    await rejected;
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    // The SDK closes the transport: stdin ends, then SIGTERM after its grace.
    await vi.waitFor(() => expect(isAlive(pid as number)).toBe(false), { timeout: 8_000 });
  });

  it('spawns nothing for a start that was cancelled before it began', async () => {
    const { file, pids } = preparePidFile();
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);

    await expect(startSilentBridge(file, controller.signal)).rejects.toBe(reason);

    appendFileSync(file, '');
    expect(pids()).toEqual([]);
  });
});
