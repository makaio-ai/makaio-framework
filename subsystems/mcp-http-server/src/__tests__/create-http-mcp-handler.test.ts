/**
 * Integration tests for {@link createHttpMcpHandler}.
 *
 * Exercises the helper as an external consumer would: mounts the returned
 * handler on a plain `node:http` server, then performs real MCP round-trips
 * through it.  This proves the handler is self-contained and does not require
 * callers to import MCP SDK types.
 *
 * Scenarios covered:
 * - Real MCP round-trip (tools/list) through a consumer-owned http.Server
 * - adapterSessionId query-param shim is applied before MCP dispatch
 *   (param → x-adapter-session-id header, observable via resolveContextOverrides)
 * - close() is idempotent (two awaited calls, no throw)
 * - onclose fires exactly once after handle.close() (endpoint-level, not per client)
 * - startHttpMcpServer existing behaviour is unchanged (regression net)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import type { ToolExecutionContextOverrides } from '@makaio/contracts';
import { createHttpMcpHandler, startHttpMcpServer } from '../server.js';
import { createClient, mountHandler, registerEmptyToolList } from './helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHttpMcpHandler', () => {
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

  it('returns a handler that serves real MCP round-trips via a consumer-owned http.Server', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createHttpMcpHandler(bus);
    const { port, stop } = await mountHandler(handle.handler);

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

  it('maps adapterSessionId query param to x-adapter-session-id header before dispatch', async () => {
    const bus = createBusInstance();

    /**
     * Capture the adapterSessionId resolved by the context override callback
     * to verify the shim promoted it from query param to header.
     */
    const capturedSessionIds: Array<string | undefined> = [];

    const handle = await createHttpMcpHandler(bus, {
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

    const { port, stop } = await mountHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
      cleanupList();
      cleanupExecute();
    });

    const targetSessionId = 'shim-test-session-abc';
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

  it('close() is idempotent — two awaited calls do not throw', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createHttpMcpHandler(bus);
    const { stop } = await mountHandler(handle.handler);

    cleanups.push(async () => {
      await stop();
      cleanup();
    });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('fires onclose exactly once after handle.close()', async () => {
    const bus = createBusInstance();
    const onclose = vi.fn();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createHttpMcpHandler(bus, { onclose });
    const { stop } = await mountHandler(handle.handler);

    cleanups.push(async () => {
      await stop();
      cleanup();
    });

    await handle.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid idleTimeoutMs %s', async (idleTimeoutMs) => {
    await expect(createHttpMcpHandler(createBusInstance(), { idleTimeoutMs })).rejects.toThrow(
      'idleTimeoutMs must be a positive finite number of milliseconds',
    );
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid sweepIntervalMs %s', async (sweepIntervalMs) => {
    await expect(createHttpMcpHandler(createBusInstance(), { sweepIntervalMs })).rejects.toThrow(
      'sweepIntervalMs must be a positive finite number of milliseconds',
    );
  });

  it('rejects a sweepIntervalMs beyond the timer ceiling', async () => {
    // Only the sweep interval is handed to a timer, so only it carries the
    // 32-bit delay ceiling on top of the shared positive-finite contract.
    await expect(createHttpMcpHandler(createBusInstance(), { sweepIntervalMs: 2_147_483_648 })).rejects.toThrow(
      'sweepIntervalMs must be no greater than 2147483647 milliseconds',
    );
  });

  it('exposes a contextRegistry that can register and retrieve agent context', async () => {
    const bus = createBusInstance();
    const cleanup = registerEmptyToolList(bus);

    const handle = await createHttpMcpHandler(bus);
    const { stop } = await mountHandler(handle.handler);

    cleanups.push(async () => {
      await handle.close();
      await stop();
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

// ---------------------------------------------------------------------------
// Regression net: startHttpMcpServer is behaviourally unchanged
// ---------------------------------------------------------------------------

describe('startHttpMcpServer (regression)', () => {
  it('invokes the endpoint onclose hook exactly once when the handle closes', async () => {
    const bus = createBusInstance();
    const onclose = vi.fn();

    const handle = await startHttpMcpServer(bus, { onclose });

    try {
      await handle.close();
    } finally {
      // Second close must not throw (idempotency via handle.close inside).
      await handle.close().catch(() => undefined);
    }

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('returns a positive port number', async () => {
    const bus = createBusInstance();
    const handle = await startHttpMcpServer(bus);
    try {
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });
});
