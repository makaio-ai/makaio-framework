import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

/**
 * Start a real TLS ingress that forwards upgrades to the cleartext backend.
 * @param directory - Test certificate directory.
 * @param host - Non-loopback address on which to accept TLS clients.
 * @param target - Loopback address and port of the exchange listener.
 * @param verified - Whether the ingress holds the backend's test proof.
 * @returns The bound port and a disposer for both sides of the tunnel.
 */
export async function startExchangeIngress(
  directory: string,
  host: string,
  target: { readonly host: string; readonly port: number },
  verified: boolean,
) {
  const [key, cert] = await Promise.all([readFile(join(directory, 'key.pem')), readFile(join(directory, 'cert.pem'))]);
  const server = createServer({ key, cert }, (_request, response) => response.writeHead(404).end());
  const sockets = new Set<Socket | Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const backend = createConnection(target);
    sockets.add(backend);
    socket.on('error', () => backend.destroy());
    socket.once('close', () => backend.destroy());
    backend.on('error', () => socket.destroy());
    backend.once('close', () => sockets.delete(backend));
    backend.once('connect', () => {
      const authorization = verified ? 'x-test-ingress-proof: verified\r\n' : '';
      const forwarded = Object.entries(request.headers)
        .filter(([name]) => name !== 'x-test-ingress-proof')
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      backend.write(`GET ${request.url} HTTP/1.1\r\n${forwarded}${authorization}\r\n`);
      if (head.length > 0) backend.write(head);
      socket.pipe(backend).pipe(socket);
    });
  });
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test ingress did not bind a TCP port');
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
