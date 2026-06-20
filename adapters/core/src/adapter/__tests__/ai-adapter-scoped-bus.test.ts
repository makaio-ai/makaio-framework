import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { createBusInstance } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { createAdapterNamespace } from '../../factory/create-adapter-namespace.js';
import {
  TestAdapter,
  MockConnector,
  TestAgent,
  type TestBus,
  type ConfigFactoryInput,
  type BaseAgentConnectorConfig,
  type AIAgentConfig,
} from './shared.js';

describe('AIAdapter scoped bus context', () => {
  it('creates adapterBus from injected globalBus context when no scopedBus is provided', async () => {
    const hostBus = createBusInstance();
    const namespace = createAdapterNamespace('scoped-bus-ctx-test', {});
    const { bus: mockScopedBus } = createMockScopedBus();

    const scopedBusSpy = vi
      .spyOn(namespace, 'scopedBus')
      .mockImplementation(
        async () => mockScopedBus as ReturnType<typeof namespace.scopedBus> extends Promise<infer R> ? R : never,
      );

    const adapter = new TestAdapter({
      name: 'scoped-bus-ctx-test',
      capabilities: [],
      nativeTools: [],
      namespace,
      globalBus: hostBus,
      agentFactory: (config: AIAgentConfig<TestBus, MockConnector>) => new TestAgent(config),
      configFactory: async (input: ConfigFactoryInput<TestBus>) => ({
        bus: mockScopedBus,
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName: 'scoped-bus-ctx-test',
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
      }),
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new MockConnector(config),
    });

    await adapter.init();

    expect(scopedBusSpy).toHaveBeenCalledWith(hostBus.getContext());
  });
});
