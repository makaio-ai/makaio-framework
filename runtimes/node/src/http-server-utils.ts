import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Wait until an HTTP server emits `listening` or fails with an error.
 *
 * Fast-exits if the server is already bound. Attaches a persistent error
 * handler after binding to prevent unhandled rejections from post-bind errors.
 * @param server - HTTP server to observe.
 * @param port - Configured port, used in the EADDRINUSE error message.
 */
export async function waitForServerListening(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (server.address()) {
      resolve();
      return;
    }

    const handleError = (err: Error): void => {
      cleanup();
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`));
        return;
      }
      reject(err);
    };
    const handleListening = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      server.off('error', handleError);
      server.off('listening', handleListening);
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
  });

  // Deliberately leaked: one persistent error handler per server prevents
  // unhandled rejection crashes from post-bind errors (e.g., ECONNRESET).
  // Each composition root calls this once per HTTP server, so no accumulation.
  server.on('error', (err: Error) => {
    console.error('[HttpServer] Post-bind error:', err);
  });
}

/**
 * Resolve the bound TCP port from an HTTP server that is already listening.
 * @param server - HTTP server instance.
 * @returns Numeric TCP port.
 */
export function resolveListeningPort(server: HttpServer): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null && 'port' in address) {
    return (address as AddressInfo).port;
  }
  throw new Error('HTTP server is not bound to a TCP address');
}
