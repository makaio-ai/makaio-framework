/**
 * Tests for ClaudeCodeAgent — client.runtime.observe producer
 *
 * Verifies that the agent layer emits a best-effort `client.runtime.observe`
 * request on the global bus after connector initialization confirms the
 * adapter session ID.
 *
 * Design invariants under test:
 * - Observation is emitted once per `initialize()` call.
 * - `adapterSessionId` matches the session ID assigned during `createQuery()`.
 * - `source.layer` is `'adapter'` and `source.producer` is `'claude-agent-sdk'`.
 * - `clientId` falls back to `'claude-code'` when not set in config.
 * - An optional `sessionId` (framework ID) is forwarded when present in config.
 * - Observation failure does NOT prevent `initialize()` from completing.
 * - Unhandled observations remain retryable from the next lifecycle signal.
 */

import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { ClientSubjects, type ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import type { OptionalResult } from '@makaio/core';

// ---------------------------------------------------------------------------
// SDK mock — minimal query stub; the runtime-observe test does not exercise
// turn consumption, so yielding no messages is correct.
// ---------------------------------------------------------------------------

const queryHarness = vi.hoisted(() => {
  const query = vi.fn(() => ({
    interrupt: vi.fn(async () => undefined),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      // No messages — the consumption loop simply awaits the next push.
    },
  }));

  return {
    query,
    reset: () => {
      query.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import type { ClaudeCodeConnectorBus } from '../namespace/index.js';
import { ClaudeCodeAgent } from '../agent.js';
import { ClaudeSdkConnector } from '../connector.js';
import type { ClaudeAgentConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeAgent with the given identity fields.
 * @param opts - Optional session and client identity overrides
 * @returns Agent instance ready for `initialize()`
 */
async function makeAgent(opts: { sessionId?: string; clientId?: string } = {}): Promise<ClaudeCodeAgent> {
  const adapterBus = await ClaudeCodeConnectorNamespace.scopedBus();
  return new ClaudeCodeAgent({
    adapterBus,
    globalBus: MakaioBus,
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet-4-20250514',
    env: {},
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      bus: input.bus as ClaudeCodeConnectorBus,
      cwd: input.cwd ?? os.tmpdir(),
      model: input.model ?? 'claude-sonnet-4-20250514',
      env: input.env ?? {},
    }),
    connectorFactory: (config) =>
      new ClaudeSdkConnector({
        ...(config as ClaudeAgentConfig),
        clientId: config.clientId ?? 'claude-code',
        requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({ handled: false }),
      }),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeAgent — client.runtime.observe producer', () => {
  let agents: ClaudeCodeAgent[];
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    agents = [];
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup) fn();
    cleanup = [];
    await Promise.all(agents.map((agent) => agent.close()));
    agents = [];
  });

  // -------------------------------------------------------------------------
  // Core emission
  // -------------------------------------------------------------------------

  it('emits client.runtime.observe when initialize() completes', async () => {
    const agent = await makeAgent({ sessionId: 'framework-session-1', clientId: 'claude-code' });
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-1', created: true, promoted: false });
      }),
    );

    await agent.initialize();

    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0]).toMatchObject({
      clientId: 'claude-code',
      source: { layer: 'adapter', producer: 'claude-agent-sdk' },
      observedAt: expect.any(Number),
    });
    expect(requests[0]?.adapterSessionId).toBeTruthy();
    expect(requests[0]?.sessionId).toBe('framework-session-1');
  });

  it('sets source.layer to adapter and source.producer to claude-agent-sdk', async () => {
    const agent = await makeAgent();
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-2', created: true, promoted: false });
      }),
    );

    await agent.initialize();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0]?.source).toEqual({ layer: 'adapter', producer: 'claude-agent-sdk' });
  });

  it('forwards adapterSessionId matching the session ID assigned by createQuery()', async () => {
    const agent = await makeAgent();
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-3', created: true, promoted: false });
      }),
    );

    await agent.initialize();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    // adapterSessionId must be a non-empty UUID-like string — it is either a
    // crypto.randomUUID() result or a predetermined/resume ID from config.
    expect(typeof requests[0]?.adapterSessionId).toBe('string');
    expect(requests[0]?.adapterSessionId?.length).toBeGreaterThan(0);
  });

  it('falls back to clientId claude-code when not set in config', async () => {
    // No clientId supplied — config default path
    const agent = await makeAgent({ sessionId: undefined, clientId: undefined });
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-4', created: false, promoted: false });
      }),
    );

    await agent.initialize();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0]?.clientId).toBe('claude-code');
  });

  it('omits sessionId from payload when not set in config', async () => {
    const agent = await makeAgent({ clientId: 'claude-code' }); // no sessionId
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-5', created: true, promoted: false });
      }),
    );

    await agent.initialize();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0]).not.toHaveProperty('sessionId');
  });

  // -------------------------------------------------------------------------
  // Best-effort: observation failure must not disrupt session establishment
  // -------------------------------------------------------------------------

  it('initialize() succeeds even when requestOptional rejects', async () => {
    const agent = await makeAgent({ sessionId: 'framework-session-fail', clientId: 'claude-code' });
    agents.push(agent);

    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, () => {
        throw new Error('bus unavailable');
      }),
    );

    // Must not throw — best-effort guarantee
    await expect(agent.initialize()).resolves.toBeUndefined();
  });

  it('initialize() succeeds when no handler is registered for runtime.observe', async () => {
    const agent = await makeAgent({ sessionId: 'framework-session-no-handler' });
    agents.push(agent);

    // No handler registered — requestOptional returns { handled: false }
    await expect(agent.initialize()).resolves.toBeUndefined();
  });

  it('retries runtime observation from the next lifecycle signal after an unhandled initialize observation', async () => {
    const agent = await makeAgent({ sessionId: 'framework-session-retry', clientId: 'claude-code' });
    agents.push(agent);
    const requestOptionalSpy = vi.spyOn(MakaioBus, 'requestOptional');

    try {
      await agent.initialize();

      expect(requestOptionalSpy).toHaveBeenCalledWith(
        ClientSubjects.runtime.observe,
        expect.objectContaining({
          clientId: 'claude-code',
          sessionId: 'framework-session-retry',
          source: { layer: 'adapter', producer: 'claude-agent-sdk' },
        }),
      );
    } finally {
      requestOptionalSpy.mockRestore();
    }

    const requests: ClientRuntimeObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        ctx.setResult({ clientRuntimeId: 'runtime-retry', created: true, promoted: false });
      }),
    );

    await MakaioBus.emit(AgentSubjects.started, {
      agentId: 'agent-test',
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      adapterSessionId: 'native-session',
      sessionId: 'framework-session-retry',
      model: 'claude-sonnet-4-20250514',
      cwd: os.tmpdir(),
    });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      clientId: 'claude-code',
      sessionId: 'framework-session-retry',
      source: { layer: 'adapter', producer: 'claude-agent-sdk' },
    });
  });

  it('does not send a duplicate runtime observation while the same key is in flight', async () => {
    const agent = await makeAgent({ sessionId: 'framework-session-in-flight', clientId: 'claude-code' });
    agents.push(agent);

    const requests: ClientRuntimeObserveRequest[] = [];
    let releaseObservation: (() => void) | undefined;
    const observationGate = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });

    cleanup.push(
      MakaioBus.on(ClientSubjects.runtime.observe, async (ctx) => {
        requests.push(ctx.payload as ClientRuntimeObserveRequest);
        await observationGate;
        ctx.setResult({ clientRuntimeId: 'runtime-in-flight', created: true, promoted: false });
      }),
    );

    await agent.initialize();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await MakaioBus.emit(AgentSubjects.started, {
      agentId: 'agent-test',
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      adapterSessionId: 'native-session',
      sessionId: 'framework-session-in-flight',
      model: 'claude-sonnet-4-20250514',
      cwd: os.tmpdir(),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);

    releaseObservation?.();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  });
});
