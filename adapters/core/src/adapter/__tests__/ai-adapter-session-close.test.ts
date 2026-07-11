/**
 * AIAdapter tests - Session close-driven agent eviction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  MockConnector,
  TestAdapter,
  createTestAdapter,
  type TestBus,
  type BaseAgentConnectorConfig,
} from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');

/** Mock connector that can fail on close for specific models. */
class FailableConnector extends MockConnector {
  public override async close(): Promise<void> {
    this.closeCalled = true;
    if (this.model === 'fail-close') {
      throw new Error('connector close failed');
    }
  }
}

describe('AIAdapter - Session close-driven agent eviction', () => {
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

  it('evicts agents when session is closed', async () => {
    const result = createTestAdapter('test-adapter');
    adapter = result.adapter;
    await adapter.init();

    const sessionId = 'test-session-1';

    // Mock agent storage handlers
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter',
            sessionId,
            adapterSessionId: 'adapter-session-1',
            status: 'idle',
            role: 'lead' as const,
            model: 'test-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
    );

    const updateStatusCalls: Array<{ agentId: string; status: string }> = [];
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        updateStatusCalls.push({ agentId: ctx.payload.agentId, status: ctx.payload.status });
        ctx.setResult({ success: true });
      }),
    );

    // Start an agent (adapter generates UUID)
    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId,
      adapterSessionId: 'adapter-session-1',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');
    const agentId = startResult.agentId;

    // Verify agent is in memory
    const agentBefore = adapter.getAgent(agentId);
    expect(agentBefore).toBeDefined();
    expect(agentBefore?.sessionId).toBe(sessionId);

    // Emit session.closed
    await MakaioBus.emit(SessionSubjects.closed, { sessionId });

    // Wait for async eviction
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify agent is evicted from memory
    const agentAfter = adapter.getAgent(agentId);
    expect(agentAfter).toBeUndefined();

    // Verify status was updated to 'dead'
    expect(updateStatusCalls).toContainEqual({ agentId, status: 'dead' });
  });

  it('evicts multiple agents from the same session', async () => {
    const result = createTestAdapter('test-adapter', {
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new FailableConnector(config),
    });
    adapter = result.adapter;
    await adapter.init();

    const sessionId = 'test-session-multi';

    // Mock agent storage handlers
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter',
            sessionId,
            adapterSessionId: 'adapter-session-1',
            status: 'idle',
            role: 'lead' as const,
            model: 'test-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
    );

    const updateStatusCalls: Array<{ agentId: string; status: string }> = [];
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        updateStatusCalls.push({ agentId: ctx.payload.agentId, status: ctx.payload.status });
        ctx.setResult({ success: true });
      }),
    );

    // Start two agents in the same session
    const start1Result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId,
      adapterSessionId: 'adapter-session-1',
      model: 'fail-close',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    const start2Result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId,
      adapterSessionId: 'adapter-session-2',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    expect(start1Result.success).toBe(true);
    expect(start2Result.success).toBe(true);
    if (!start1Result.success || !start2Result.success) throw new Error('Failed to start agents');
    const agent1Id = start1Result.agentId;
    const agent2Id = start2Result.agentId;

    // Verify both agents are in memory
    expect(adapter.getAgent(agent1Id)).toBeDefined();
    expect(adapter.getAgent(agent2Id)).toBeDefined();

    // Emit session.closed
    await MakaioBus.emit(SessionSubjects.closed, { sessionId });

    // Wait for async eviction
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify both agents are evicted
    expect(adapter.getAgent(agent1Id)).toBeUndefined();
    expect(adapter.getAgent(agent2Id)).toBeUndefined();

    // Even if one connector close fails, other agents still complete status updates.
    expect(updateStatusCalls).toContainEqual({ agentId: agent2Id, status: 'dead' });
  });

  it('does not evict agents from other sessions', async () => {
    const result = createTestAdapter('test-adapter');
    adapter = result.adapter;
    await adapter.init();

    const session1Id = 'test-session-1';
    const session2Id = 'test-session-2';

    // Mock agent storage handlers
    const agentSessionMap = new Map<string, string>();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        const sessionId = agentSessionMap.get(ctx.payload.agentId) ?? session1Id;
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter',
            sessionId,
            adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
            status: 'idle' as const,
            role: 'lead' as const,
            model: 'test-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
    );

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    // Start agents in different sessions
    const start1Result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: session1Id,
      adapterSessionId: 'adapter-session-1',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    const start2Result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: session2Id,
      adapterSessionId: 'adapter-session-2',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(start1Result.success).toBe(true);
    expect(start2Result.success).toBe(true);
    if (!start1Result.success || !start2Result.success) throw new Error('Failed to start agents');

    const agent1Id = start1Result.agentId;
    const agent2Id = start2Result.agentId;
    agentSessionMap.set(agent1Id, session1Id);
    agentSessionMap.set(agent2Id, session2Id);
    // Verify both agents are in memory
    expect(adapter.getAgent(agent1Id)).toBeDefined();
    expect(adapter.getAgent(agent2Id)).toBeDefined();
    // Close only session1
    await MakaioBus.emit(SessionSubjects.closed, { sessionId: session1Id });
    // Wait for async eviction
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Verify only agent1 is evicted
    expect(adapter.getAgent(agent1Id)).toBeUndefined();
    expect(adapter.getAgent(agent2Id)).toBeDefined();
  });
  it('catches async eviction errors triggered by agent.session.closed', async () => {
    const result = createTestAdapter('test-adapter');
    adapter = result.adapter;
    await adapter.init();
    const sessionId = 'test-session-error';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, () => {
        throw new Error('storage unavailable');
      }),
    );
    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId,
      adapterSessionId: 'adapter-session-error',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');
    await MakaioBus.emit(AgentSubjects.session.closed, {
      adapterId: adapter.adapterId,
      adapterName: 'test-adapter',
      agentId: startResult.agentId,
      adapterSessionId: 'adapter-session-error',
      reason: 'closed',
      sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
