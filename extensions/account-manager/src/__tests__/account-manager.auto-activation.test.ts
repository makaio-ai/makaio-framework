import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AdapterSubjects, defineAdapterProviderAuth, type ResolvedProviderContext } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import {
  AdapterSubsystemSubjects,
  type AdapterRuntimeSnapshotResolution,
  type ProviderConfigFileRecord,
  type ProviderRuntimeSnapshot,
} from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AccountManager } from '../account-manager.js';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

const CLIENT_ID = 'codex';
const ACCOUNT_ID = 'acc-service-auto-activation';
const PROVIDER_CONFIG_ID = 'cfg-service-auto-activation';
const DEFINITION_ID = 'openai';
const ADAPTER_NAME = 'codex-app-server';
const ADAPTER_ID = 'adapter-service-auto-activation';
const OWNER_INSTANCE_ID = 'owner-service-auto-activation';
const MODEL = 'gpt-5.4-mini';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCredential(token: string): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: {},
  };
}

describe('AccountManager auto-activation wiring', () => {
  it('starts WindowActivator from service config and activates credentials before startAgent', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource(CLIENT_ID, 'Codex');
    const store = new InMemoryAccountStore();
    const storedCredential = makeCredential('stored-token');
    await store.upsert(CLIENT_ID, {
      id: ACCOUNT_ID,
      label: 'Service Account',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: storedCredential,
      fingerprint: storedCredential.fingerprint,
    });

    const providerContext: ResolvedProviderContext = {
      state: 'resolved',
      providerConfigId: PROVIDER_CONFIG_ID,
      definitionId: DEFINITION_ID,
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: CLIENT_ID, methodId: 'native' },
        definition: { id: 'native', mode: 'inferred', label: 'Native Codex' },
        account: { managerId: 'account-manager', accountId: ACCOUNT_ID },
      },
    };
    const providerConfig: ProviderConfigFileRecord = {
      id: PROVIDER_CONFIG_ID,
      definitionId: DEFINITION_ID,
      name: 'Service Account',
      modelFilterMode: 'show-all',
      isDefault: false,
      enabled: true,
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: CLIENT_ID, methodId: 'native' },
        account: { managerId: 'account-manager', accountId: ACCOUNT_ID },
        hasCredentials: false,
      },
    };
    const providerDefinition: ProviderRuntimeSnapshot['definition'] = {
      id: DEFINITION_ID,
      packageName: '@makaio/provider-openai',
      name: 'OpenAI',
      defaultModel: MODEL,
      availableModels: [],
      authMethods: [],
      defaultModelFilterMode: 'show-all' as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const providerSnapshot: ProviderRuntimeSnapshot = {
      config: providerConfig,
      context: providerContext,
      definition: providerDefinition,
    };

    const cleanups = [
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({ configs: [providerConfig] });
      }),
      bus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
        expect(ctx.payload).toEqual({ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID });
        const resolution: AdapterRuntimeSnapshotResolution = {
          status: 'resolved',
          runtime: {
            snapshot: providerSnapshot,
            adapterName: ADAPTER_NAME,
            adapterClientId: CLIENT_ID,
            adapterProviderAuth: defineAdapterProviderAuth({
              bindings: [
                {
                  method: { owner: 'client', clientId: CLIENT_ID, methodId: 'native' },
                  deliveries: [{ kind: 'native-client', clientId: CLIENT_ID }],
                },
              ],
              scrubEnvVars: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
            }),
            compatibleProviderAuths: [],
            runtimePackages: {
              adapter: { packageName: '@makaio/adapter-codex-app-server' },
              provider: { packageName: '@makaio/provider-openai', definitionId: DEFINITION_ID },
              client: { packageName: '@makaio/client-codex', clientId: CLIENT_ID },
            },
          },
        };
        ctx.setResult(resolution);
      }),
      bus.on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
        ctx.setResult({
          bindings: [{ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID, isDefault: true }],
        });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      }),
      bus.on(ProviderStorageSubjects.get, (ctx) => {
        ctx.setResult({ provider: providerDefinition });
      }),
    ];

    const startAgentPayloads: unknown[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        startAgentPayloads.push(ctx.payload);
        ctx.setResult({
          success: true,
          agentId: 'agent-service-auto-activation',
          adapterId: ADAPTER_ID,
          ownerInstanceId: OWNER_INSTANCE_ID,
          adapterSessionId: 'adapter-session-service-auto-activation',
          sessionId: 'session-service-auto-activation',
        });
      }),
    );

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 0,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
      autoActivation: {
        sources: new Map([[CLIENT_ID, { enabled: true }]]),
        systemPrompt: 'Reply concisely.',
        message: 'ok',
      },
    });
    await service.init();

    try {
      await bus.emit(AccountManagerSubjects.usage.windowResetAvailable, {
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        windowId: '5h',
        expiredAt: 1_000,
      });

      await vi.waitFor(() => {
        expect(startAgentPayloads).toHaveLength(1);
      });
      expect(source.getLastWritten()).toEqual(storedCredential);
      expect(startAgentPayloads[0]).toMatchObject({
        adapterId: ADAPTER_ID,
        role: 'lead',
        ephemeral: true,
        model: MODEL,
        initialMessage: 'ok',
        systemPrompt: 'Reply concisely.',
      });
    } finally {
      for (const cleanup of cleanups) cleanup();
      await service.destroy();
    }
  });
});
