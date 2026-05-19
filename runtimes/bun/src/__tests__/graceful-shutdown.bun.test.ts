import { describe, expect, it, vi } from 'bun:test';
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
});
