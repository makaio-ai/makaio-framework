import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown, type BunServer } from '../index.js';

describe('createGracefulShutdown', () => {
  it('shuts down runtime and force-closes active Bun connections before exiting', async () => {
    const shutdown = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const exit = vi.fn((_code: number): never => undefined as never);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const handler = createGracefulShutdown({
        label: 'server',
        runtime: { shutdown, stopBudgetMs: () => 0 },
        bunServer: { port: 3000, hostname: '127.0.0.1', stop } satisfies BunServer,
        exit,
      });

      await handler('SIGTERM');

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(true);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      info.mockRestore();
    }
  });

  it('exits non-zero when the runtime could not tear down cleanly', async () => {
    const shutdown = vi.fn(async () => {
      throw new AggregateError([new Error('a resource stayed open')], 'shutdown reported failures');
    });
    const stop = vi.fn(async () => undefined);
    const exit = vi.fn((_code: number): never => undefined as never);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const handler = createGracefulShutdown({
        label: 'server',
        runtime: { shutdown, stopBudgetMs: () => 0 },
        bunServer: { port: 3000, hostname: '127.0.0.1', stop } satisfies BunServer,
        exit,
      });

      await handler('SIGTERM');

      // The listener is still closed — the process is going away either way —
      // but the exit status must not report a drain that did not complete.
      expect(stop).toHaveBeenCalledWith(true);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  describe('force-exit deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /**
     * Start a shutdown whose runtime settles after a given time.
     * @param stopBudgetMs - Bound the runtime reports.
     * @param shutdownMs - Time the runtime's shutdown takes.
     * @param timeoutMs - Explicit override of the deadline.
     * @returns The exit hook and the handler's promise.
     */
    function startShutdown(
      stopBudgetMs: number,
      shutdownMs: number,
      timeoutMs?: number,
    ): { readonly exit: ReturnType<typeof vi.fn>; readonly done: Promise<void> } {
      vi.useFakeTimers();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.fn((_code: number): never => undefined as never);
      const handler = createGracefulShutdown({
        label: 'server',
        runtime: {
          shutdown: () => new Promise<void>((resolve) => setTimeout(resolve, shutdownMs)),
          stopBudgetMs: () => stopBudgetMs,
        },
        bunServer: { port: 3000, hostname: '127.0.0.1', stop: () => undefined } satisfies BunServer,
        exit,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return { exit, done: handler('SIGTERM') };
    }

    it('follows the runtime bound: a 12 s runtime is not cut off at 10 s', async () => {
      const { exit, done } = startShutdown(12_000, 12_500);

      await vi.advanceTimersByTimeAsync(10_001);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      await done;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('forces the exit once the runtime bound and its headroom have passed', async () => {
      const { exit } = startShutdown(12_000, 2 ** 31 - 1);

      await vi.advanceTimersByTimeAsync(12_999);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('lets an explicit timeout override the runtime bound', async () => {
      const { exit } = startShutdown(12_000, 2 ** 31 - 1, 500);

      await vi.advanceTimersByTimeAsync(501);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
