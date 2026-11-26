import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { waitForServerListening } from './http-server-utils.js';
import {
  WorkerExchangeListenerConfigurationError,
  type SingleHostWorkerExchangeOptions,
  type WorkerExchangeListener,
} from './worker-exchange-listener.js';

/**
 * Open the exchange-only listener for the Node transport.
 * @param options - Validated bind and protection configuration.
 * @returns The listening server and its boot lifecycle.
 */
export async function listenForNodeWorkerExchange({
  listen,
  security,
}: SingleHostWorkerExchangeOptions): Promise<WorkerExchangeListener & { readonly server: HttpServer }> {
  let server: HttpServer;
  try {
    server = security.kind === 'tls' ? createHttpsServer({ key: security.key, cert: security.cert }) : createServer();
  } catch {
    throw new WorkerExchangeListenerConfigurationError('invalid-tls');
  }
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (_req, res) => res.writeHead(404).end());
  try {
    server.listen(listen.port, listen.host);
    await waitForServerListening(server, listen.port, () => console.error('[worker-exchange] Listener error'));
  } catch {
    throw new WorkerExchangeListenerConfigurationError('listen-failed');
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new WorkerExchangeListenerConfigurationError('listen-failed');
  }
  return {
    server,
    address: { port: address.port, host: address.address },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
