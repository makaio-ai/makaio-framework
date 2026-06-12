/**
 * Unit tests for the stdio transport close lifecycle in {@link startMcpServer}.
 *
 * Verifies that the `onclose` callback receives exactly one signal regardless
 * of which termination path fires first (stdin EOF, stdin close, or explicit
 * handle.close()), and that handle.close() is idempotent.
 */
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBusInstance } from '@makaio/bus-core';
import { startMcpServer } from '../server.js';

let restoreStdin: (() => void) | undefined;

afterEach(() => {
  restoreStdin?.();
  restoreStdin = undefined;
  vi.restoreAllMocks();
});

/**
 * Replace process.stdin with an isolated PassThrough so listener counts
 * are not polluted by unrelated process-level stdin listeners.
 * @returns The stub stdin stream and a restore function.
 */
function stubStdin(): PassThrough {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stub = new PassThrough();
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stub,
  });
  restoreStdin = () => {
    if (originalDescriptor) {
      Object.defineProperty(process, 'stdin', originalDescriptor);
    }
  };
  return stub;
}

/**
 * Create a startMcpServer stdio handle with a stubbed StdioServerTransport
 * and a replaced process.stdin, returning the handle, the stub stdin, and
 * the collected onclose invocation count.
 * @returns The server handle, stub stdin, and a getter for the close call count.
 */
async function startServerWithStubs(): Promise<{
  handle: Awaited<ReturnType<typeof startMcpServer>>;
  stdin: PassThrough;
  closeCalls: () => number;
}> {
  const stdin = stubStdin();
  vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue(undefined);

  let closeCalls = 0;
  const handle = await startMcpServer(createBusInstance(), 'test-session', {
    transport: 'stdio',
    onclose: () => {
      closeCalls++;
    },
  });

  return { handle, stdin, closeCalls: () => closeCalls };
}

describe('startMcpServer stdio onclose lifecycle', () => {
  it('fires onclose exactly once when stdin emits end', async () => {
    const { stdin, closeCalls } = await startServerWithStubs();

    stdin.emit('end');

    // Allow the async server.close() chain to settle.
    await vi.waitFor(() => {
      expect(closeCalls()).toBe(1);
    });
  });

  it('fires onclose exactly once when stdin emits close', async () => {
    const { stdin, closeCalls } = await startServerWithStubs();

    stdin.emit('close');

    await vi.waitFor(() => {
      expect(closeCalls()).toBe(1);
    });
  });

  it('fires onclose exactly once when handle.close() is called explicitly', async () => {
    const { handle, closeCalls } = await startServerWithStubs();

    await handle.close();

    expect(closeCalls()).toBe(1);
  });

  it('does not double-fire onclose when stdin end and handle.close() both occur', async () => {
    const { handle, stdin, closeCalls } = await startServerWithStubs();

    stdin.emit('end');
    await handle.close();

    await vi.waitFor(() => {
      expect(closeCalls()).toBe(1);
    });

    // A brief wait to confirm no late second fire arrives.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(closeCalls()).toBe(1);
  });

  it('does not double-fire onclose when handle.close() is called twice', async () => {
    const { handle, closeCalls } = await startServerWithStubs();

    await handle.close();
    await handle.close();

    expect(closeCalls()).toBe(1);
  });

  it('does not fire onclose when no close event occurs', async () => {
    const { closeCalls } = await startServerWithStubs();

    // Brief idle — no close events emitted.
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(closeCalls()).toBe(0);
  });

  it('fires onclose even when teardown fails before the transport onclose hook runs', async () => {
    const { handle, stdin, closeCalls } = await startServerWithStubs();
    vi.spyOn(StdioServerTransport.prototype, 'close').mockRejectedValue(new Error('teardown failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    stdin.emit('end');

    await vi.waitFor(() => {
      expect(closeCalls()).toBe(1);
    });

    // The shared close promise stays rejected; explicit close surfaces it.
    await expect(handle.close()).rejects.toThrow('teardown failed');
    expect(closeCalls()).toBe(1);
  });
});
