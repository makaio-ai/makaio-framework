import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeElectronServerInfrastructure,
  closeElectronServerInfrastructureAfterStartupFailure,
} from '../src/main/server-infrastructure-shutdown.js';

describe('closeElectronServerInfrastructure', () => {
  let server: HttpServer | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = null;
  });

  it('closes the HTTP server and propagates a Vite cleanup failure', async () => {
    const viteError = new Error('Vite close failed');
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));

    await expect(
      closeElectronServerInfrastructure({
        closeVite: async () => {
          throw viteError;
        },
        server,
      }),
    ).rejects.toBe(viteError);

    expect(server.listening).toBe(false);
  });

  it('reports a startup cleanup failure without rejecting', async () => {
    const viteError = new Error('Vite close failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));

    await expect(
      closeElectronServerInfrastructureAfterStartupFailure({
        closeVite: async () => {
          throw viteError;
        },
        server,
      }),
    ).resolves.toBeUndefined();

    expect(server.listening).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('[electron] Startup cleanup did not complete cleanly:', viteError);
  });
});
