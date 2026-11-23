import { describe, expect, it } from 'vitest';
import { createTestCall } from '@makaio/test-utils';
import { MessageHandle } from '../../message-handle/index.js';
import { MessageLifecycleTracker } from '../message-lifecycle-tracker.js';
import { AgentEventBridge } from '../agent-event-bridge.js';
import type { NormalizedCallUsage } from '../types.js';
import { ToolCallTracker } from '../tool-call-tracker.js';

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
    const call = createTestCall();
    const emittedContextWindowPayloads: unknown[] = [];
    const bridge = new AgentEventBridge({
      emitUsage: async () => {},
      emitContextWindowUpdated: async (_call, payload) => {
        emittedContextWindowPayloads.push(payload);
      },
      emitToolUse: async () => {},
      emitToolOutput: async () => {},
      emitAdapterLog: async () => {},
      emitStepStarted: async () => {},
      emitStepFinished: async () => {},
      toolCallTracker: new ToolCallTracker(),
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
      getActiveMessageHandle: () => undefined,
    });

    await bridge.emitContextWindowUpdate(call, {
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
    const call = createTestCall();
    const emittedUsagePayloads: Array<Record<string, unknown>> = [];
    const lifecycleTracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const bridge = new AgentEventBridge({
      emitUsage: async (_call, payload) => {
        emittedUsagePayloads.push(payload);
      },
      emitContextWindowUpdated: async () => {},
      emitToolUse: async () => {},
      emitToolOutput: async () => {},
      emitAdapterLog: async () => {},
      emitStepStarted: async () => {},
      emitStepFinished: async () => {},
      toolCallTracker: new ToolCallTracker(),
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
      getActiveMessageHandle: () => lifecycleTracker.getCurrentMessageHandle(),
    });
    const handle = new MessageHandle(
      call,
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
    await bridge.trackUsage(call, normalizedUsage);
    expect(emittedUsagePayloads).toEqual([
      { ...normalizedUsage, executionId: 'exec-1', frameId: 'frame-1', model: 'test-model' },
    ]);

    // Acknowledge + complete to clean up lifecycle state.
    handle.markAcknowledged();
    handle.markCompleted({ outcome: 'completed' });
  });

  it('adds active request execution correlation to usage without replacing provider fields', async () => {
    const call = createTestCall();
    const emittedUsagePayloads: Array<Record<string, unknown>> = [];
    const lifecycleTracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const bridge = new AgentEventBridge({
      emitUsage: async (_call, payload) => {
        emittedUsagePayloads.push(payload);
      },
      emitContextWindowUpdated: async () => {},
      emitToolUse: async () => {},
      emitToolOutput: async () => {},
      emitAdapterLog: async () => {},
      emitStepStarted: async () => {},
      emitStepFinished: async () => {},
      toolCallTracker: new ToolCallTracker(),
      getBlockIndex: () => 0,
      incrementBlockIndex: () => {},
      getUsageModel: () => 'test-model',
      getActiveMessageHandle: () => lifecycleTracker.getCurrentMessageHandle(),
    });
    const firstHandle = new MessageHandle(
      call,
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
      call,
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

    await bridge.trackUsage(call, normalizedUsage);
    lifecycleTracker.acknowledge(firstHandle);
    await bridge.trackUsage(call, normalizedUsage);
    lifecycleTracker.acknowledge(secondHandle);
    lifecycleTracker.complete(firstHandle, { outcome: 'completed' });
    await bridge.trackUsage(call, normalizedUsage);
    await bridge.trackUsage(call, {
      ...normalizedUsage,
      executionId: 'provider-execution',
      frameId: 'provider-frame',
      llmCallId: 'provider-call',
    });
    lifecycleTracker.complete(secondHandle, { outcome: 'completed' });
    await bridge.trackUsage(call, normalizedUsage);

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
