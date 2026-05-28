import type { Server as HttpServer } from 'node:http';

/**
 * Bind a real HTTP server to a random loopback port and resolve once listening.
 *
 * The server must be created but not yet bound. An OS-assigned port on
 * `127.0.0.1` is used so tests never conflict on CI or local machines.
 * @param server - Unbound HTTP server to listen on.
 * @returns Port number selected by the OS.
 */
export async function listenOnLoopback(server: HttpServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to bind HTTP test server to a loopback port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Close a Node.js HTTP server, resolving after all connections have drained.
 * @param server - Listening HTTP server to close.
 */
export async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
