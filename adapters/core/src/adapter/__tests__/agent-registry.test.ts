import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { AIAgent } from '../../agent/ai-agent.js';
import { ActiveAgentRegistry } from '../agent-registry.js';

/**
 * Create the minimal agent surface needed by ActiveAgentRegistry eviction tests.
 * @param close - Close implementation used by the test.
 * @returns Agent-compatible close-only test double.
 */
function createCloseOnlyAgent(close: (options?: { emitSessionClosed?: boolean }) => Promise<void>): AIAgent {
  return { close } as AIAgent;
}

describe('ActiveAgentRegistry', () => {
  /**
   * Creates a fresh registry instance with zero configuration overhead.
   * @returns Registry for test use
   */
  function createRegistry(): InstanceType<typeof ActiveAgentRegistry> {
    return new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'test-adapter' });
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
        agent: createCloseOnlyAgent(async () => {}),
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
        agent: createCloseOnlyAgent(async () => {}),
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

  describe('set auto-clears pending claim', () => {
    it('clears the pending claim when registering an entry with the same adapterSessionId', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => {}),
        sessionId: 's1',
        adapterSessionId: 'session-A',
        usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
      });
      // The claim is gone; a new claim for the same session should fail
      // because the registered entry now holds it.
      expect(registry.claimAdapterSession('session-A')).toBe(false);
      // But hasAdapterSession still returns true (via the entry).
      expect(registry.hasAdapterSession('session-A')).toBe(true);
    });
  });

  describe('clear resets claims', () => {
    it('removes all entries and pending claims', () => {
      const registry = createRegistry();
      registry.claimAdapterSession('session-A');
      registry.set('agent-1', {
        agent: createCloseOnlyAgent(async () => {}),
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

  it('persists dead status before rethrowing an evicted agent close failure', async () => {
    const closeError = new Error('close failed');
    const updates: Array<{ agentId: string; status: string }> = [];
    const cleanup = MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      updates.push(ctx.payload);
      ctx.setResult({ success: true });
    });

    try {
      const registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'test-adapter' });
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
