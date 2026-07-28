/**
 * Lifecycle tests for {@link McpTransportRegistry}.
 *
 * Split in two layers on purpose:
 *
 * - Direct registry tests drive `route()` against a real
 *   `WebStandardStreamableHTTPServerTransport`, which accepts a plain
 *   `Request`. That makes admission, leasing, reaping, and pending disposal
 *   observable without any socket, and therefore fully deterministic.
 * - Endpoint tests drive real MCP clients over real HTTP, because the liveness
 *   contract depends on a real standalone SSE stream staying open.
 *
 * The registry tests use fake timers (`Date`, `setInterval`, `clearInterval`
 * only, leaving real network I/O and `setTimeout` untouched) because there they
 * are exact. The endpoint tests deliberately run on the real clock with a short
 * idle timeout instead: releasing a lease is driven by socket close events that
 * a faked interval clock does not advance, so a virtual clock jump would only
 * prove that the sweep ran before the socket state settled.
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { createMcpEndpoint } from '../mcp-endpoint.js';
import { createMcpServer } from '../create-mcp-server.js';
import { createHttpMcpHandler, startHttpMcpServer } from '../server.js';
import { McpTransportRegistry, type McpTransportRegistryOptions } from '../mcp-transport-registry.js';
import { createClient, createGate, mountHandler, registerEmptyToolList } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/** A legitimate long idle policy (30 days), far beyond the 32-bit timer ceiling. */
const LONG_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60_000;
const T0 = new Date('2026-03-25T00:00:00.000Z');

/**
 * Endpoint-level idle timeout. Short enough to observe on the real clock,
 * long enough that a slow machine cannot mistake scheduling delay for idleness
 * while a lease is held.
 */
const FAST_IDLE_TIMEOUT_MS = 250;

/** Endpoint-level sweep cadence, several passes per idle window. */
const FAST_SWEEP_INTERVAL_MS = 25;

/**
 * Build a registry over real Web Standard transports and real MCP servers.
 * @param bus - Bus backing tool discovery for every session.
 * @param overrides - Optional reaping configuration.
 * @returns A registry ready to route requests.
 */
function createTestRegistry(
  bus: IMakaioBus,
  overrides: Partial<Omit<McpTransportRegistryOptions<WebStandardStreamableHTTPServerTransport>, 'createSession'>> = {},
): McpTransportRegistry<WebStandardStreamableHTTPServerTransport> {
  return new McpTransportRegistry<WebStandardStreamableHTTPServerTransport>({
    createSession: async (hooks) => ({
      server: await createMcpServer(bus, 'registry-test-session'),
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (mcpSessionId) => hooks.onSessionInitialized(mcpSessionId),
      }),
    }),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    ...overrides,
  });
}

/**
 * Build a JSON-RPC POST request for the registry's transports.
 * @param body - JSON-RPC body to send.
 * @returns A well-formed MCP POST request.
 */
function jsonRpcPost(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

/** A valid `initialize` body opening a new MCP protocol session. */
const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'registry-test-client', version: '1.0.0' },
  },
};

/** A `tools/list` body, valid only inside an already-initialized session. */
const TOOLS_LIST_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/**
 * Open a new session on the registry and drain its response.
 * @param registry - Registry under test.
 * @returns The dispatch outcome's lease release callback and the response status.
 */
async function openSession(
  registry: McpTransportRegistry<WebStandardStreamableHTTPServerTransport>,
): Promise<{ finish: () => void; status: number; mcpSessionId: string | undefined }> {
  const route = await registry.route({ method: 'POST', mcpSessionId: undefined });
  if (route.outcome !== 'dispatch') {
    throw new Error(`Expected dispatch, got ${route.outcome}`);
  }
  const response = await route.transport.handleRequest(jsonRpcPost(INITIALIZE_BODY));
  await response.body?.cancel();
  return { finish: route.finish, status: response.status, mcpSessionId: route.transport.sessionId };
}

/**
 * Assert that no MCP server is still subscribed to tool registry changes.
 * @param bus - Bus the servers subscribed on.
 * @param sendToolListChanged - Spy installed on `Server.prototype.sendToolListChanged`.
 */
async function expectNoRegistrySubscription(
  bus: IMakaioBus,
  sendToolListChanged: ReturnType<typeof vi.spyOn>,
): Promise<void> {
  await bus.emit(ToolSubjects.registryChanged, {
    revision: 1,
    reason: 'toolset-registered',
    toolsetName: 'after-disposal',
  });
  expect(sendToolListChanged).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Registry unit tests
// ---------------------------------------------------------------------------

describe('McpTransportRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits an initialized session and routes later requests to it', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const registry = createTestRegistry(bus);

    try {
      const opened = await openSession(registry);
      opened.finish();

      expect(opened.status).toBe(200);
      expect(opened.mcpSessionId).toBeDefined();
      expect(registry.size).toBe(1);

      const followUp = await registry.route({ method: 'POST', mcpSessionId: opened.mcpSessionId });
      expect(followUp.outcome).toBe('dispatch');
      if (followUp.outcome === 'dispatch') followUp.finish();
    } finally {
      await registry.closeAll();
      cleanupTools();
    }
  });

  it('leaves no session behind when a POST without a session ID never initializes', async () => {
    const bus = createBusInstance();
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    const registry = createTestRegistry(bus);

    try {
      const route = await registry.route({ method: 'POST', mcpSessionId: undefined });
      expect(route.outcome).toBe('dispatch');
      if (route.outcome !== 'dispatch') return;

      const response = await route.transport.handleRequest(jsonRpcPost(TOOLS_LIST_BODY));
      await response.body?.cancel();
      route.finish();

      // The transport answers with the SDK's own not-initialized error, and the
      // pair it was built for is disposed rather than orphaned.
      expect(response.status).toBe(400);
      expect(registry.size).toBe(0);
      await vi.waitFor(() => expect(sendToolListChanged).not.toHaveBeenCalled());
      await expectNoRegistrySubscription(bus, sendToolListChanged);
    } finally {
      await registry.closeAll();
    }
  });

  it('refuses methods that can never open a session when no session ID is given', async () => {
    const registry = createTestRegistry(createBusInstance());

    try {
      await expect(registry.route({ method: 'GET', mcpSessionId: undefined })).resolves.toEqual({
        outcome: 'session-id-required',
      });
      await expect(registry.route({ method: 'DELETE', mcpSessionId: undefined })).resolves.toEqual({
        outcome: 'session-id-required',
      });
      expect(registry.size).toBe(0);
    } finally {
      await registry.closeAll();
    }
  });

  it('reports an unrecognised session ID as unknown', async () => {
    const registry = createTestRegistry(createBusInstance());

    try {
      await expect(registry.route({ method: 'POST', mcpSessionId: 'never-issued' })).resolves.toEqual({
        outcome: 'unknown-session',
      });
    } finally {
      await registry.closeAll();
    }
  });

  it('closes every live session and refuses further routing after closeAll()', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    const registry = createTestRegistry(bus);

    const first = await openSession(registry);
    first.finish();
    const second = await openSession(registry);
    second.finish();
    expect(registry.size).toBe(2);

    await registry.closeAll();

    expect(registry.size).toBe(0);
    await expect(registry.route({ method: 'POST', mcpSessionId: first.mcpSessionId })).resolves.toEqual({
      outcome: 'closed',
    });
    await expectNoRegistrySubscription(bus, sendToolListChanged);
    cleanupTools();
  });

  it('waits for a disposal the sweep already started before resolving closeAll()', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);

    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);

    // Hold the close open: the sweep removes the record from the owner sets
    // before closing, so without the disposals link a concurrent closeAll()
    // would find nothing to wait for and resolve mid-teardown.
    const { promise: closeGate, open: openCloseGate } = createGate();
    const closeServer = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(async function (this: Server) {
      await closeGate;
      await closeServer.call(this);
    });

    const registry = createTestRegistry(bus);

    try {
      const opened = await openSession(registry);
      opened.finish();

      // Let the sweep condemn the session and start its background disposal.
      vi.setSystemTime(new Date(T0.getTime() + IDLE_TIMEOUT_MS + SWEEP_INTERVAL_MS));
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(registry.size).toBe(0);

      let settled = false;
      const closeAll = registry.closeAll().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      openCloseGate();
      await closeAll;
    } finally {
      openCloseGate();
      await registry.closeAll();
      cleanupTools();
    }
  });

  it('lets concurrent closeAll() callers share one teardown', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);

    // Hold teardown open: without the shared close promise the second caller
    // would find the owner sets already cleared and resolve immediately,
    // reporting a completed shutdown while the first caller's teardown is
    // still in flight.
    const { promise: closeGate, open: openCloseGate } = createGate();
    const closeServer = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(async function (this: Server) {
      await closeGate;
      await closeServer.call(this);
    });

    const registry = createTestRegistry(bus);

    try {
      const opened = await openSession(registry);
      opened.finish();

      let firstSettled = false;
      let secondSettled = false;
      const first = registry.closeAll().then(() => {
        firstSettled = true;
      });
      const second = registry.closeAll().then(() => {
        secondSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      openCloseGate();
      await Promise.all([first, second]);
    } finally {
      openCloseGate();
      await registry.closeAll();
      cleanupTools();
    }
  });

  it('waits for an in-flight session construction before resolving closeAll()', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();

    // Hold the transport factory open: during `createSession` the pair exists
    // in neither owner set, so only the tracked startup task can make
    // shutdown wait for it.
    const { promise: factoryGate, open: openFactoryGate } = createGate();
    const registry = new McpTransportRegistry<WebStandardStreamableHTTPServerTransport>({
      createSession: async (hooks) => {
        await factoryGate;
        return {
          server: await createMcpServer(bus, 'registry-test-session'),
          transport: new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (mcpSessionId) => hooks.onSessionInitialized(mcpSessionId),
          }),
        };
      },
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });

    try {
      const routing = registry.route({ method: 'POST', mcpSessionId: undefined });
      // Let route() enter the factory before shutdown starts.
      await new Promise((resolve) => setTimeout(resolve, 0));

      let settled = false;
      const closeAll = registry.closeAll().then(() => {
        settled = true;
      });
      // Shutdown must not resolve while the construction it overlaps is still
      // running — a hung factory has to surface as a hung close, never as a
      // clean shutdown with a server still coming up behind it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      openFactoryGate();
      await closeAll;

      // The construction observed the closed registry after connecting and
      // disposed itself: nothing was admitted, nothing stayed subscribed.
      const route = await routing;
      expect(route.outcome).toBe('closed');
      expect(registry.size).toBe(0);
      await expectNoRegistrySubscription(bus, sendToolListChanged);
    } finally {
      openFactoryGate();
      await registry.closeAll();
      cleanupTools();
    }
  });

  it('tears down a pair that is still initializing when closeAll() runs', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();

    // Hold teardown open so "shutdown is waiting for this pair" is observable
    // rather than inferred. The gate is opened from the test body as well as
    // from `finally`, so a failed assertion surfaces as itself and not a hang.
    const { promise: closeGate, open: openCloseGate } = createGate();
    const closeStarted = vi.fn();
    const closeServer = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(async function (this: Server) {
      closeStarted();
      await closeGate;
      await closeServer.call(this);
    });

    const registry = createTestRegistry(bus);

    try {
      const route = await registry.route({ method: 'POST', mcpSessionId: undefined });
      expect(route.outcome).toBe('dispatch');
      if (route.outcome !== 'dispatch') return;

      // The pair is built and leased but not admitted, so the pending set is
      // the only thing that can reach it. Shutdown must tear it down and wait
      // for that teardown: the lease is released by a response completing, and
      // a client that hangs up on its stream can defer that indefinitely.
      let settled = false;
      const closeAll = registry.closeAll().then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(closeStarted).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);

      openCloseGate();
      await closeAll;

      const response = await route.transport.handleRequest(jsonRpcPost(INITIALIZE_BODY));
      await response.body?.cancel();
      route.finish();

      // Initialization completed after shutdown, so the pair is not admitted
      // into a registry nothing will close again, and the server it carried
      // released its bus subscription during `closeAll`.
      expect(registry.size).toBe(0);
      await expectNoRegistrySubscription(bus, sendToolListChanged);
    } finally {
      openCloseGate();
      cleanupTools();
    }
  });

  it('reports a session that fails to connect as create-failed', async () => {
    const bus = createBusInstance();
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(
      new Error('transport startup failed'),
    );
    const registry = createTestRegistry(bus);

    try {
      const route = await registry.route({ method: 'POST', mcpSessionId: undefined });

      expect(route.outcome).toBe('create-failed');
      expect(registry.size).toBe(0);
      // The half-built server must have released its bus subscription.
      await expectNoRegistrySubscription(bus, sendToolListChanged);
    } finally {
      await registry.closeAll();
    }
  });

  it('does not leak the server subscription when the transport factory throws', async () => {
    const bus = createBusInstance();
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    // The endpoint builds the transport before the server: a throwing factory
    // must abort createSession before any bus subscription exists, because a
    // server the registry never saw is one nothing can close.
    const endpoint = createMcpEndpoint(bus, {}, () => {
      throw new Error('transport construction failed');
    });

    try {
      const route = await endpoint.registry.route({ method: 'POST', mcpSessionId: undefined });

      expect(route.outcome).toBe('create-failed');
      expect(endpoint.registry.size).toBe(0);
      await expectNoRegistrySubscription(bus, sendToolListChanged);
    } finally {
      await endpoint.close();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an idleTimeoutMs of %s', (idleTimeoutMs) => {
    expect(() => createTestRegistry(createBusInstance(), { idleTimeoutMs })).toThrow(
      'idleTimeoutMs must be a positive finite number of milliseconds',
    );
  });

  it('accepts an idleTimeoutMs longer than the timer ceiling', async () => {
    // The idle timeout is only ever compared against `Date.now()`, so the
    // 32-bit delay ceiling that bounds the sweep interval does not apply to it:
    // a month-long idle policy is a configuration, not a mistake.
    const registry = createTestRegistry(createBusInstance(), { idleTimeoutMs: LONG_IDLE_TIMEOUT_MS });

    expect(registry.size).toBe(0);
    await registry.closeAll();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a sweepIntervalMs of %s', (sweepIntervalMs) => {
    expect(() => createTestRegistry(createBusInstance(), { sweepIntervalMs })).toThrow(
      'sweepIntervalMs must be a positive finite number of milliseconds',
    );
  });

  it('refuses a sweepIntervalMs beyond the timer ceiling', () => {
    // Larger delays are coerced to 1ms, which would turn the sweep into a tight
    // loop instead of the long cadence the caller asked for.
    expect(() => createTestRegistry(createBusInstance(), { sweepIntervalMs: 2_147_483_648 })).toThrow(
      'sweepIntervalMs must be no greater than 2147483647 milliseconds',
    );
  });

  it('constructs on runtimes whose setInterval returns an opaque numeric handle', async () => {
    const nodeSetInterval = globalThis.setInterval;
    const started: NodeJS.Timeout[] = [];
    // Cloudflare Workers, Deno, and browsers all return a plain number from
    // setInterval, so an unconditional `.unref()` would throw here — before the
    // endpoint has served a single request.
    vi.stubGlobal('setInterval', (handler: () => void, timeout?: number) => {
      const handle = nodeSetInterval(handler, timeout);
      handle.unref();
      started.push(handle);
      return started.length;
    });

    let registry: McpTransportRegistry<WebStandardStreamableHTTPServerTransport>;
    try {
      registry = createTestRegistry(createBusInstance());
    } finally {
      vi.unstubAllGlobals();
    }

    expect(registry.size).toBe(0);
    await registry.closeAll();
    for (const handle of started) clearInterval(handle);
  });

  it('routes without reading a Node-only global when process is absent', async () => {
    const registry = createTestRegistry(createBusInstance());

    // Same runtimes, same reason: the route-level debug log must not turn into
    // a ReferenceError on the request path where `process` does not exist.
    vi.stubGlobal('process', undefined);
    let routed: Awaited<ReturnType<typeof registry.route>>;
    try {
      routed = await registry.route({ method: 'GET', mcpSessionId: undefined });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(routed).toEqual({ outcome: 'session-id-required' });
    await registry.closeAll();
  });

  it('reaps an idle session but never one with an open exchange', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);

    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const registry = createTestRegistry(bus);

    try {
      const opened = await openSession(registry);
      expect(registry.size).toBe(1);

      // The exchange is still open, so the session is not idle no matter how
      // long the clock runs — this is the lease that keeps a client holding an
      // SSE stream alive.
      vi.setSystemTime(new Date(T0.getTime() + 60 * 60_000));
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(registry.size).toBe(1);

      opened.finish();

      // Still inside the idle window right after the lease is released.
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(registry.size).toBe(1);

      vi.setSystemTime(new Date(T0.getTime() + 60 * 60_000 + IDLE_TIMEOUT_MS + 1));
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(registry.size).toBe(0);
    } finally {
      await registry.closeAll();
      cleanupTools();
    }
  });

  it('stops routing to a reaped session before its teardown completes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);

    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);

    // Hold teardown open so the window between "condemned by the sweep" and
    // "transport.onclose has removed the entry" is observable at all. One gate
    // shared by every close keeps the teardown in `finally` unblocked once it
    // opens, so an assertion failure here surfaces as itself and not as a hang.
    const { promise: closeGate, open: openCloseGate } = createGate();
    const closeStarted = vi.fn();
    const closeServer = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(async function (this: Server) {
      closeStarted();
      await closeGate;
      await closeServer.call(this);
    });

    const registry = createTestRegistry(bus);

    try {
      const opened = await openSession(registry);
      opened.finish();
      expect(registry.size).toBe(1);

      vi.setSystemTime(new Date(T0.getTime() + IDLE_TIMEOUT_MS + 1));
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      // Teardown has started but cannot finish, so `transport.onclose` has not
      // run. The reaped ID must nevertheless be unroutable already: dispatching
      // into a mid-teardown transport is what the synchronous delete prevents.
      expect(closeStarted).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(0);
      await expect(registry.route({ method: 'POST', mcpSessionId: opened.mcpSessionId })).resolves.toEqual({
        outcome: 'unknown-session',
      });
    } finally {
      openCloseGate();
      await registry.closeAll();
      cleanupTools();
    }
  });
});

// ---------------------------------------------------------------------------
// Endpoint-level lifecycle
// ---------------------------------------------------------------------------

describe('HTTP MCP endpoint session lifecycle', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch(() => undefined);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Send a raw `tools/list` POST bound to a specific MCP session.
   * @param port - Endpoint port.
   * @param mcpSessionId - Session ID to route with.
   * @returns HTTP status of the response.
   */
  async function probeSession(port: number, mcpSessionId: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify(TOOLS_LIST_BODY),
    });
    await response.body?.cancel();
    return response.status;
  }

  it('releases the activity lease when the client disconnects during session setup', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Hold session creation open so the client can hang up inside the window
    // between the request arriving and `route()` resolving.
    const { promise: startGate, open: openStartGate } = createGate();
    const startCalled = vi.fn();
    const startTransport = StreamableHTTPServerTransport.prototype.start;
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'start').mockImplementation(async function (
      this: StreamableHTTPServerTransport,
    ) {
      startCalled();
      await startGate;
      await startTransport.call(this);
    });

    const handle = await createHttpMcpHandler(bus);
    let servedResponse: ServerResponse | undefined;
    const mounted = await mountHandler((req, res) => {
      servedResponse = res;
      handle.handler(req, res);
    });
    cleanups.push(async () => {
      openStartGate();
      await handle.close();
      await mounted.stop();
      cleanupTools();
    });

    const aborter = new AbortController();
    const pending = fetch(`http://127.0.0.1:${mounted.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: aborter.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => expect(startCalled).toHaveBeenCalled());
    aborter.abort();
    await pending;

    // Wait until the server has observed the disconnect, so the one-shot
    // `close` listener the handler registers after `route()` resolves is
    // genuinely too late to fire.
    await vi.waitFor(() => expect(servedResponse?.closed).toBe(true));
    openStartGate();

    // The pair was never admitted, so releasing the lease is the only thing
    // that can dispose it. If nothing releases it, the lease stays at one open
    // exchange, the session is permanently unreapable, and this server keeps
    // its bus subscription forever.
    await vi.waitFor(async () => {
      sendToolListChanged.mockClear();
      await bus.emit(ToolSubjects.registryChanged, {
        revision: 1,
        reason: 'toolset-registered',
        toolsetName: 'after-setup-disconnect',
      });
      expect(sendToolListChanged).not.toHaveBeenCalled();
    });
  });

  it('reaps a session once its client has gone away', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus, {
      idleTimeoutMs: FAST_IDLE_TIMEOUT_MS,
      sweepIntervalMs: FAST_SWEEP_INTERVAL_MS,
    });
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const { client, transport } = await createClient(handle.port, 'reaped-session');
    const mcpSessionId = transport.sessionId;
    expect(mcpSessionId).toBeDefined();

    // The SDK client does not send DELETE on close, so the server-side session
    // is orphaned and only the reaper can release it.
    await client.close();

    // Each probe is itself an exchange that refreshes the session's activity,
    // so retries must be spaced further apart than the idle timeout — otherwise
    // the poll would keep alive the very session it is waiting to see reaped.
    await vi.waitFor(
      async () => {
        expect(await probeSession(handle.port, mcpSessionId!)).toBe(404);
      },
      { interval: FAST_IDLE_TIMEOUT_MS * 4, timeout: FAST_IDLE_TIMEOUT_MS * 40 },
    );
  });

  it('does not reap a session whose client is holding its SSE stream', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus, {
      idleTimeoutMs: FAST_IDLE_TIMEOUT_MS,
      sweepIntervalMs: FAST_SWEEP_INTERVAL_MS,
    });
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const { client } = await createClient(handle.port, 'pinned-tmux-session');
    cleanups.push(() => client.close());

    // The client opens its standalone SSE stream as a fire-and-forget request
    // after connect() resolves. A server-initiated notification can only reach
    // the client over that stream, so receiving one is the proof that the
    // stream — and therefore the lease protecting this session — is live.
    const notifications: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      notifications.push(notification.method);
    });
    await vi.waitFor(async () => {
      await bus.emit(ToolSubjects.registryChanged, {
        revision: 1,
        reason: 'toolset-registered',
        toolsetName: 'sse-liveness-probe',
      });
      expect(notifications.length).toBeGreaterThan(0);
    });

    // A long-lived interactive session can idle indefinitely between tool
    // calls. Idle for many multiples of the timeout, across many sweeps.
    await new Promise((resolve) => setTimeout(resolve, FAST_IDLE_TIMEOUT_MS * 4));

    await expect(client.listTools()).resolves.toBeDefined();
  });

  it('admits both clients when two initialize concurrently', async () => {
    const bus = createBusInstance();
    const cleanupTools = registerEmptyToolList(bus);
    const handle = await startHttpMcpServer(bus);
    cleanups.push(async () => {
      await handle.close();
      cleanupTools();
    });

    const url = new URL(`http://127.0.0.1:${handle.port}/`);
    const first = {
      client: new Client({ name: 'a', version: '1.0.0' }),
      transport: new StreamableHTTPClientTransport(url),
    };
    const second = {
      client: new Client({ name: 'b', version: '1.0.0' }),
      transport: new StreamableHTTPClientTransport(url),
    };
    cleanups.push(() => first.client.close());
    cleanups.push(() => second.client.close());

    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);

    expect(first.transport.sessionId).toBeDefined();
    expect(second.transport.sessionId).toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    await expect(first.client.listTools()).resolves.toBeDefined();
    await expect(second.client.listTools()).resolves.toBeDefined();
  });

  it('answers 500 and leaks no bus subscription when session startup fails', async () => {
    const bus = createBusInstance();
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'start').mockRejectedValue(new Error('http startup failed'));
    const sendToolListChanged = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handle = await startHttpMcpServer(bus);
    cleanups.push(() => handle.close());

    const response = await fetch(`http://127.0.0.1:${handle.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE_BODY),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603 } });

    await bus.emit(ToolSubjects.registryChanged, {
      revision: 1,
      reason: 'toolset-registered',
      toolsetName: 'after-failed-session-start',
    });
    expect(sendToolListChanged).not.toHaveBeenCalled();
  });
});
