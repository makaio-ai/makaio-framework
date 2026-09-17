/**
 * Real `node:http` mock upstream used by the gateway route tests.
 *
 * Shared by every suite that needs a live upstream rather than a stubbed
 * `fetch`, so the tests exercise real sockets, real streaming, and the real
 * response objects the router forwards.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Captured state from one upstream request. */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Handle + cleanup for a running mock HTTP server. */
export interface MockServer {
  port: number;
  /** Most recently received request, refreshed on each incoming request. */
  lastRequest: CapturedRequest | null;
  /**
   * Discard the captured request.
   *
   * Called before every request sent through a shared server so an assertion
   * cannot silently pass against a capture left behind by an earlier test.
   */
  clearLastRequest: () => void;
  close: () => Promise<void>;
}

/**
 * Start a mock HTTP server that captures incoming requests and returns the
 * provided response to each one.
 * @param getResponse - Called for each request; returns response configuration.
 * @returns Running server with its port and a close helper.
 */
export function startMockServer(
  getResponse: (req: http.IncomingMessage) => {
    status: number;
    headers: Record<string, string>;
    body: string | ((res: http.ServerResponse) => void);
  },
): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    let lastRequest: CapturedRequest | null = null;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        };
        const { status, headers, body } = getResponse(req);
        res.writeHead(status, headers);
        if (typeof body === 'function') {
          body(res);
        } else {
          res.end(body);
        }
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        get lastRequest() {
          return lastRequest;
        },
        clearLastRequest: () => {
          lastRequest = null;
        },
        close: () => {
          server.closeAllConnections();
          return new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
        },
      });
    });
  });
}
