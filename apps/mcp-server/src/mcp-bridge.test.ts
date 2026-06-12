import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBusInstance } from '@makaio/bus-core';
import { startMcpBridge } from './mcp-bridge.js';

let restoreStdin: (() => void) | undefined;

type StdioStartImplementation = () => Promise<void>;

afterEach(() => {
  restoreStdin?.();
  restoreStdin = undefined;
  vi.restoreAllMocks();
});

/**
 * Create a bridge test fixture with an isolated stdin stream.
 * @param startImplementation - Mocked stdio transport start implementation.
 * @returns Bus, stdin stub, and mocked stdio transport startup.
 */
function setupBridgeFixture(startImplementation: StdioStartImplementation = async () => undefined) {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdin = new PassThrough();
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stdin,
  });
  restoreStdin = () => {
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  };

  return {
    bus: createBusInstance(),
    stdin,
    startSpy: vi.spyOn(StdioServerTransport.prototype, 'start').mockImplementation(startImplementation),
  };
}

describe('startMcpBridge', () => {
  it('resolves immediately when signal is already aborted', async () => {
    const { bus, startSpy } = setupBridgeFixture();

    const controller = new AbortController();
    controller.abort();

    await expect(startMcpBridge(bus, { signal: controller.signal })).resolves.toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('resolves when abort signal fires after bridge start', async () => {
    const { bus } = setupBridgeFixture();

    const controller = new AbortController();
    const bridgePromise = startMcpBridge(bus, { signal: controller.signal });

    // Abort after the bridge is running
    controller.abort();

    await expect(bridgePromise).resolves.toBeUndefined();
  });

  it('rejects when abort-triggered close fails', async () => {
    const { bus } = setupBridgeFixture();
    const closeError = new Error('close failed');
    vi.spyOn(Server.prototype, 'close').mockRejectedValue(closeError);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = new AbortController();
    const bridgePromise = startMcpBridge(bus, { signal: controller.signal });

    await vi.waitFor(() => {
      expect(StdioServerTransport.prototype.start).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(bridgePromise).rejects.toThrow('close failed');
  });

  it('resolves when stdin emits close', async () => {
    const { bus, stdin } = setupBridgeFixture();

    const bridgePromise = startMcpBridge(bus);

    // The fixture replaces process.stdin so listener counts only reflect the
    // bridge under test, not unrelated process-global stdin listeners.
    await vi.waitFor(() => {
      expect(stdin.listenerCount('close')).toBeGreaterThan(0);
    });

    stdin.emit('close');

    await expect(bridgePromise).resolves.toBeUndefined();
  });

  it('resolves when stdin emits end', async () => {
    const { bus, stdin } = setupBridgeFixture();

    const bridgePromise = startMcpBridge(bus);

    // Wait until bridge termination listeners are registered.
    await vi.waitFor(() => {
      expect(stdin.listenerCount('end')).toBeGreaterThan(0);
    });

    stdin.emit('end');

    await expect(bridgePromise).resolves.toBeUndefined();
  });

  it('resolves without starting when stdin is already ended', async () => {
    const { bus, stdin, startSpy } = setupBridgeFixture();
    Object.defineProperty(stdin, 'readableEnded', {
      configurable: true,
      value: true,
    });

    const bridgePromise = startMcpBridge(bus);

    await expect(bridgePromise).resolves.toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('resolves when stdin ends while the stdio transport is starting', async () => {
    let resolveStart: (() => void) | undefined;
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const { bus, stdin, startSpy } = setupBridgeFixture(() => startPromise);

    const bridgePromise = startMcpBridge(bus);

    await vi.waitFor(() => {
      expect(startSpy).toHaveBeenCalledOnce();
    });
    Object.defineProperty(stdin, 'readableEnded', {
      configurable: true,
      value: true,
    });
    resolveStart?.();

    await expect(bridgePromise).resolves.toBeUndefined();
  });

  it('accepts a custom sessionId without throwing', async () => {
    const { bus } = setupBridgeFixture();

    const controller = new AbortController();
    const bridgePromise = startMcpBridge(bus, {
      sessionId: 'custom-session-id',
      signal: controller.signal,
    });

    controller.abort();

    await expect(bridgePromise).resolves.toBeUndefined();
  });
});
