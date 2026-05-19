import { describe, expect, it } from 'bun:test';
import { AgentEventBridge } from '../agent-event-bridge.js';

describe('AgentEventBridge', () => {
  it('guards context window percentage when maxTokens is zero', async () => {
    const emittedContextWindowPayloads: unknown[] = [];
    const bridge = new AgentEventBridge({
      emitUsage: async () => {},
      emitContextWindowUpdated: async (payload) => {
        emittedContextWindowPayloads.push(payload);
      },
      emitToolUse: async () => {},
      emitToolOutput: async () => {},
      emitAdapterLog: async () => {},
      emitStepStarted: async () => {},
      emitStepFinished: async () => {},
      toolCallTracker: {
        register: () => 'tool-call-id',
        resolve: () => ({ correlationId: 'tool-call-id', strategy: 'exact' }),
      } as never,
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
    });

    await bridge.emitContextWindowUpdate({
      currentTokens: 42,
      maxTokens: 0,
      cachedTokens: 5,
    });

    expect(emittedContextWindowPayloads).toEqual([
      {
        currentTokens: 42,
        maxTokens: 0,
        cachedTokens: 5,
        percentage: 0,
        level: 'critical',
      },
    ]);
  });
});
