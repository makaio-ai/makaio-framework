import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  MockConnector,
  createTestAdapter as createTestAdapterShared,
  type BaseAgentConnectorConfig,
  type ConfigFactoryInput,
  type TestBus,
} from './shared.js';

describe('AIAdapter.handleRehydrateAgent provider context', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('builds providerContext during rehydrate when providerConfigId is persisted', async () => {
    let capturedProviderContext: ConfigFactoryInput['providerContext'] | undefined;

    const { adapter } = createTestAdapterShared('test-adapter-rehydrate-provider-context', {
      configFactory: async (input) => {
        capturedProviderContext = input.providerContext;
        return {
          bus: input.bus,
          agentId: input.agentId,
          adapterId: input.adapterId,
          adapterName: input.adapterName,
          model: input.model ?? 'test-model',
          cwd: input.cwd ?? os.tmpdir(),
        } satisfies BaseAgentConnectorConfig<TestBus> & { adapterId: string };
      },
      connectorFactory: async (config) => new MockConnector(config),
    });

    await adapter.init();

    MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          adapterId: adapter.adapterId,
          adapterName: 'test-adapter-rehydrate-provider-context',
          sessionId: 'persisted-session',
          adapterSessionId: 'persisted-adapter-session',
          role: 'lead',
          status: 'dead' as const,
          model: 'persisted-model',
          cwd: os.tmpdir(),
          providerConfigId: 'provider-1',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      });
    });

    MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      ctx.setResult({ success: true });
    });

    const apiKeyRef = buildStoredCredentialRef('provider-1', 'apiKey');

    MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      expect(ctx.payload.providerConfigId).toBe('provider-1');
      ctx.setResult({
        context: {
          providerConfigId: 'provider-1',
          definitionId: 'anthropic',
          endpointOverrides: { anthropic: 'https://api.example.test' },
          credentialRefs: { apiKey: apiKeyRef },
          credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
        },
      });
    });

    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      expect(ctx.payload.id).toBe('anthropic');
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
          endpoints: { anthropic: 'https://api.anthropic.com' },
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent-provider-context',
      cwd: os.tmpdir(),
    });

    // buildProviderContext returns credential refs, not plaintext — resolution
    // is deferred to the connector layer.
    expect(capturedProviderContext).toEqual({
      providerConfigId: 'provider-1',
      definitionId: 'anthropic',
      endpointOverrides: { anthropic: 'https://api.example.test' },
      credentialRefs: { apiKey: apiKeyRef },
      credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
    });

    await adapter.closeAsync();
  });
});
