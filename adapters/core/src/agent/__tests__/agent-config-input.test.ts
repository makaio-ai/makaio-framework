import { describe, expect, it } from 'vitest';
import { createMockGlobalBus, createMockScopedBus } from '@makaio/test-utils';
import type { AIAgentConnector } from '../../connector/index.js';
import { buildConfigFactoryInput } from '../agent-config-input.js';
import { ToolCallTracker } from '../tool-call-tracker.js';
import type { AIAgentConfig } from '../types.js';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';

describe('buildConfigFactoryInput error cleanup', () => {
  it('preserves message-owned correlations for recoverable errors and clears all on fatal teardown', () => {
    const { bus: adapterBus } = createMockScopedBus();
    const { bus: globalBus } = createMockGlobalBus();
    const config: AIAgentConfig & { globalBus: typeof globalBus } = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      machineId: 'test-machine',
      ownerInstanceId: 'test-owner-instance',
      capabilities: [],
      nativeTools: [],
      adapterBus,
      teardownArbiter: new AgentTeardownArbiter(),
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

describe('buildConfigFactoryInput resume override semantics', () => {
  /**
   * Build a minimal agent config carrying a start-time resume target.
   * @returns Config with `resumeAdapterSessionId: 'start-time-resume'`
   */
  function createConfigWithStartResume(): Parameters<typeof buildConfigFactoryInput>[0]['config'] {
    const { bus: adapterBus } = createMockScopedBus();
    const { bus: globalBus } = createMockGlobalBus();
    return {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      machineId: 'test-machine',
      ownerInstanceId: 'test-owner-instance',
      capabilities: [],
      nativeTools: [],
      adapterBus,
      teardownArbiter: new AgentTeardownArbiter(),
      globalBus,
      resumeAdapterSessionId: 'start-time-resume',
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
  }

  it('inherits the start-time resume target when the override key is absent', () => {
    const input = buildConfigFactoryInput({
      config: createConfigWithStartResume(),
      availableModels: undefined,
      currentReasoningEffort: undefined,
      clearAllToolCalls: () => {},
      overrides: { model: 'other-model' },
    });

    expect(input.resumeAdapterSessionId).toBe('start-time-resume');
  });

  it('builds a fresh generation when the override key is present with undefined', () => {
    const input = buildConfigFactoryInput({
      config: createConfigWithStartResume(),
      availableModels: undefined,
      currentReasoningEffort: undefined,
      clearAllToolCalls: () => {},
      overrides: { resumeAdapterSessionId: undefined },
    });

    expect(input.resumeAdapterSessionId).toBeUndefined();
  });

  it('prefers an explicit override resume target over the start-time target', () => {
    const input = buildConfigFactoryInput({
      config: createConfigWithStartResume(),
      availableModels: undefined,
      currentReasoningEffort: undefined,
      clearAllToolCalls: () => {},
      overrides: { resumeAdapterSessionId: 'override-resume' },
    });

    expect(input.resumeAdapterSessionId).toBe('override-resume');
  });
});
