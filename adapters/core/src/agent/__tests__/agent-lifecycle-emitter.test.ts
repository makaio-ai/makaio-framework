import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import { describe, expect, it } from 'vitest';
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
): {
  emitter: AgentLifecycleEmitter;
  emittedCompletePayloads: Array<{ messageId: string; error?: string; errorCategory?: string }>;
} {
  const emittedCompletePayloads: Array<{ messageId: string; error?: string; errorCategory?: string }> = [];
  const emitter = new AgentLifecycleEmitter({
    agentId,
    globalBus: createTestBusInstance(),
    emitStarted: async () => {},
    emitComplete: async (_call, payload) => {
      emittedCompletePayloads.push(payload);
    },
    emitSessionClosed: async () => {},
    onBeforeEmitCompletion: async () => {},
    clearMessageToolCalls: () => {},
    ...overrides,
  });
  return { emitter, emittedCompletePayloads };
}

describe('AgentLifecycleEmitter', () => {
  it('deduplicates only the same message completion while allowing overlapping handles', async () => {
    let beforeEmitCount = 0;
    const clearedMessageIds: string[] = [];
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1', {
      onBeforeEmitCompletion: async () => {
        beforeEmitCount += 1;
      },
      clearMessageToolCalls: (messageId) => clearedMessageIds.push(messageId),
    });

    await emitter.emitStart(createTestCall(), { model: 'test-model', cwd: '/tmp', startMode: 'fresh' });
    await emitter.emitCompletion(createTestCall(), { messageId: 'm-1' });
    await emitter.emitCompletion(createTestCall(), { messageId: 'm-1' });
    await emitter.emitCompletion(createTestCall(), { messageId: 'm-2' });

    expect(beforeEmitCount).toBe(2);
    expect(clearedMessageIds).toEqual(['m-1', 'm-2']);
    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-1' }, { messageId: 'm-2' }]);
  });

  it('keeps sequential completion dedup bounded while suppressing a recent duplicate', async () => {
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1');
    for (let index = 0; index < 1100; index += 1) {
      await emitter.emitCompletion(createTestCall(), { messageId: `m-${index}` });
    }
    await emitter.emitCompletion(createTestCall(), { messageId: 'm-1099' });

    expect(emittedCompletePayloads).toHaveLength(1100);
  });

  it('reserves a message before an asynchronous pre-completion hook', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1', {
      onBeforeEmitCompletion: async () => gate,
    });

    const first = emitter.emitCompletion(createTestCall(), { messageId: 'm-race' });
    const duplicate = emitter.emitCompletion(createTestCall(), { messageId: 'm-race' });
    release();
    await Promise.all([first, duplicate]);

    expect(emittedCompletePayloads).toEqual([{ messageId: 'm-race' }]);
  });

  it('preserves categories on overlapping completions while deduplicating an exact duplicate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { emitter, emittedCompletePayloads } = createTestEmitter('agent-1', {
      onBeforeEmitCompletion: async () => gate,
    });

    const rateLimited = emitter.emitCompletion(createTestCall(), {
      messageId: 'm-rate-limit',
      error: 'rate limited',
      errorCategory: 'rate_limit',
    });
    const authenticationFailed = emitter.emitCompletion(createTestCall(), {
      messageId: 'm-auth',
      error: 'authentication failed',
      errorCategory: 'auth',
    });
    const duplicateRateLimited = emitter.emitCompletion(createTestCall(), {
      messageId: 'm-rate-limit',
      error: 'rate limited',
      errorCategory: 'rate_limit',
    });
    release();
    await Promise.all([rateLimited, authenticationFailed, duplicateRateLimited]);

    expect(emittedCompletePayloads).toEqual([
      { messageId: 'm-rate-limit', error: 'rate limited', errorCategory: 'rate_limit' },
      { messageId: 'm-auth', error: 'authentication failed', errorCategory: 'auth' },
    ]);
  });
});
