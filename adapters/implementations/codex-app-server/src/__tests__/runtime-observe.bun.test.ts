/**
 * Tests for CodexAppServerAgent — client.runtime.observe producer path
 *
 * Verifies that the agent emits a best-effort `client.runtime.observe` request
 * on the global bus when a Codex thread starts and the adapter session ID is
 * available as strong evidence.
 *
 * Test setup: creates a real CodexAppServerConnector (via the shared test
 * context helper) and wires a CodexAppServerAgent on top of it. Connector
 * notifications are injected through the mock JSON-RPC client so the full
 * agent event-wiring path is exercised without a live subprocess.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientRuntimeObserveRequest } from '@makaio/contracts';
import { CodexAppServerAgent } from '../agent.js';
import { CodexAppServerConfig } from '../config.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithThread,
  type ConnectorTestContext,
} from './shared.js';
import { waitFor } from '@makaio/test-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CodexAppServerAgent wired to the connector from an existing test
 * context. The agent is initialized immediately so event subscriptions are
 * active before the first connector notification arrives.
 * @param ctx - Connector test context
 * @param clientId - Client ID for observation payloads (default: 'codex')
 * @returns The initialized agent instance
 */
async function createAgentForContext(ctx: ConnectorTestContext, clientId = 'codex'): Promise<CodexAppServerAgent> {
  const agent = new CodexAppServerAgent({
    agentId: 'test-agent',
    adapterId: 'test-adapter',
    adapterName: 'codex-app-server',
    capabilities: ['tools', 'streaming'],
    nativeTools: ['bash', 'patch'],
    adapterBus: ctx.mockBus,
    clientId,
    globalBus: MakaioBus,
    model: 'claude-3-5-sonnet-20241022',
    configFactory: CodexAppServerConfig.getConfig,
    // Return the already-created connector so the agent wires against it directly.
    connectorFactory: () => ctx.connector,
  });
  await agent.init();
  return agent;
}

/**
 * Register a request handler for `client.runtime.observe` that collects
 * incoming payloads and satisfies the request with a stub response.
 *
 * The handler must call `ctx.setResult()` — returning a value directly is not
 * how the bus request contract works.
 *
 * Returns both the collected payloads array and a cleanup function.
 * @returns Tuple of [payloads array, cleanup function]
 */
function captureRuntimeObserveRequests(): [ClientRuntimeObserveRequest[], () => void] {
  const captured: ClientRuntimeObserveRequest[] = [];
  const cleanup = MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
    captured.push(ctx.payload);
    ctx.setResult({ clientRuntimeId: 'stub-runtime-id', created: true, promoted: false });
  });
  return [captured, cleanup];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAppServerAgent — client.runtime.observe producer', () => {
  let ctx: ConnectorTestContext;

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    MakaioBus.__resetHandlers?.();
  });

  it('emits client.runtime.observe when thread/started arrives with an adapter session ID', async () => {
    ctx = await createConnectorTestContext();
    await createAgentForContext(ctx);

    const [captured, cleanup] = captureRuntimeObserveRequests();
    try {
      await startConnectorWithThread(ctx);
      await waitFor(() => expect(captured).toHaveLength(1));
    } finally {
      cleanup();
    }

    expect(captured[0]).toMatchObject({
      clientId: 'codex',
      source: { layer: 'adapter', producer: 'codex-app-server' },
      observedAt: expect.any(Number),
      adapterSessionId: 'thread-123',
    });
  });

  it('forwards clientId from agent config into the observe request', async () => {
    ctx = await createConnectorTestContext();
    await createAgentForContext(ctx, 'codex-custom');

    const [captured, cleanup] = captureRuntimeObserveRequests();
    try {
      await startConnectorWithThread(ctx);
      await waitFor(() => expect(captured).toHaveLength(1));
    } finally {
      cleanup();
    }

    expect(captured[0].clientId).toBe('codex-custom');
  });

  it('includes an observedAt timestamp that is a recent epoch millisecond value', async () => {
    const before = Date.now();
    ctx = await createConnectorTestContext();
    await createAgentForContext(ctx);

    const [captured, cleanup] = captureRuntimeObserveRequests();
    try {
      await startConnectorWithThread(ctx);
      await waitFor(() => expect(captured).toHaveLength(1));
    } finally {
      cleanup();
    }

    const after = Date.now();
    const { observedAt } = captured[0];
    expect(observedAt).toBeGreaterThanOrEqual(before);
    expect(observedAt).toBeLessThanOrEqual(after);
  });

  it('does not emit client.runtime.observe when no handler is registered (best-effort: no throw)', async () => {
    ctx = await createConnectorTestContext();
    await createAgentForContext(ctx);

    // No handler registered — requestOptional should silently return { handled: false }
    await expect(startConnectorWithThread(ctx)).resolves.toBeDefined();
    // If we reach here without throwing, the best-effort invariant is upheld
  });

  it('does not crash when the runtime.observe handler rejects with an actual error (best-effort swallowing)', async () => {
    ctx = await createConnectorTestContext();
    await createAgentForContext(ctx);

    // Register a handler that rejects with a real error, not a NoHandlerError.
    // requestOptional re-throws non-NoHandlerError rejections, so the .catch()
    // guard in the agent's thread-started path is the only thing keeping the
    // thread lifecycle alive. If the guard is absent the promise rejects silently
    // but the thread started flow still completes — this test verifies exactly that.
    const cleanup = MakaioBus.on(ClientSubjects.runtime.observe, () => {
      throw new Error('simulated handler failure');
    });
    try {
      // The connector start flow must complete without throwing despite the
      // handler error — the best-effort invariant forbids blocking the lifecycle.
      await expect(startConnectorWithThread(ctx)).resolves.toBeDefined();
    } finally {
      cleanup();
    }
  });
});
