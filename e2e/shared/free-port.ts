/**
 * Shared TCP port helpers for E2E host processes.
 */

import { createServer } from 'node:net';

/**
 * Resolve a currently free loopback TCP port for a spawned E2E process.
 *
 * This helper intentionally closes the probe server and returns the selected
 * port because the desktop hosts under test own their own listener lifecycle.
 * The caller pairs it with retrying readiness checks to absorb the small race
 * window that is acceptable for isolated E2E processes.
 * @returns Port number selected by the OS.
 */
export async function resolveFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  if (typeof address !== 'object' || address === null) {
    throw new Error('[e2e] Failed to resolve a free loopback port');
  }

  return address.port;
}
