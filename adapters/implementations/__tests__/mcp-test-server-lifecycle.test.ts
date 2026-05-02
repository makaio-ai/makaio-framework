import { describe, expect, it, vi } from 'vitest';
import type { HttpMcpServerHandle } from '@makaio/mcp-http-server';
import { createMcpTestServerLifecycle } from './mcp-test-server-lifecycle.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createHandle(port: number): HttpMcpServerHandle {
  return {
    port,
    contextRegistry: {
      register: vi.fn(),
      get: vi.fn(),
      unregister: vi.fn(),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a deferred promise for deterministic lifecycle race tests.
 * @returns Deferred promise controls.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createMcpTestServerLifecycle', () => {
  it('retries startup after an initial failure instead of caching the rejected promise', async () => {
    const firstError = new Error('bind failed');
    const handle = createHandle(4100);
    const startServer = vi
      .fn<() => Promise<HttpMcpServerHandle>>()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(handle);
    const lifecycle = createMcpTestServerLifecycle(startServer);

    await expect(lifecycle.ensureStarted()).rejects.toThrow(firstError);
    expect(lifecycle.getHandle()).toBeNull();

    await expect(lifecycle.ensureStarted()).resolves.toBe(handle);
    expect(startServer).toHaveBeenCalledTimes(2);
    expect(lifecycle.getHandle()).toBe(handle);
  });

  it('coalesces concurrent starts and closes the shared handle from async teardown', async () => {
    const handle = createHandle(4200);
    const startServer = vi.fn<() => Promise<HttpMcpServerHandle>>().mockResolvedValue(handle);
    const lifecycle = createMcpTestServerLifecycle(startServer);

    const [first, second] = await Promise.all([lifecycle.ensureStarted(), lifecycle.ensureStarted()]);

    expect(first).toBe(handle);
    expect(second).toBe(handle);
    expect(startServer).toHaveBeenCalledTimes(1);

    await lifecycle.close();

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.getHandle()).toBeNull();
  });

  it('closes a late-started server instead of leaking it when teardown wins the startup race', async () => {
    const pendingStart = createDeferred<HttpMcpServerHandle>();
    const lateHandle = createHandle(4300);
    const startServer = vi.fn<() => Promise<HttpMcpServerHandle>>().mockImplementation(() => pendingStart.promise);
    const lifecycle = createMcpTestServerLifecycle(startServer);

    const startup = lifecycle.ensureStarted();
    const closePromise = lifecycle.close();

    pendingStart.resolve(lateHandle);

    await expect(startup).rejects.toThrow(/closed during startup/);
    await closePromise;

    expect(lateHandle.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.getHandle()).toBeNull();
  });
});
