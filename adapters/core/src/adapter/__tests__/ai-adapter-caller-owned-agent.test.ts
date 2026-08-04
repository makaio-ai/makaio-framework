/**
 * AIAdapter tests — caller-supplied agent identity.
 *
 * A caller that has already persisted the agent row supplies its `agentId`.
 * Doing so transfers the row: the adapter honours the identity and emits its
 * lifecycle events as usual, but writes no agent record of its own, because a
 * whole-record write would overwrite the lifecycle state the caller persisted
 * before dispatching. Two starts for one supplied identity are refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { type TestAdapter, createTestAdapter } from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');

describe('AIAdapter - caller-owned agent row', () => {
  let adapter: TestAdapter;
  let cleanupFns: Array<() => void> = [];
  let persistedAgentIds: string[];
  let addedAgentIds: string[];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
    persistedAgentIds = [];
    addedAgentIds = [];

    const result = createTestAdapter('test-caller-owned-adapter');
    adapter = result.adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        persistedAgentIds.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(SessionSubjects.agent.added, (ctx) => {
        addedAgentIds.push(ctx.payload.agentId);
      }),
    );
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  /**
   * Start an agent on the test adapter, optionally under a caller-supplied identity.
   * @param sessionId - Session to attach the agent to
   * @param agentId - Caller-minted agent identity, or `undefined` to let the adapter mint one
   * @returns The startAgent response
   */
  async function startAgent(
    sessionId: string,
    agentId?: string,
  ): Promise<Awaited<ReturnType<typeof MakaioBus.request<typeof AdapterSubjects.startAgent>>>> {
    return MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      sessionId,
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
      ...(agentId !== undefined && { agentId }),
    });
  }

  it('uses the supplied identity, persists no agent record, and still emits agent.added', async () => {
    const startResult = await startAgent('caller-owned-session-1', 'caller-minted-agent');

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('startAgent failed unexpectedly');
    expect(startResult.agentId).toBe('caller-minted-agent');
    // The row belongs to the caller: no whole-record write from here.
    expect(persistedAgentIds).toEqual([]);
    // Lifecycle emission is unchanged — it is what says a live agent exists.
    expect(addedAgentIds).toEqual(['caller-minted-agent']);
    expect(adapter.getAgent('caller-minted-agent')).toBeDefined();
  });

  it('refuses a supplied identity that is already registered, before dispatching', async () => {
    const first = await startAgent('caller-owned-session-2', 'duplicate-agent');
    // Asserted, not assumed: a refusal on the second start proves nothing if
    // the first never registered the identity it is supposed to collide with.
    expect(first.success).toBe(true);
    const collision = await startAgent('caller-owned-session-2', 'duplicate-agent');

    expect(collision.success).toBe(false);
    if (collision.success) throw new Error('Expected the second start to be refused');
    expect(collision.dispatch).toBe('not-dispatched');
    expect(collision.message).toContain('duplicate-agent');
    // The first agent is untouched — a refusal must not replace a live connector.
    expect(adapter.getActiveAgents()).toHaveLength(1);
  });

  it('mints the identity and persists the agent record when no agentId is supplied', async () => {
    const startResult = await startAgent('caller-owned-session-3');

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('startAgent failed unexpectedly');
    expect(persistedAgentIds).toEqual([startResult.agentId]);
    expect(addedAgentIds).toEqual([startResult.agentId]);
  });
});
