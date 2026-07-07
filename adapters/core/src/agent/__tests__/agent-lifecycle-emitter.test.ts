import { describe, expect, it, vi } from 'vitest';
import { AgentLifecycleEmitter } from '../agent-lifecycle-emitter.js';
import type { AgentLifecycleEmitterConfig } from '../agent-lifecycle-emitter.js';

/**
 * Build a test emitter with captured completion payloads.
 * @param agentId - Stable test agent identifier
 * @param overrides - Optional config overrides
 * @returns Emitter instance plus captured payloads
 */
function createTestEmitter(
  agentId: string,
  overrides: Partial<AgentLifecycleEmitterConfig> = {},
): { emitter: AgentLifecycleEmitter; emittedCompletePayloads: Array<{ messageId: string; errorCategory?: string }> } {
  const emittedCompletePayloads: Array<{ messageId: string; errorCategory?: string }> = [];
  const emitter = new AgentLifecycleEmitter({
    agentId,
    globalBus: { requestOptional: vi.fn() } as never,
    emitStarted: async () => {},
    emitComplete: async (payload) => {
      emittedCompletePayloads.push(payload as { messageId: string; errorCategory?: string });
    },
    emitSessionClosed: async () => {},
    onBeforeEmitCompletion: async () => {},
    clearToolCallTracker: () => {},
    ...overrides,
  });
  return { emitter, emittedCompletePayloads };
}

describe('AgentLifecycleEmitter', () => {
  it('clears pending error category when a new turn starts', async () => {
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1');

    emitter.emitError({ error: 'rate limited', errorCategory: 'rate_limit' });
    await emitter.emitStart({ model: 'test-model', cwd: '/tmp', startMode: 'fresh' });
    await emitter.emitCompletion({ messageId: 'm-1' });

    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-1' }]);
  });

  it('emits completion only once per turn', async () => {
    let beforeEmitCount = 0;
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1', {
      onBeforeEmitCompletion: async () => {
        beforeEmitCount += 1;
      },
    });

    await emitter.emitStart({ model: 'test-model', cwd: '/tmp', startMode: 'fresh' });
    await emitter.emitCompletion({ messageId: 'm-1' });
    await emitter.emitCompletion({ messageId: 'm-2' });

    expect(beforeEmitCount).toBe(1);
    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-1' }]);
  });

  it('resetTurnState allows completion on subsequent turns without emitStart', async () => {
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1');

    // First turn via emitStart (normal path)
    await emitter.emitStart({ model: 'test-model', cwd: '/tmp', startMode: 'fresh' });
    await emitter.emitCompletion({ messageId: 'm-1' });

    // Second turn: only resetTurnState, no emitStart (codex pattern)
    emitter.resetTurnState();
    await emitter.emitCompletion({ messageId: 'm-2' });

    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-1' }, { messageId: 'm-2' }]);
  });

  it('resetTurnState clears pending error category', async () => {
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1');

    await emitter.emitStart({ model: 'test-model', cwd: '/tmp', startMode: 'fresh' });
    emitter.emitError({ error: 'failed', errorCategory: 'rate_limit' });
    emitter.resetTurnState();
    await emitter.emitCompletion({ messageId: 'm-1' });

    // Error category was cleared by resetTurnState
    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-1' }]);
  });
});
