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
 * - Session startup failure answers 500 without leaking a bus subscription
 * - A closed endpoint refuses new sessions with 503 rather than throwing
 * - A GET without an MCP session ID is refused with 400
 * - onclose fires exactly once after handle.close()
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import type { ToolExecutionContextOverrides } from '@makaio/contracts';
import { createFetchMcpHandler } from '../fetch-handler.js';
import { McpTransportRegistry } from '../mcp-transport-registry.js';
import { createClient, mountFetchHandler, registerEmptyToolList } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Message the handler logs when a request could not open an MCP client session. */
const LOG_SESSION_CREATE_FAILED = '[MCP Server] Failed to create an MCP client session:';

/**
 * Build a well-formed MCP `initialize` POST request.
 * @returns A request that opens a new MCP protocol session.
 */
function makeInitializeRequest(): Request {
  return new Request('http://localhost/mcp', {
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid idleTimeoutMs %s', async (idleTimeoutMs) => {
    await expect(createFetchMcpHandler(createBusInstance(), { idleTimeoutMs })).rejects.toThrow(
      'idleTimeoutMs must be a positive finite number of milliseconds',
    );
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid sweepIntervalMs %s', async (sweepIntervalMs) => {
    await expect(createFetchMcpHandler(createBusInstance(), { sweepIntervalMs })).rejects.toThrow(
      'sweepIntervalMs must be a positive finite number of milliseconds',
    );
  });

  it('rejects a sweepIntervalMs beyond the timer ceiling', async () => {
    // Only the sweep interval is handed to a timer, so only it carries the
    // 32-bit delay ceiling on top of the shared positive-finite contract.
    await expect(createFetchMcpHandler(createBusInstance(), { sweepIntervalMs: 2_147_483_648 })).rejects.toThrow(
      'sweepIntervalMs must be no greater than 2147483647 milliseconds',
    );
  });

  it('answers a JSON-RPC 500 rather than throwing when routing itself fails', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(McpTransportRegistry.prototype, 'route').mockRejectedValue(new Error('routing exploded'));

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    // A fetch host has no second error surface the way the Node handler's
    // `void dispatch(...).catch(...)` does: anything escaping this handler
    // reaches the runtime as an unhandled rejection and is answered with its
    // own opaque 500 instead of an MCP-shaped envelope.
    const response = await handle.handler(makeInitializeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603 } });
  });

  it('answers 500 and releases registry subscriptions when session startup fails', async () => {
    const bus = createBusInstance();
    // Sessions are built on the first request, so transport startup failure now
    // surfaces on that request rather than at handler creation.
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(
      new Error('fetch startup failed'),
    );
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(() => handle.close());

    const response = await handle.handler(makeInitializeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603 } });

    await bus.emit(ToolSubjects.registryChanged, {
      revision: 1,
      reason: 'toolset-registered',
      toolsetName: 'after-failed-fetch-start',
    });

    expect(sendToolListChanged).not.toHaveBeenCalled();
  });

  it('preserves session startup and cleanup failures as an AggregateError', async () => {
    const startupError = new Error('fetch startup failed');
    const cleanupError = new Error('fetch cleanup failed');
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(startupError);
    vi.spyOn(Server.prototype, 'close').mockRejectedValue(cleanupError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handle = await createFetchMcpHandler(createBusInstance());
    cleanups.push(() => handle.close().catch(() => undefined));

    await handle.handler(makeInitializeRequest());

    // Both causes must survive to the operator-facing log rather than one
    // masking the other.
    const logged = consoleError.mock.calls.find(([message]) => message === LOG_SESSION_CREATE_FAILED)?.[1];
    expect(logged).toBeInstanceOf(AggregateError);
    const aggregate = logged as AggregateError;
    expect(aggregate.errors).toEqual([startupError, cleanupError]);
    expect(aggregate.message).toBe('Failed to start and clean up MCP client session');
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

    const response = await handle.handler(makeInitializeRequest());

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

  it('refuses new sessions with 503 after the endpoint is closed', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createFetchMcpHandler(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanup();
    });

    await handle.close();

    // The handler must NOT throw — a closed endpoint is a routing outcome.
    const response = await handle.handler(makeInitializeRequest());
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server is shutting down' },
    });
  });

  // -------------------------------------------------------------------------
  // GET requests (SSE)
  // -------------------------------------------------------------------------

  it('rejects a GET without an MCP session ID', async () => {
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

    // A GET can never open a session, so it is refused before any transport is
    // built rather than returning a stream nobody owns.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
    });
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
