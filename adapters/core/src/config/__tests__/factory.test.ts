import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import type { BaseAgentConnectorConfig } from '../../agent/types.js';
import type { ProviderContext } from '@makaio/contracts';
import { createAdapterConfigFactory } from '../factory.js';

interface TestProviderConfig {
  apiKey?: string;
  baseUrl?: string | null;
}

type TestConnectorConfig = BaseAgentConnectorConfig & {
  providerConfig: TestProviderConfig;
};

/** Minimal ProviderContext for use in unit test stubs. */
const testProviderContext: ProviderContext = {
  providerConfigId: 'test-config',
  definitionId: 'test-provider',
  credentialRefs: {},
  endpointOverrides: { anthropic: 'https://api.test.com', openai: 'https://api.openai.test.com' },
};

describe('createAdapterConfigFactory', () => {
  it('reads endpoint from providerContext without bus dispatch, does not spread credentials', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: z.object({ apiKey: z.string().optional() }),
      adapterDefinition: {},
      protocol: 'anthropic',
    }));

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
      model: 'claude-3-opus',
    });

    expect(config.model).toBe('claude-3-opus');
    // Endpoint from providerContext.endpointOverrides flows to providerConfig.baseUrl
    expect(config.providerConfig.baseUrl).toBe('https://api.test.com');
    // Credentials are NOT spread into providerConfig — connectors resolve them locally.
    expect(config.providerConfig.apiKey).toBeUndefined();
  });

  it('leaves baseUrl undefined when no endpointOverride matches the protocol', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
      protocol: 'anthropic',
    }));

    const contextWithoutOverride: ProviderContext = {
      providerConfigId: 'test-config',
      definitionId: 'test-provider',
      credentialRefs: {},
    };

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: contextWithoutOverride,
    });

    expect(config.providerConfig.baseUrl).toBeUndefined();
  });

  it('passes supportedReasoningLevels from input through to result', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
      protocol: 'anthropic',
    }));

    const levels = { low: 1024, medium: 4096, high: 8192 };
    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
      model: 'test-model',
      supportedReasoningLevels: levels,
    });

    expect(config.supportedReasoningLevels).toEqual(levels);
  });

  it('throws when no model is resolvable', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: {},
      schema: null,
      adapterDefinition: {},
      protocol: 'anthropic',
    }));

    await expect(
      factory.getConfig({
        bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
        agentId: 'agent-1',
        adapterName: 'test-adapter',
        adapterId: 'adapter-1',
        providerContext: testProviderContext,
      }),
    ).rejects.toThrow('No model resolved for adapter "test-adapter"');
  });

  it('falls back to adapterDefaults.model when input.model is not provided', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'gpt-4' },
      schema: null,
      adapterDefinition: {},
      protocol: 'anthropic',
    }));

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
    });

    expect(config.model).toBe('gpt-4');
  });
});
