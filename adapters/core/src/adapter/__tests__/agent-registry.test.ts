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
