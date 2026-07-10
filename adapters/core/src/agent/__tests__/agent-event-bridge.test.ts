import { describe, expect, it } from 'vitest';
import { MessageHandle } from '../../message-handle/index.js';
import { MessageLifecycleTracker } from '../message-lifecycle-tracker.js';
import { AgentEventBridge } from '../agent-event-bridge.js';
import type { NormalizedCallUsage } from '../types.js';

const normalizedUsage = {
  provider: 'test-provider',
  granularity: 'provider-call',
  inputTokens: 1,
  inputCachedTokens: 0,
  outputTokens: 2,
  reasoningTokens: 0,
  totalTokens: 3,
  costUnits: 3,
  costUnitType: 'tokens',
} satisfies NormalizedCallUsage;

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
      getActiveMessageHandle: () => undefined,
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

  it('correlates usage emitted before acknowledgment when handle is tracked at dispatch time', async () => {
    const emittedUsagePayloads: Array<Record<string, unknown>> = [];
    const lifecycleTracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const bridge = new AgentEventBridge({
      emitUsage: async (payload) => {
        emittedUsagePayloads.push(payload);
      },
      emitContextWindowUpdated: async () => {},
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
      getActiveMessageHandle: () => lifecycleTracker.getCurrentMessageHandle(),
    });
    const handle = new MessageHandle(
      'message-pre-ack',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { executionId: 'exec-1', frameId: 'frame-1' },
    );

    // track() sets the handle eagerly — usage emitted before acknowledgment
    // (e.g. result-only streams) must still carry correlation.
    lifecycleTracker.track(handle);

    // Usage arrives before the provider sends user.isReplay acknowledgment.
    await bridge.trackUsage(normalizedUsage);
    expect(emittedUsagePayloads).toEqual([
      { ...normalizedUsage, executionId: 'exec-1', frameId: 'frame-1', model: 'test-model' },
    ]);

    // Acknowledge + complete to clean up lifecycle state.
    handle.markAcknowledged();
    handle.markCompleted({ outcome: 'completed' });
  });

  it('adds active request execution correlation to usage without replacing provider fields', async () => {
    const emittedUsagePayloads: Array<Record<string, unknown>> = [];
    const lifecycleTracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const bridge = new AgentEventBridge({
      emitUsage: async (payload) => {
        emittedUsagePayloads.push(payload);
      },
      emitContextWindowUpdated: async () => {},
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
      getActiveMessageHandle: () => lifecycleTracker.getCurrentMessageHandle(),
    });
    const firstHandle = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { executionId: 'execution-a', frameId: 'frame-a' },
    );
    const secondHandle = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { executionId: 'execution-b', frameId: 'frame-b' },
    );

    await bridge.trackUsage(normalizedUsage);
    lifecycleTracker.acknowledge(firstHandle);
    await bridge.trackUsage(normalizedUsage);
    lifecycleTracker.acknowledge(secondHandle);
    lifecycleTracker.complete(firstHandle, { outcome: 'completed' });
    await bridge.trackUsage(normalizedUsage);
    await bridge.trackUsage({
      ...normalizedUsage,
      executionId: 'provider-execution',
      frameId: 'provider-frame',
      llmCallId: 'provider-call',
    });
    lifecycleTracker.complete(secondHandle, { outcome: 'completed' });
    await bridge.trackUsage(normalizedUsage);

    expect(emittedUsagePayloads).toEqual([
      { ...normalizedUsage, model: 'test-model' },
      { ...normalizedUsage, executionId: 'execution-a', frameId: 'frame-a', model: 'test-model' },
      { ...normalizedUsage, executionId: 'execution-b', frameId: 'frame-b', model: 'test-model' },
      {
        ...normalizedUsage,
        executionId: 'provider-execution',
        frameId: 'provider-frame',
        llmCallId: 'provider-call',
        model: 'test-model',
      },
      { ...normalizedUsage, model: 'test-model' },
    ]);
  });
});
