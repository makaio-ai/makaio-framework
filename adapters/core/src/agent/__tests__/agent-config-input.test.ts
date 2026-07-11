import { describe, expect, it } from 'vitest';
import { createMockGlobalBus, createMockScopedBus } from '@makaio/test-utils';
import type { AIAgentConnector } from '../../connector/index.js';
import { buildConfigFactoryInput } from '../agent-config-input.js';
import { ToolCallTracker } from '../tool-call-tracker.js';
import type { AIAgentConfig } from '../types.js';

describe('buildConfigFactoryInput error cleanup', () => {
  it('preserves message-owned correlations for recoverable errors and clears all on fatal teardown', () => {
    const { bus: adapterBus } = createMockScopedBus();
    const { bus: globalBus } = createMockGlobalBus();
    const config: AIAgentConfig & { globalBus: typeof globalBus } = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      capabilities: [],
      nativeTools: [],
      adapterBus,
      globalBus,
      configFactory: async () => ({
        bus: adapterBus,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        model: 'test-model',
        cwd: '/tmp',
      }),
      connectorFactory: () => ({}) as AIAgentConnector,
    };
    const tracker = new ToolCallTracker();
    const input = buildConfigFactoryInput({
      config,
      availableModels: undefined,
      currentReasoningEffort: undefined,
      clearAllToolCalls: () => tracker.clearAll(),
    });

    tracker.register('message-1', 'Read', undefined, 'tool-1');
    input.errorHandler?.(new Error('recoverable'), false);
    expect(tracker.resolve('message-1', { nativeId: 'tool-1' }).correlationId).toBe('tool-1');

    tracker.register('message-1', 'Read', undefined, 'tool-2');
    tracker.register('message-2', 'Read', undefined, 'tool-3');
    input.errorHandler?.(new Error('fatal'), true);
    expect(tracker.resolve('message-1', { nativeId: 'tool-2' }).correlationId).toBeNull();
    expect(tracker.resolve('message-2', { nativeId: 'tool-3' }).correlationId).toBeNull();
  });
});
