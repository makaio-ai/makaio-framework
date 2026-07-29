import { describe, expect, it, vi } from 'vitest';
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
        runtime: { shutdown },
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
        runtime: { shutdown },
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
});
