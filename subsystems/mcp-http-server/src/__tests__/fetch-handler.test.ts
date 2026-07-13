/**
 * Integration tests for {@link createFetchMcpHandler}.
 *
 * Exercises the fetch-style handler as an external consumer would: constructs
 * Web Standard `Request` objects, calls the handler directly, and asserts on
 * the returned `Response`. For full MCP round-trips that require streaming,
 * the handler is mounted behind a thin `node:http` server so the MCP SDK
 * client can perform real protocol exchanges.
 *
 * Scenarios covered:
 * - Handler creation returns `handler`, `contextRegistry`, and `close`
 * - close() is idempotent (two awaited calls, no throw)
 * - Real MCP round-trip (initialize → tools/list) via a consumer-owned server
 * - POST requests return valid JSON-RPC responses with proper content-type
 * - adapterSessionId query-param shim promotes param to x-adapter-session-id
 *   header (observable via resolveContextOverrides)
 * - Handler returns 500 Response on internal errors (does not throw)
 * - GET to the handler returns a response (SSE stream or appropriate status)
 * - onclose fires exactly once after handle.close()
 */

import * as http from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import type { ToolExecutionContextOverrides } from '@makaio/contracts';
import { createFetchMcpHandler } from '../fetch-handler.js';
import { createClient, registerEmptyToolList } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mount a fetch-style handler behind a plain `node:http` server, bridging
 * the Node `IncomingMessage` / `ServerResponse` pair into Web Standard
 * `Request` / `Response`.
 * @param handler - Fetch-compatible handler to mount.
 * @returns Object with the bound port and a stop function.
 */
async function mountFetchHandler(
  handler: (request: Request) => Promise<Response>,
): Promise<{ port: number; stop: () => Promise<void> }> {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFetchMcpHandler', () => {
  /**
   * Track handles created per test so we can always clean up in afterEach
   * even when a test assertion fails before the explicit close.
   */
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => undefined);
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Handler creation and lifecycle
  // -------------------------------------------------------------------------

  it('returns an object with handler, contextRegistry, and close', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    expect(handle).toHaveProperty('handler');
    expect(handle).toHaveProperty('contextRegistry');
    expect(handle).toHaveProperty('close');
    expect(typeof handle.handler).toBe('function');
    expect(typeof handle.close).toBe('function');
  });

  it('close() is idempotent — two awaited calls do not throw', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      cleanup();
    });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('fires onclose exactly once after handle.close()', async () => {
    const bus = createBusInstance();
    const onclose = vi.fn();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus, { onclose });
    cleanups.push(async () => {
      cleanup();
    });

    await handle.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('forwards a configured tool execution timeout to tool execution', async () => {
    const bus = createBusInstance();
    const requestOptional = vi.spyOn(bus, 'requestOptional');
    const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [{ name: 'echo', description: 'Echo', toolsetName: 'test', inputSchema: { type: 'object' } }],
        toolsets: [],
      });
    });
    const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: ctx.payload.input });
    });
    const handle = await createFetchMcpHandler(bus, { toolExecutionTimeoutMs: 180_000 });
    const { port, stop } = await mountFetchHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
      cleanupExecute();
      cleanupList();
    });

    const { client, transport } = await createClient(port);
    try {
      await client.callTool({ name: 'echo', arguments: { value: 'ok' } });
    } finally {
      await client.close();
      await transport.close();
    }

    expect(requestOptional).toHaveBeenCalledWith(ToolSubjects.execute, expect.objectContaining({ toolName: 'echo' }), {
      timeout: 180_000,
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid tool execution timeout %s', async (timeout) => {
    await expect(createFetchMcpHandler(createBusInstance(), { toolExecutionTimeoutMs: timeout })).rejects.toThrow(
      'toolExecutionTimeoutMs must be a positive safe integer',
    );
  });

  it('releases registry subscriptions when transport startup fails', async () => {
    const bus = createBusInstance();
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(
      new Error('fetch startup failed'),
    );
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();

    await expect(createFetchMcpHandler(bus)).rejects.toThrow('fetch startup failed');
    await bus.emit(ToolSubjects.registryChanged, {
      revision: 1,
      reason: 'toolset-registered',
      toolsetName: 'after-failed-fetch-start',
    });

    expect(sendToolListChanged).not.toHaveBeenCalled();
  });

  it('preserves startup and cleanup failures as an AggregateError', async () => {
    const startupError = new Error('fetch startup failed');
    const cleanupError = new Error('fetch cleanup failed');
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(startupError);
    vi.spyOn(Server.prototype, 'close').mockRejectedValue(cleanupError);

    await expect(createFetchMcpHandler(createBusInstance())).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors[0] === startupError &&
        error.errors[1] === cleanupError &&
        error.message === 'Failed to start and clean up fetch MCP handler'
      );
    });
  });

  // -------------------------------------------------------------------------
  // MCP protocol roundtrip via fetch handler
  // -------------------------------------------------------------------------

  it('returns a handler that serves real MCP round-trips via a consumer-owned http.Server', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    const { port, stop } = await mountFetchHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
      cleanup();
    });

    const { client, transport } = await createClient(port);
    try {
      const result = await client.listTools();
      // The empty discovered tool list plus the built-in approve tool from the context registry.
      expect(result.tools.map((tool) => tool.name)).toEqual(['approve']);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('responds to POST requests with JSON-RPC responses and proper content-type', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    const initRequest = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    const response = await handle.handler(initRequest);

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type');
    expect(contentType).toBeDefined();
    // The transport may respond with JSON or SSE depending on the protocol version.
    // Either is valid for an initialize response.
    expect(contentType!.includes('application/json') || contentType!.includes('text/event-stream')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // adapterSessionId query param shim
  // -------------------------------------------------------------------------

  it('maps adapterSessionId query param to x-adapter-session-id header before dispatch', async () => {
    const bus = createBusInstance();

    /**
     * Capture the adapterSessionId resolved by the context override callback
     * to verify the shim promoted it from query param to header.
     */
    const capturedSessionIds: Array<string | undefined> = [];

    const handle = await createFetchMcpHandler(bus, {
      resolveContextOverrides: (id): ToolExecutionContextOverrides | undefined => {
        capturedSessionIds.push(id);
        return undefined;
      },
      toolDiscovery: undefined,
    });

    // Register a ping tool so we can issue a tools/call that reaches
    // resolveContextOverrides.
    const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [
          {
            name: 'ping',
            description: 'Ping tool',
            toolsetName: 'test',
            inputSchema: { type: 'object' },
          },
        ],
        toolsets: [],
      });
    });
    const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: {} });
    });

    const { port, stop } = await mountFetchHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
      cleanupList();
      cleanupExecute();
    });

    const targetSessionId = 'fetch-shim-test-session-abc';
    const { client, transport } = await createClient(port, targetSessionId);
    try {
      await client.callTool({ name: 'ping', arguments: {} });
    } finally {
      await client.close();
      await transport.close();
    }

    // resolveContextOverrides must have been called with the session ID that
    // arrived via the query-param-to-header shim.
    expect(capturedSessionIds).toContain(targetSessionId);
  });

  it('passes request through unchanged when no adapterSessionId query param is present', async () => {
    const bus = createBusInstance();

    const capturedSessionIds: Array<string | undefined> = [];

    const handle = await createFetchMcpHandler(bus, {
      resolveContextOverrides: (id): ToolExecutionContextOverrides | undefined => {
        capturedSessionIds.push(id);
        return undefined;
      },
      toolDiscovery: undefined,
    });

    const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({
        tools: [
          {
            name: 'ping',
            description: 'Ping tool',
            toolsetName: 'test',
            inputSchema: { type: 'object' },
          },
        ],
        toolsets: [],
      });
    });
    const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: {} });
    });

    const { port, stop } = await mountFetchHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
      cleanupList();
      cleanupExecute();
    });

    // Connect without adapterSessionId
    const { client, transport } = await createClient(port);
    try {
      await client.callTool({ name: 'ping', arguments: {} });
    } finally {
      await client.close();
      await transport.close();
    }

    // resolveContextOverrides should have been called but with undefined
    // since no adapterSessionId query param was provided.
    expect(capturedSessionIds.length).toBeGreaterThan(0);
    expect(capturedSessionIds).toContain(undefined);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns a 500 Response when the transport throws (does not throw)', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    // Close the handle first so the transport is torn down, then send a
    // request. The closed transport should cause an error that the handler
    // catches and converts to a 500 Response.
    await handle.close();

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    // The handler must NOT throw — it should return a Response.
    const response = await handle.handler(request);
    // Expect either a 500 (caught error) or a 400-range status (transport
    // rejects after close). Either way, it must not throw.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // -------------------------------------------------------------------------
  // GET requests (SSE)
  // -------------------------------------------------------------------------

  it('returns a response for GET requests', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    const request = new Request('http://localhost/mcp', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });

    const response = await handle.handler(request);

    // GET without a valid MCP session should be rejected by the transport
    // (the transport requires an initialize handshake before accepting a GET
    // for SSE). The response should be an error status, not a throw.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // -------------------------------------------------------------------------
  // Context registry
  // -------------------------------------------------------------------------

  it('exposes a contextRegistry that can register and retrieve agent context', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    handle.contextRegistry.register('ctx-session', {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'adapter-one',
      adapterSessionId: 'ctx-session',
      sessionId: 'session-1',
    });

    const entry = handle.contextRegistry.get('ctx-session');
    expect(entry?.agentId).toBe('agent-1');

    handle.contextRegistry.unregister('ctx-session');
    expect(handle.contextRegistry.get('ctx-session')).toBeUndefined();
  });
});
