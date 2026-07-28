/** Shared test helpers for the mcp-http-server integration tests. */

import * as http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';

/** A handler mounted on a throwaway `node:http` server. */
export interface MountedHandler {
  /** OS-assigned port the server is listening on. */
  port: number;
  /** Stop the server and drop keep-alive connections. */
  stop: () => Promise<void>;
}

/**
 * Create an MCP client connected to the given port.
 * @param port - HTTP port to connect to.
 * @param adapterSessionId - Optional adapter session ID passed as a query param.
 * @returns Connected client and transport.
 */
export async function createClient(
  port: number,
  adapterSessionId?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const url = adapterSessionId
    ? new URL(`http://127.0.0.1:${port}/?adapterSessionId=${encodeURIComponent(adapterSessionId)}`)
    : new URL(`http://127.0.0.1:${port}/`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

/**
 * Register a one-shot ToolSubjects.list handler returning an empty tool list.
 * @param bus - Bus instance to register on.
 * @returns Cleanup function that removes the handler.
 */
export function registerEmptyToolList(bus: IMakaioBus): () => void {
  return bus.on(ToolSubjects.list, (ctx) => {
    ctx.setResult({ tools: [], toolsets: [] });
  });
}

/**
 * Bind a `node:http` server to an OS-assigned loopback port.
 * @param httpServer - Server to listen with.
 * @returns Port and stop function.
 */
async function listenOnEphemeralPort(httpServer: http.Server): Promise<MountedHandler> {
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected address format'));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Mount a Node-style MCP handler on a throwaway `node:http` server.
 * @param handler - Request handler to mount at every path.
 * @returns Bound port and stop function.
 */
export async function mountHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<MountedHandler> {
  return listenOnEphemeralPort(http.createServer(handler));
}

/**
 * Mount a fetch-style MCP handler on a throwaway `node:http` server, bridging
 * the Node `IncomingMessage` / `ServerResponse` pair into Web Standard
 * `Request` / `Response`.
 * @param handler - Fetch-compatible handler to mount.
 * @returns Bound port and stop function.
 */
export async function mountFetchHandler(handler: (request: Request) => Promise<Response>): Promise<MountedHandler> {
  const httpServer = http.createServer(async (req, res) => {
    try {
      // Build the Web Standard Request from the Node IncomingMessage.
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          const values = Array.isArray(value) ? value : [value];
          for (const v of values) {
            headers.append(key, v);
          }
        }
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
      const bodyStream = hasBody
        ? new ReadableStream({
            start(controller) {
              req.on('data', (chunk: Buffer) => controller.enqueue(chunk));
              req.on('end', () => controller.close());
              req.on('error', (err) => controller.error(err));
            },
          })
        : undefined;

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: bodyStream,
        // @ts-expect-error -- Node 18+ supports duplex on Request but TS types lag behind
        duplex: bodyStream ? 'half' : undefined,
      });

      const response = await handler(request);

      // Write status and headers.
      const responseHeaders: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => {
        const existing = responseHeaders[k];
        if (existing !== undefined) {
          responseHeaders[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
        } else {
          responseHeaders[k] = v;
        }
      });
      res.writeHead(response.status, responseHeaders);

      // Stream body.
      if (response.body) {
        const reader = response.body.getReader();
        const pump = async (): Promise<void> => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        await pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end('Bridge error');
      }
    }
  });

  return listenOnEphemeralPort(httpServer);
}

/**
 * Create a manually opened gate for holding an async operation in flight.
 *
 * Tests use this to pin a mocked lifecycle step (server close, transport
 * start) open long enough to observe the window it creates, then release it
 * from the test body — including from `finally`, so an assertion failure
 * surfaces as itself rather than as a hang.
 * @returns The gate promise and the function that opens it.
 */
export function createGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
