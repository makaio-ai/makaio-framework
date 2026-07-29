import type { Server as HttpServer } from 'node:http';

/** Resources owned by the Electron server composition root. */
export interface ElectronServerInfrastructure {
  /** Close the development Vite server, when one was started. */
  readonly closeVite: (() => Promise<void>) | null;
  /** In-process HTTP server used by the desktop host. */
  readonly server: HttpServer | null;
}

/**
 * Attempt every server-infrastructure cleanup and preserve all failures.
 * @param infrastructure - Server resources detached from the composition root.
 * @throws The sole cleanup failure, or an AggregateError when both cleanups fail.
 */
export async function closeElectronServerInfrastructure(infrastructure: ElectronServerInfrastructure): Promise<void> {
  const failures: unknown[] = [];

  if (infrastructure.closeVite) {
    try {
      await infrastructure.closeVite();
    } catch (error: unknown) {
      failures.push(error);
      console.warn('[electron] Vite close error:', error);
    }
  }

  const server = infrastructure.server;
  if (server?.listening) {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    } catch (error: unknown) {
      failures.push(error);
      console.warn('[electron] HTTP server close error:', error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Electron server infrastructure shutdown failed');
  }
}

/**
 * Close server infrastructure after startup has already failed.
 *
 * Cleanup remains observable, but it must not replace the causal startup error
 * or prevent Electron from displaying that error to the user.
 * @param infrastructure - Server resources detached from the composition root.
 */
export async function closeElectronServerInfrastructureAfterStartupFailure(
  infrastructure: ElectronServerInfrastructure,
): Promise<void> {
  try {
    await closeElectronServerInfrastructure(infrastructure);
  } catch (error: unknown) {
    console.error('[electron] Startup cleanup did not complete cleanly:', error);
  }
}
