/**
 * AIAdapter tests - Idle fork start persists undefined adapterSessionId.
 *
 * Invariant: only provider-confirmed adapter session IDs are persisted or
 * emitted. A fork child started idle persists adapterSessionId: undefined;
 * on first confirmation the reconciliation path fills it in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  type TestAdapter,
  createTestAdapter,
  MockConnector,
  TestAgent,
  type TestBus,
  type BaseAgentConnectorConfig,
} from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');

/**
 * Connector simulating fork-session behavior where the provider has not yet
 * confirmed the session ID. `initialize()` sets a local placeholder on
 * `adapterSessionId`, but `getConfirmedAdapterSessionId()` returns
 * `undefined` because the provider hasn't confirmed yet.
 */
class ForkSimulatingConnector extends MockConnector {
  public override async initialize(): Promise<void> {
    this.adapterSessionId = 'fork-local-placeholder-id';
  }

  /** Provider has not confirmed — return undefined. */
  public override getConfirmedAdapterSessionId(): string | undefined {
    return undefined;
  }

  public override async getAdapterSessionId(): Promise<string> {
    return new Promise<string>(() => {});
  }
}

describe('AIAdapter - fork idle start', () => {
  let adapter: TestAdapter;
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  it('persists undefined adapterSessionId for idle fork start', async () => {
    let persistedAgent: Record<string, unknown> | undefined;

    const result = createTestAdapter('test-fork-adapter', {
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new ForkSimulatingConnector(config),
    });
    adapter = result.adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        persistedAgent = ctx.payload.agent as Record<string, unknown>;
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      mode: 'fork' as const,
      sessionId: 'fork-session-1',
      sourceSessionId: 'parent-session-1',
      sourceAdapterSessionId: 'parent-adapter-session-1',
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('startAgent failed unexpectedly');

    // Returned adapterSessionId must be undefined (unconfirmed)
    expect(startResult.adapterSessionId).toBeUndefined();

    // Persisted agent record must have undefined adapterSessionId
    expect(persistedAgent).toBeDefined();
    expect(persistedAgent!.adapterSessionId).toBeUndefined();
    expect(persistedAgent!.runtimeOwner).toEqual({
      machineId: 'test-machine',
      instanceId: adapter.ownerInstanceId,
    });

    const activeAgent = adapter.getAgent(startResult.agentId);
    expect(activeAgent).toBeDefined();
    if (!activeAgent) throw new Error('Expected active agent handle');
    expect(activeAgent.adapterSessionId).toBeUndefined();
    expect(activeAgent.agent).toBeInstanceOf(TestAgent);

    const listedAgent = adapter.getActiveAgents()[0];
    expect(listedAgent).toBeDefined();
    if (!listedAgent) throw new Error('Expected listed agent handle');
    expect(listedAgent.adapterSessionId).toBeUndefined();
  });

  it('returns without hanging when no initialMessage is provided', async () => {
    const result = createTestAdapter('test-fork-adapter', {
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new ForkSimulatingConnector(config),
    });
    adapter = result.adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      mode: 'fork' as const,
      sessionId: 'fork-session-2',
      sourceSessionId: 'parent-session-1',
      sourceAdapterSessionId: 'parent-adapter-session-1',
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(startResult.success).toBe(true);
  });
});
