import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { z } from 'zod';
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

  it('registers adapter namespace schemas on the injected globalBus before creating the scoped bus', async () => {
    const hostBus = createBusInstance();
    const namespace = createAdapterNamespace(
      'scoped-bus-host-registration-test',
      { chunk: z.object({ content: z.string() }) },
      { busValidationMode: 'skip' },
    );

    const adapter = new TestAdapter({
      name: 'scoped-bus-host-registration-test',
      capabilities: [],
      nativeTools: [],
      namespace,
      globalBus: hostBus,
      agentFactory: (config: AIAgentConfig<TestBus, MockConnector>) => new TestAgent(config),
      configFactory: async (input: ConfigFactoryInput<TestBus>) => ({
        bus: await namespace.scopedBus(hostBus.getContext()),
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName: 'scoped-bus-host-registration-test',
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
      }),
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new MockConnector(config),
    });

    await adapter.init();

    expect(hostBus.getSchema(namespace.subjects.chunk)).toBeDefined();
    expect(
      hostBus.getContext().namespaceRegistry.getValidationConfig('scoped-bus-host-registration-test.chunk').mode,
    ).toBe('skip');
  });

  it('passes the injected globalBus to created agents', async () => {
    const hostBus = createBusInstance();
    const namespace = createAdapterNamespace('agent-bus-ctx-test', {});
    const { bus: mockScopedBus } = createMockScopedBus();
    let capturedConfig: AIAgentConfig<TestBus, MockConnector> | undefined;

    class ExposedTestAdapter extends TestAdapter {
      public createForTest(agentId: string, sessionId: string): Promise<TestAgent> {
        return this.createAgent(agentId, sessionId, {});
      }
    }

    const adapter = new ExposedTestAdapter({
      name: 'agent-bus-ctx-test',
      capabilities: [],
      nativeTools: [],
      namespace,
      scopedBus: mockScopedBus,
      globalBus: hostBus,
      agentFactory: (config: AIAgentConfig<TestBus, MockConnector>) => {
        capturedConfig = config;
        return new TestAgent(config);
      },
      configFactory: async (input: ConfigFactoryInput<TestBus>) => ({
        bus: mockScopedBus,
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName: 'agent-bus-ctx-test',
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
      }),
      connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) =>
        new MockConnector(config),
    });

    await adapter.init();
    await adapter.createForTest('agent-1', 'session-1');

    expect(capturedConfig?.globalBus).toBe(hostBus);
  });
});
