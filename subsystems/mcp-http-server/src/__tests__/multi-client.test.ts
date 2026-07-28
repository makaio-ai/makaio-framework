/**
 * Multi-client regression tests for the HTTP MCP endpoint.
 *
 * One MCP endpoint serves many concurrent MCP protocol sessions. Every
 * subprocess-based adapter turn spawns a fresh MCP client against the same
 * shared bridge port, so "one endpoint, one client" is not a valid model.
 *
 * These tests drive real {@link Client} instances over real transports —
 * no MCP SDK mocking — because the defect they guard lives in the SDK's
 * session state machine, not in our own bookkeeping.
 *
 * Scenarios covered:
 * - Two concurrent clients on one endpoint, each with its own MCP session
 * - Tool context stays routed per adapter session while both are connected
 * - A third client connects after the first two disconnected
 * - One client's session termination leaves the other untouched
 * - Unknown / missing MCP session IDs map to the documented JSON-RPC errors
 * - A closed endpoint refuses new work with 503
 * - The fetch handler behaves identically
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type ToolExecutionContextOverrides } from '@makaio/contracts';
import { createHttpMcpHandler, startHttpMcpServer } from '../server.js';
import { createFetchMcpHandler } from '../fetch-handler.js';
import { createClient, mountFetchHandler, mountHandler, registerEmptyToolList } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register an `echo` tool whose executions record their context overrides.
 * @param bus - Bus instance to register on.
 * @param captured - Sink receiving one entry per tool execution.
 * @returns Cleanup function removing both handlers.
 */
function registerEchoTool(bus: IMakaioBus, captured: ToolExecutionContextOverrides[]): () => void {
  const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
    ctx.setResult({
      tools: [{ name: 'echo', description: 'Echo tool', toolsetName: 'test-tools', inputSchema: { type: 'object' } }],
      toolsets: [],
    });
  });
  const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
    captured.push(ctx.payload.contextOverrides ?? {});
    ctx.setResult({ success: true, data: { ok: true } });
  });
  return () => {
    cleanupExecute();
    cleanupList();
  };
}

/**
 * Issue a raw MCP POST, bypassing the SDK client so protocol-level errors are
 * observable as HTTP status plus JSON-RPC body.
 * @param port - Endpoint port.
 * @param body - JSON-RPC request body.
 * @param mcpSessionId - Optional `Mcp-Session-Id` header value.
 * @returns HTTP status and parsed JSON body.
 */
async function rawPost(
  port: number,
  body: unknown,
  mcpSessionId?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** A `tools/list` request body, valid only inside an initialized session. */
const TOOLS_LIST_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HTTP MCP endpoint with multiple clients', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch(() => undefined);
    }
  });

  it('serves two concurrent MCP clients on one endpoint', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const first = await createClient(handle.port, 'adapter-session-one');
    cleanups.push(() => first.client.close());
    const second = await createClient(handle.port, 'adapter-session-two');
    cleanups.push(() => second.client.close());

    await expect(first.client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    await expect(second.client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });

    expect(first.transport.sessionId).toBeDefined();
    expect(second.transport.sessionId).toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
  });

  it('routes tool context per adapter session while both clients are connected', async () => {
    const bus = createBusInstance();
    const captured: ToolExecutionContextOverrides[] = [];
    const cleanupTools = registerEchoTool(bus, captured);

    const overridesByAdapterSession: Record<string, ToolExecutionContextOverrides> = {
      'ctx-session-a': { cwd: '/workspace/a', sessionId: 'makaio-a' },
      'ctx-session-b': { cwd: '/workspace/b', sessionId: 'makaio-b' },
    };

    const handle = await startHttpMcpServer(bus, {
      resolveContextOverrides: (adapterSessionId) =>
        adapterSessionId ? overridesByAdapterSession[adapterSessionId] : undefined,
    });
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const first = await createClient(handle.port, 'ctx-session-a');
    cleanups.push(() => first.client.close());
    const second = await createClient(handle.port, 'ctx-session-b');
    cleanups.push(() => second.client.close());

    await first.client.callTool({ name: 'echo', arguments: { value: 'a' } });
    await second.client.callTool({ name: 'echo', arguments: { value: 'b' } });

    // Approval and tool execution must land on the agent that owns the adapter
    // session, not on whichever MCP session happened to connect first.
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ cwd: '/workspace/a', sessionId: 'makaio-a' });
    expect(captured[1]).toMatchObject({ cwd: '/workspace/b', sessionId: 'makaio-b' });
  });

  it('accepts a third client after the first two disconnected', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    // Models the per-turn subprocess sequence: a fresh MCP client per turn,
    // each one closing without terminating its server-side session.
    for (const turn of ['turn-1', 'turn-2']) {
      const { client } = await createClient(handle.port, turn);
      await expect(client.listTools()).resolves.toBeDefined();
      await client.close();
    }

    const third = await createClient(handle.port, 'turn-3');
    cleanups.push(() => third.client.close());
    await expect(third.client.listTools()).resolves.toBeDefined();
  });

  it('leaves other clients untouched when one terminates its session', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const first = await createClient(handle.port, 'delete-session-a');
    const second = await createClient(handle.port, 'delete-session-b');
    cleanups.push(() => second.client.close());

    const terminatedSessionId = first.transport.sessionId;
    expect(terminatedSessionId).toBeDefined();
    await first.transport.terminateSession();
    await first.client.close();

    await expect(second.client.listTools()).resolves.toBeDefined();

    const orphaned = await rawPost(handle.port, TOOLS_LIST_BODY, terminatedSessionId);
    expect(orphaned.status).toBe(404);
    expect(orphaned.json).toMatchObject({ error: { code: -32001, message: 'Session not found' } });
  });

  it('maps unknown and missing MCP session IDs to JSON-RPC errors', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const unknown = await rawPost(handle.port, TOOLS_LIST_BODY, 'nonexistent-session-id');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { code: -32001, message: 'Session not found' } });

    const getWithoutSession = await fetch(`http://127.0.0.1:${handle.port}/`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(getWithoutSession.status).toBe(400);
    await expect(getWithoutSession.json()).resolves.toMatchObject({
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
    });
  });

  it('refuses requests with 503 after the endpoint is closed', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);

    // Mount on a server the endpoint does not own so the port stays reachable
    // after the MCP endpoint itself has been closed.
    const handle = await createHttpMcpHandler(bus);
    const mounted = await mountHandler(handle.handler);
    cleanups.push(async () => {
      await mounted.stop();
      cleanupTools();
    });

    await handle.close();

    const refused = await rawPost(mounted.port, TOOLS_LIST_BODY);
    expect(refused.status).toBe(503);
    expect(refused.json).toMatchObject({ error: { code: -32000, message: 'Server is shutting down' } });
  });
});

describe('fetch MCP endpoint with multiple clients', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch(() => undefined);
    }
  });

  it('serves two concurrent MCP clients on one endpoint', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await createFetchMcpHandler(bus);
    const mounted = await mountFetchHandler(handle.handler);
    cleanups.push(async () => {
      await handle.close();
      await mounted.stop();
      cleanupTools();
    });

    const first = await createClient(mounted.port, 'fetch-session-one');
    cleanups.push(() => first.client.close());
    const second = await createClient(mounted.port, 'fetch-session-two');
    cleanups.push(() => second.client.close());

    await expect(first.client.listTools()).resolves.toBeDefined();
    await expect(second.client.listTools()).resolves.toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
  });

  it('maps unknown and missing MCP session IDs to JSON-RPC errors', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await createFetchMcpHandler(bus);
    const mounted = await mountFetchHandler(handle.handler);
    cleanups.push(async () => {
      await handle.close();
      await mounted.stop();
      cleanupTools();
    });

    const unknown = await rawPost(mounted.port, TOOLS_LIST_BODY, 'nonexistent-session-id');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { code: -32001, message: 'Session not found' } });

    const getWithoutSession = await fetch(`http://127.0.0.1:${mounted.port}/`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(getWithoutSession.status).toBe(400);
    await expect(getWithoutSession.json()).resolves.toMatchObject({
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
    });
  });
});
