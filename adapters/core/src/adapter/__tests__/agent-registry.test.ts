import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { AIAgent } from '../../agent/ai-agent.js';
import { ConfirmedAdapterSessionTracker } from '../../agent/agent-adapter-session-movement.js';
import { AgentTeardownArbiter } from '../../agent/agent-teardown-arbiter.js';
import type { TeardownReport } from '../../connector/teardown-report.js';
import { ActiveAgentRegistry } from '../agent-registry.js';

/**
 * Create the minimal agent surface needed by ActiveAgentRegistry eviction tests.
 * @param close - Close implementation used by the test.
 * @returns Agent-compatible close-only test double.
 */
function createCloseOnlyAgent(close: (options?: { emitSessionClosed?: boolean }) => Promise<TeardownReport>): AIAgent {
  return { close } as AIAgent;
}

describe('ActiveAgentRegistry', () => {
  /**
   * Creates a fresh registry instance with zero configuration overhead.
   * @returns Registry for test use
   */
  function createRegistry(): InstanceType<typeof ActiveAgentRegistry> {
    return new ActiveAgentRegistry({
      globalBus: MakaioBus,
      adapterName: 'test-adapter',
      ownerInstanceId: 'test-owner-instance',
      arbiter: new AgentTeardownArbiter(),
    });
  }

  describe('claimAdapterSession', () => {
    it('grants the first claim for an unclaimed adapterSessionId', () => {
      const registry = createRegistry();
      expect(registry.claimAdapterSession('session-A')).toBe(true);
    });

    it('rejects a second claim for the same adapterSessionId', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      expect(registry.claimAdapterSession('session-A')).toBe(false);
    });

    it('rejects a claim when a registered entry already holds the adapterSessionId', () => {
      const registry = createRegistry();
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
        sessionId: 's1',
        adapterSessionId: 'session-A',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      expect(registry.claimAdapterSession('session-A')).toBe(false);
    });

    it('allows claims for different adapterSessionIds', () => {
      const registry = createRegistry();
      expect(registry.claimAdapterSession('session-A')).toBe(true);
      expect(registry.claimAdapterSession('session-B')).toBe(true);
    });
  });

  describe('releaseAdapterSessionClaim', () => {
    it('allows re-claiming after release', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      registry.releaseAdapterSessionClaim('session-A');
      expect(registry.claimAdapterSession('session-A')).toBe(true);
    });

    it('is a no-op for unclaimed sessions', () => {
      const registry = createRegistry();
      // Should not throw
      registry.releaseAdapterSessionClaim('nonexistent');
    });
  });

  describe('hasAdapterSession', () => {
    it('returns true for a claimed session', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      expect(registry.hasAdapterSession('session-A')).toBe(true);
    });

    it('returns true for a registered entry', () => {
      const registry = createRegistry();
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
        sessionId: 's1',
        adapterSessionId: 'session-A',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      expect(registry.hasAdapterSession('session-A')).toBe(true);
    });

    it('returns false for an unknown session', () => {
      const registry = createRegistry();
      expect(registry.hasAdapterSession('session-X')).toBe(false);
    });
  });

  describe('set settles pending claims', () => {
    it('clears the pending claim when a start registers the identity it claimed', () => {
      // Settlement is keyed on the claim the start passes, never on the
      // registered identity — so a start that claims and keeps the same ID
      // must hand its claim to set() like every other start path.
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      registry.set(
        'agent-1',
        {
          agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
          sessionId: 's1',
          adapterSessionId: 'session-A',
          usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
        },
        'session-A',
      );
      // The claim is gone; a new claim for the same session should fail
      // because the registered entry now holds it.
      expect(registry.claimAdapterSession('session-A')).toBe(false);
      // But hasAdapterSession still returns true (via the entry).
      expect(registry.hasAdapterSession('session-A')).toBe(true);
    });

    it('keeps a concurrent claim that coincides with the registered identity', async () => {
      // Start A rotates onto the very session a concurrent start B has
      // claimed. A's registration must not settle B's claim: releasing by
      // registered identity would silently destroy it, and after A's entry
      // leaves the registry the session would be claimable while B is still
      // starting — a second writer for the same provider session.
      const registry = createRegistry();
      registry.claimAdapterSession('session-Y');

      registry.set('agent-A', {
        agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
        sessionId: 's1',
        adapterSessionId: 'session-Y',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      await registry.evictSilently('agent-A');

      expect(registry.claimAdapterSession('session-Y')).toBe(false);
    });

    it('releases a claimed resume target the start rotated away from', () => {
      // A start that suppresses native resume abandons the armed target and the
      // connector mints its own session. Releasing only the registered identity
      // would strand the abandoned target for the adapter's lifetime.
      const registry = createRegistry();
      registry.claimAdapterSession('session-claimed');
      registry.set(
        'agent-1',
        {
          agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
          sessionId: 's1',
          adapterSessionId: 'session-minted',
          usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
        },
        'session-claimed',
      );

      expect(registry.hasAdapterSession('session-claimed')).toBe(false);
      expect(registry.claimAdapterSession('session-claimed')).toBe(true);
      // The identity the agent actually occupies stays held by the entry.
      expect(registry.claimAdapterSession('session-minted')).toBe(false);
    });

    it('leaves a concurrent start’s in-flight claim untouched', () => {
      // Counter-probe to the case above: settlement is scoped to the claim this
      // start made, so registering one agent must not free the provider session
      // another start is still working on.
      const registry = createRegistry();
      registry.claimAdapterSession('session-inflight');

      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
        sessionId: 's1',
        adapterSessionId: 'session-other',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });

      expect(registry.hasAdapterSession('session-inflight')).toBe(true);
      expect(registry.claimAdapterSession('session-inflight')).toBe(false);
    });
  });

  describe('occupancy follows the agent’s live confirmed identity', () => {
    /**
     * Register an entry whose live identity is owned by a real movement tracker.
     *
     * The tracker is the production source of `AIAgent.currentAdapterSessionId`,
     * so driving it exercises the same ordering a connector swap produces instead
     * of asserting against a hand-set field.
     * @param registry - Registry to register the entry in
     * @param registeredAdapterSessionId - Identity the entry was registered with
     * @returns The agent's movement tracker
     */
    function registerTrackedAgent(
      registry: InstanceType<typeof ActiveAgentRegistry>,
      registeredAdapterSessionId: string | undefined,
    ): ConfirmedAdapterSessionTracker {
      const tracker = new ConfirmedAdapterSessionTracker(MakaioBus, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        machineId: 'test-machine',
        ownerInstanceId: 'test-owner-instance',
        sessionId: 'session-1',
      });
      const agent = {
        close: async (): Promise<TeardownReport> => ({ evidence: 'released' }),
        get currentAdapterSessionId(): string | undefined {
          return tracker.lastKnownAdapterSessionId;
        },
      } as AIAgent;
      registry.set('agent-1', {
        agent,
        sessionId: 'session-1',
        adapterSessionId: registeredAdapterSessionId,
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      return tracker;
    }

    it('denies a claim for the swapped-in session before the entry field catches up', async () => {
      // The post-swap/pre-usage window: the movement seam has published the
      // replacement ID as the session row's resume currency, but the entry field
      // is only reconciled by the agent's next usage event. A resume attach
      // resolving that fresh currency must still find this agent occupying it.
      const registry = createRegistry();
      const tracker = registerTrackedAgent(registry, 'session-old');

      await tracker.record('session-new');

      expect(registry.claimAdapterSession('session-new')).toBe(false);
      expect(registry.hasAdapterSession('session-new')).toBe(true);
    });

    it('has the occupancy visible to a consumer applying the movement', async () => {
      // Duty 5 of the movement seam: occupancy evidence precedes the
      // announcement. The currency write runs inside the announcement, so the
      // claim must already be denied at that instant — not merely once the
      // producer's await resolves.
      const registry = createRegistry();
      const tracker = registerTrackedAgent(registry, 'session-old');
      let claimDuringAnnouncement: boolean | undefined;
      const consumer = MakaioBus.on(AgentSubjects.adapterSession.moved, () => {
        claimDuringAnnouncement = registry.claimAdapterSession('session-new');
      });

      try {
        await tracker.record('session-new');
      } finally {
        consumer();
      }

      expect(claimDuringAnnouncement).toBe(false);
    });

    it('still reports a pinned identity the provider has not confirmed yet', () => {
      // The live value is undefined until the first confirmation, so the
      // registered field remains the fallback rather than being replaced.
      const registry = createRegistry();
      registerTrackedAgent(registry, 'session-pinned');

      expect(registry.hasAdapterSession('session-pinned')).toBe(true);
      expect(registry.claimAdapterSession('session-pinned')).toBe(false);
    });

    it('reports no occupancy for an idle fork start that has neither identity', () => {
      const registry = createRegistry();
      registerTrackedAgent(registry, undefined);

      expect(registry.hasAdapterSession('session-any')).toBe(false);
    });

    it('releases the abandoned session once the agent confirmed a successor', async () => {
      // The complement of the first case: the old provider thread is abandoned,
      // so it must stop counting as occupied and become claimable again.
      const registry = createRegistry();
      const tracker = registerTrackedAgent(registry, 'session-old');

      await tracker.record('session-new');

      expect(registry.claimAdapterSession('session-old')).toBe(true);
    });
  });

  describe('clear resets claims', () => {
    it('removes all entries and pending claims', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => ({ evidence: 'released' })),
        sessionId: 's1',
        adapterSessionId: 'session-B',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      registry.clear();
      expect(registry.hasAdapterSession('session-A')).toBe(false);
      expect(registry.hasAdapterSession('session-B')).toBe(false);
      // Claims can be re-granted after clear.
      expect(registry.claimAdapterSession('session-A')).toBe(true);
    });
  });

  describe('start admission', () => {
    it('reopens admission only after entered starts drain and shutdown settles', async () => {
      const registry = createRegistry();
      const endStart = registry.beginStart();
      if (endStart === undefined) throw new Error('fresh registry refused a start');

      const close = registry.closeAll();
      expect(registry.beginStart()).toBeUndefined();
      expect(() => registry.reopen()).toThrow(/cannot reopen before shutdown fully settles/);
      endStart();

      await expect(close).resolves.toEqual([]);
      registry.reopen();
      const endReopenedStart = registry.beginStart();
      expect(endReopenedStart).toBeTypeOf('function');
      endReopenedStart?.();
    });
  });

  it('never strengthens weak teardown evidence after the registry entry is gone', async () => {
    const registry = createRegistry();
    registry.set('agent-weak', {
      agent: createCloseOnlyAgent(async () => ({ evidence: 'detached', detail: 'exit was not observed' })),
      sessionId: 'session-weak',
      adapterSessionId: undefined,
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
    });

    await expect(registry.dispose('agent-weak')).resolves.toMatchObject({ found: true, evidence: 'detached' });
    await expect(registry.dispose('agent-weak')).resolves.toMatchObject({ found: false, evidence: 'detached' });
    await expect(registry.closeAll()).resolves.toEqual([
      expect.objectContaining({ evidence: 'detached', detail: 'exit was not observed' }),
    ]);
  });

  it('persists dead status before rethrowing an evicted agent close failure', async () => {
    const closeError = new Error('close failed');
    const updates: Array<{ agentId: string; status: string }> = [];
    const cleanup = MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      updates.push(ctx.payload);
      ctx.setResult({ success: true, transitioned: true });
    });

    try {
      const registry = new ActiveAgentRegistry({
        globalBus: MakaioBus,
        adapterName: 'test-adapter',
        ownerInstanceId: 'test-owner-instance',
        arbiter: new AgentTeardownArbiter(),
      });
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => {
          throw closeError;
        }),
        sessionId: 'session-1',
        adapterSessionId: 'adapter-session-1',
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCalls: 0,
        },
      });

      await expect(registry.evict('agent-1')).rejects.toBe(closeError);

      expect(updates).toEqual([{ agentId: 'agent-1', status: 'dead' }]);
      expect(registry.get('agent-1')).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
