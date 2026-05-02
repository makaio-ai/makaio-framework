/**
 * Integration tests for {@link McpServerBridgeService}.
 *
 * Exercises the real service through a real isolated bus. Each test gets a
 * fresh {@link createBusInstance} and a fresh service so there is no
 * cross-test state. The HTTP MCP server is started lazily on the first
 * `mcp.session.register` call — it binds to `127.0.0.1:0` so the OS assigns
 * a free port.
 *
 * Scenarios covered:
 * - Session registration returns a positive port number
 * - Re-registering on the same bus always returns the same singleton port
 * - Session unregistration succeeds without error
 * - Unregistering an unknown session is a no-op (no throw)
 * - `requestOptional` returns `{ handled: false }` after the service is destroyed
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { McpSubjects, ToolSubjects, type ToolExecutionContextOverrides } from '@makaio/contracts';
import { McpServerBridgeService, MAX_SESSION_COUNT } from '../mcp-server-bridge-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid register payload for test scenarios. */
interface RegisterPayload {
  adapterSessionId: string;
  agentId: string;
  adapterId: string;
  adapterName: string;
  sessionId: string;
  contextOverrides: ToolExecutionContextOverrides;
}

/**
 * Build a register payload with sensible defaults, allowing partial overrides.
 * @param overrides - Fields to override in the default payload.
 * @returns A complete register payload.
 */
function makeRegisterPayload(overrides: Partial<RegisterPayload> = {}): RegisterPayload {
  return {
    adapterSessionId: 'test-session-1',
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    sessionId: 'session-1',
    contextOverrides: {},
    ...overrides,
  };
}

/**
 * Create an MCP client connected to a specific adapter session on the bridge.
 * @param port - Bridge HTTP port
 * @param adapterSessionId - Adapter session routed through the bridge query param
 * @returns Connected client and transport
 */
async function createMcpClient(
  port: number,
  adapterSessionId: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'mcp-bridge-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?adapterSessionId=${encodeURIComponent(adapterSessionId)}`),
  );
  await client.connect(transport);
  return { client, transport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpServerBridgeService', () => {
  let bus: IMakaioBus;
  let service: McpServerBridgeService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new McpServerBridgeService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  // =========================================================================
  // Session registration
  // =========================================================================

  describe('session.register', () => {
    it('returns a positive port number on first registration', async () => {
      const result = await bus.request(
        McpSubjects.session.register,
        makeRegisterPayload({ adapterSessionId: 'reg-1' }),
      );

      expect(result.port).toBeGreaterThan(0);
    });

    it('returns the same singleton port for subsequent registrations', async () => {
      const r1 = await bus.request(
        McpSubjects.session.register,
        makeRegisterPayload({ adapterSessionId: 'session-a', agentId: 'agent-a', sessionId: 's-a' }),
      );
      const r2 = await bus.request(
        McpSubjects.session.register,
        makeRegisterPayload({ adapterSessionId: 'session-b', agentId: 'agent-b', sessionId: 's-b' }),
      );

      expect(r1.port).toBe(r2.port);
    });

    it('concurrent registrations coalesce on a single server instance', async () => {
      const [r1, r2, r3] = await Promise.all([
        bus.request(McpSubjects.session.register, makeRegisterPayload({ adapterSessionId: 'c-1' })),
        bus.request(McpSubjects.session.register, makeRegisterPayload({ adapterSessionId: 'c-2' })),
        bus.request(McpSubjects.session.register, makeRegisterPayload({ adapterSessionId: 'c-3' })),
      ]);

      expect(r1.port).toBe(r2.port);
      expect(r2.port).toBe(r3.port);
    });
  });

  // =========================================================================
  // Session unregistration
  // =========================================================================

  describe('session.unregister', () => {
    it('unregisters a known session without error', async () => {
      await bus.request(McpSubjects.session.register, makeRegisterPayload({ adapterSessionId: 'to-remove' }));

      await expect(
        bus.request(McpSubjects.session.unregister, { adapterSessionId: 'to-remove' }),
      ).resolves.toBeDefined();
    });

    it('treats unregistering an unknown session as a no-op', async () => {
      // Ensure the server has started so the handler is live.
      await bus.request(McpSubjects.session.register, makeRegisterPayload({ adapterSessionId: 'known' }));

      await expect(
        bus.request(McpSubjects.session.unregister, { adapterSessionId: 'never-registered' }),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // Graceful degradation after destroy
  // =========================================================================

  describe('graceful degradation', () => {
    it('requestOptional returns { handled: false } when service is not initialized', async () => {
      // Destroy within the test — afterEach will call destroy again but that is idempotent.
      await service.destroy();

      const result = await bus.requestOptional(
        McpSubjects.session.register,
        makeRegisterPayload({ adapterSessionId: 'orphan' }),
      );

      expect(result.handled).toBe(false);
    });
  });

  describe('tool execution context', () => {
    it('routes registered contextOverrides into tool execution over the MCP bridge', async () => {
      const captured: ToolExecutionContextOverrides[] = [];
      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              toolsetName: 'test-tools',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      });
      const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
        captured.push(ctx.payload.contextOverrides ?? {});
        ctx.setResult({ success: true, data: { echoed: ctx.payload.input } });
      });

      try {
        const registration = await bus.request(
          McpSubjects.session.register,
          makeRegisterPayload({
            adapterSessionId: 'bridge-tool-session',
            agentId: 'bridge-agent',
            adapterId: 'bridge-adapter',
            sessionId: 'makaio-session-42',
            contextOverrides: {
              cwd: '/tmp/bridge-tool',
              env: { BRIDGE_ENV: '1' },
              sessionId: 'makaio-session-42',
              agentId: 'bridge-agent',
            },
          }),
        );

        const { client, transport } = await createMcpClient(registration.port, 'bridge-tool-session');
        try {
          await client.callTool({
            name: 'echo',
            arguments: { value: 'hello' },
          });
        } finally {
          await client.close();
          await transport.close();
        }

        expect(captured).toHaveLength(1);
        expect(captured[0]).toEqual({
          cwd: '/tmp/bridge-tool',
          env: { BRIDGE_ENV: '1' },
          sessionId: 'makaio-session-42',
          agentId: 'bridge-agent',
        });
      } finally {
        cleanupExecute();
        cleanupList();
      }
    });

    it('evicts LRU-capped sessions and falls back to process-level context', async () => {
      // QuickLRU uses a two-cache swap strategy: it maintains an "old" and "new"
      // internal cache, each of size maxSize. When the new cache fills up, it
      // becomes the old cache (evicting all its entries) and a fresh new cache
      // starts. With maxSize=1000, eviction of the first entry is guaranteed only
      // after 2*maxSize + 1 = 2001 total unique inserts (target + 2000 fillers).
      const TARGET_SESSION_ID = 'lru-eviction-target';
      // Keep this coupled to MAX_SESSION_COUNT in mcp-server-bridge-service.ts:
      // this test relies on the production LRU size so the filler inserts
      // deterministically cross QuickLRU's eviction threshold.
      const FILLER_COUNT = 2 * MAX_SESSION_COUNT; // guarantees target is evicted

      const captured: ToolExecutionContextOverrides[] = [];
      const cleanupList = bus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              toolsetName: 'test-tools',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      });
      const cleanupExecute = bus.on(ToolSubjects.execute, (ctx) => {
        captured.push(ctx.payload.contextOverrides ?? {});
        ctx.setResult({ success: true, data: { ok: true } });
      });

      try {
        // Step 1: Register the target session — this becomes the LRU entry.
        const registration = await bus.request(
          McpSubjects.session.register,
          makeRegisterPayload({
            adapterSessionId: TARGET_SESSION_ID,
            sessionId: 'session-before-eviction',
            contextOverrides: {
              cwd: '/tmp/lru-eviction-target',
              sessionId: 'session-before-eviction',
            },
          }),
        );

        // Step 2: Register FILLER_COUNT more unique sessions to push the target out.
        // Sequential registration avoids unnecessary CPU/memory pressure from
        // 2000+ concurrent in-process bus RPCs while testing the same LRU eviction
        // behavior — insertion order, not concurrency, drives eviction.
        for (let i = 0; i < FILLER_COUNT; i++) {
          await bus.request(
            McpSubjects.session.register,
            makeRegisterPayload({
              adapterSessionId: `lru-filler-${i}`,
              sessionId: `filler-session-${i}`,
            }),
          );
        }

        // Step 3: Call a tool via the evicted session. The LRU eviction callback
        // removed it from contextRegistry, so resolveContextOverrides returns
        // undefined and the server uses process-level defaults.
        const { client, transport } = await createMcpClient(registration.port, TARGET_SESSION_ID);
        try {
          await client.callTool({ name: 'echo', arguments: { value: 'after-eviction' } });
        } finally {
          await client.close();
          await transport.close();
        }

        expect(captured).toHaveLength(1);
        expect(captured[0]?.cwd).toBe(process.cwd());
        expect(captured[0]?.sessionId).not.toBe('session-before-eviction');
      } finally {
        cleanupExecute();
        cleanupList();
      }
    });

    it('evicts stale sessions via TTL sweep and falls back to process-level context', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-03-25T00:00:00.000Z'));

      const localBus = createBusInstance();
      const localService = new McpServerBridgeService(localBus);
      await localService.init();

      const captured: ToolExecutionContextOverrides[] = [];
      const cleanupList = localBus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'echo',
              description: 'Echo tool',
              toolsetName: 'test-tools',
              inputSchema: { type: 'object' },
            },
          ],
          toolsets: [],
        });
      });
      const cleanupExecute = localBus.on(ToolSubjects.execute, (ctx) => {
        captured.push(ctx.payload.contextOverrides ?? {});
        ctx.setResult({ success: true, data: { ok: true } });
      });

      try {
        const registration = await localBus.request(
          McpSubjects.session.register,
          makeRegisterPayload({
            adapterSessionId: 'stale-session',
            sessionId: 'session-before-sweep',
            contextOverrides: {
              cwd: '/tmp/stale-session',
              sessionId: 'session-before-sweep',
            },
          }),
        );

        vi.setSystemTime(new Date('2026-03-25T00:31:00.000Z'));
        await vi.advanceTimersByTimeAsync(60_000);

        const { client, transport } = await createMcpClient(registration.port, 'stale-session');
        try {
          await client.callTool({
            name: 'echo',
            arguments: { value: 'after-sweep' },
          });
        } finally {
          await client.close();
          await transport.close();
        }

        expect(captured).toHaveLength(1);
        expect(captured[0]?.cwd).toBe(process.cwd());
        expect(captured[0]?.sessionId).not.toBe('session-before-sweep');
      } finally {
        cleanupExecute();
        cleanupList();
        await localService.destroy();
        vi.useRealTimers();
      }
    });
  });
});
