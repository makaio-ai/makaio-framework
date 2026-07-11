import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import type { BaseAgentConnectorConfig } from '../../agent/types.js';
import { defineAdapterProviderAuth, type ProviderContext, type ResolvedProviderAuth } from '@makaio/contracts';
import { AdapterAuthError } from '../resolve-adapter-auth.js';
import { createAdapterConfigFactory } from '../factory.js';

interface TestProviderConfig {
  apiKey?: string;
  baseUrl?: string | null;
}

type TestConnectorConfig = BaseAgentConnectorConfig & {
  providerConfig: TestProviderConfig;
};

/** Minimal ProviderContext for use in unit test stubs. */
const testProviderContext = {
  state: 'resolved',
  providerConfigId: 'test-config',
  definitionId: 'test-provider',
  endpointOverrides: { anthropic: 'https://api.test.com', openai: 'https://api.openai.test.com' },
  auth: {
    mode: 'none',
    method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'none' },
    definition: { id: 'none', mode: 'none', label: 'No authentication' },
  },
} satisfies ProviderContext;

const testAdapterProviderAuth = defineAdapterProviderAuth({
  bindings: [
    {
      method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'none' },
      deliveries: [{ kind: 'none' }],
    },
  ],
  scrubEnvVars: ['TEST_PROVIDER_API_KEY'],
});

describe('createAdapterConfigFactory', () => {
  it('reads endpoint from providerContext without bus dispatch, does not spread credentials', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: z.object({ apiKey: z.string().optional() }),
      adapterDefinition: {},
    }));

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
      providerProtocol: 'anthropic',
      adapterProviderAuth: testAdapterProviderAuth,
      model: 'claude-3-opus',
    });

    expect(config.model).toBe('claude-3-opus');
    // Endpoint from providerContext.endpointOverrides flows to providerConfig.baseUrl
    expect(config.providerConfig.baseUrl).toBe('https://api.test.com');
    // Credentials are NOT spread into providerConfig — connectors resolve them locally.
    expect(config.providerConfig.apiKey).toBeUndefined();
    expect(config.boundProviderAuth?.auth).toEqual(testProviderContext.auth);
    expect('adapterProviderAuth' in config).toBe(false);
  });

  it('leaves baseUrl undefined when no endpointOverride matches the protocol', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));

    const contextWithoutOverride: ProviderContext = {
      state: 'resolved',
      providerConfigId: 'test-config',
      definitionId: 'test-provider',
      auth: testProviderContext.auth,
    };

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: contextWithoutOverride,
      providerProtocol: 'anthropic',
      adapterProviderAuth: testAdapterProviderAuth,
    });

    expect(config.providerConfig.baseUrl).toBeUndefined();
  });

  it('does not derive an endpoint from unresolved provider state', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: { state: 'unresolved' },
    });

    expect(config.providerConfig.baseUrl).toBeUndefined();
  });

  it('passes supportedReasoningLevels from input through to result', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));

    const levels = { low: 1024, medium: 4096, high: 8192 };
    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
      adapterProviderAuth: testAdapterProviderAuth,
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
    }));

    await expect(
      factory.getConfig({
        bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
        agentId: 'agent-1',
        adapterName: 'test-adapter',
        adapterId: 'adapter-1',
        providerContext: testProviderContext,
        adapterProviderAuth: testAdapterProviderAuth,
      }),
    ).rejects.toThrow('No model resolved for adapter "test-adapter"');
  });

  it('falls back to adapterDefaults.model when input.model is not provided', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'gpt-4' },
      schema: null,
      adapterDefinition: {},
    }));

    const config = await factory.getConfig({
      bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
      agentId: 'agent-1',
      adapterName: 'test-adapter',
      adapterId: 'adapter-1',
      providerContext: testProviderContext,
      adapterProviderAuth: testAdapterProviderAuth,
    });

    expect(config.model).toBe('gpt-4');
  });

  it('rejects an unresolved context when the adapter declares providers', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));

    await expect(
      factory.getConfig({
        bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
        agentId: 'agent-1',
        adapterName: 'test-adapter',
        adapterId: 'adapter-1',
        providerContext: { state: 'unresolved' },
        providerContextRequired: true,
      }),
    ).rejects.toMatchObject({
      name: 'AdapterAuthError',
      reason: 'provider-context-unresolved',
    } satisfies Partial<AdapterAuthError>);
  });

  it('rejects a resolved context without an exact adapter auth declaration', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));

    await expect(
      factory.getConfig({
        bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
        agentId: 'agent-1',
        adapterName: 'test-adapter',
        adapterId: 'adapter-1',
        providerContext: testProviderContext,
      }),
    ).rejects.toMatchObject({ reason: 'binding-missing' } satisfies Partial<AdapterAuthError>);
  });

  it('rejects a client-owned method bound to a different runtime client', async () => {
    const factory = createAdapterConfigFactory<TestConnectorConfig>(() => ({
      adapterName: 'test-adapter',
      adapterDefaults: { model: 'default-model' },
      schema: null,
      adapterDefinition: {},
    }));
    const auth: ResolvedProviderAuth = {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native' },
    };
    const declaration = defineAdapterProviderAuth({
      bindings: [
        {
          method: auth.method,
          deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
        },
      ],
      scrubEnvVars: [],
    });

    await expect(
      factory.getConfig({
        bus: MakaioBus as Parameters<typeof factory.getConfig>[0]['bus'],
        agentId: 'agent-1',
        adapterName: 'test-adapter',
        adapterId: 'adapter-1',
        providerContext: { ...testProviderContext, auth },
        adapterProviderAuth: declaration,
        clientId: 'codex',
      }),
    ).rejects.toMatchObject({ reason: 'client-mismatch' } satisfies Partial<AdapterAuthError>);
  });
});
