import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects } from '@makaio/kernel';
import { VersionRangeSchema, defineAdapterProviderAuth } from '@makaio/contracts';
import { ClientDefinitionSchema } from '@makaio/contracts/client';
import { CredentialRefSchema, type AdapterFile, type ProviderConfigFile } from '@makaio/contracts/config';
import type { ProviderRuntimeSnapshot } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AdapterConfigStore } from '../adapter-config-store.js';
import { resolveAdapterRuntimeSnapshot } from '../adapter-runtime-snapshot.js';
import type { LoadedAdapter } from '../adapter-runtime-types.js';

const authMethod = {
  id: 'api-key',
  mode: 'explicit' as const,
  label: 'API key',
  fields: [{ id: 'apiKey', label: 'API key', required: true, secret: true, sourceHints: [] }],
};
const selectedAuth = defineAdapterProviderAuth({
  bindings: [
    {
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
    },
  ],
  scrubEnvVars: ['ANTHROPIC_API_KEY'],
});
const resolvedSelectedAuth = defineAdapterProviderAuth({
  bindings: selectedAuth.bindings,
  scrubEnvVars: [...selectedAuth.scrubEnvVars, 'CLAUDE_CODE_OAUTH_TOKEN'],
});
const compatibleAuth = defineAdapterProviderAuth({
  bindings: [
    {
      method: { owner: 'provider', providerDefinitionId: 'openai', methodId: 'api-key' },
      deliveries: [{ kind: 'process-env', fields: { apiKey: 'OPENAI_API_KEY' } }],
    },
  ],
  scrubEnvVars: ['OPENAI_API_KEY'],
});

/** Build the atomic provider snapshot consumed by the runtime resolver. */
function providerSnapshot(): ProviderRuntimeSnapshot {
  return {
    config: {
      id: 'anthropic-work',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      modelFilterMode: 'show-all',
      isDefault: true,
      enabled: true,
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        hasCredentials: true,
      },
    },
    context: {
      state: 'resolved',
      providerConfigId: 'anthropic-work',
      definitionId: 'anthropic',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        definition: authMethod,
        credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
      },
    },
    definition: {
      id: 'anthropic',
      packageName: '@makaio/provider-anthropic',
      name: 'Anthropic',
      availableModels: [],
      authMethods: [authMethod],
      defaultModelFilterMode: 'show-all',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/** Build loaded adapter metadata with selected and compatible declarations. */
function loadedAdapter(): LoadedAdapter {
  return {
    name: 'claude-code',
    packageName: '@makaio/adapter-claude-code',
    factory: async () => ({}),
    options: {},
    providerDefinitionIds: ['anthropic', 'openai'],
    providerRefs: [
      { definitionId: 'anthropic', protocol: 'anthropic', auth: selectedAuth },
      { definitionId: 'openai', protocol: 'openai', auth: compatibleAuth },
    ],
    providers: [
      {
        definition: {
          id: 'anthropic',
          name: 'Anthropic',
          availableModels: [],
          authMethods: [authMethod],
        },
        providerPackageName: '@makaio/provider-anthropic',
        protocol: 'anthropic',
        auth: resolvedSelectedAuth,
      },
      {
        definition: {
          id: 'openai',
          name: 'OpenAI',
          availableModels: [],
          authMethods: [authMethod],
        },
        providerPackageName: '@makaio/provider-openai',
        protocol: 'openai',
        auth: compatibleAuth,
      },
    ],
    clients: [{ id: 'claude-code', version: VersionRangeSchema.parse('*') }],
  };
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('resolveAdapterRuntimeSnapshot', () => {
  it('returns exact declarations and canonical package identities without plaintext', async () => {
    const cleanup = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@makaio/client-claude-code',
            definition: ClientDefinitionSchema.parse({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.0.0',
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              authMethods: [],
            }),
          },
        ],
      });
    });

    const result = await resolveAdapterRuntimeSnapshot({
      bus: MakaioBus,
      adapter: loadedAdapter(),
      snapshot: providerSnapshot(),
      isBound: true,
    });
    cleanup();

    expect(result).toMatchObject({
      status: 'resolved',
      runtime: {
        adapterName: 'claude-code',
        adapterClientId: 'claude-code',
        providerProtocol: 'anthropic',
        adapterProviderAuth: resolvedSelectedAuth,
        compatibleProviderAuths: [compatibleAuth],
        runtimePackages: {
          adapter: { packageName: '@makaio/adapter-claude-code' },
          provider: { packageName: '@makaio/provider-anthropic', definitionId: 'anthropic' },
          client: { packageName: '@makaio/client-claude-code', clientId: 'claude-code' },
        },
      },
    });
    expect(result).not.toHaveProperty('runtime.adapterAuth');
    expect(result).not.toHaveProperty('runtime.processEnv');
    expect(result).not.toHaveProperty('runtime.connectorDeliveries');
    expect(result).toHaveProperty('runtime.snapshot.context.auth.credentialRefs.apiKey', 'env:ANTHROPIC_API_KEY');
  });

  it('returns a typed failure for an incompatible provider definition', async () => {
    const adapter: LoadedAdapter = { ...loadedAdapter(), providerRefs: [] };

    await expect(
      resolveAdapterRuntimeSnapshot({ bus: MakaioBus, adapter, snapshot: providerSnapshot(), isBound: true }),
    ).resolves.toEqual({ status: 'error', code: 'provider-incompatible' });
  });

  it('rejects a selected auth method that the adapter/provider junction cannot deliver', async () => {
    const mismatchedAuth = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'different-method' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });
    const adapter: LoadedAdapter = {
      ...loadedAdapter(),
      providerRefs: [{ definitionId: 'anthropic', auth: mismatchedAuth }],
      providers: loadedAdapter().providers.map((provider) =>
        provider.definition.id === 'anthropic' ? { ...provider, auth: mismatchedAuth } : provider,
      ),
    };

    await expect(
      resolveAdapterRuntimeSnapshot({ bus: MakaioBus, adapter, snapshot: providerSnapshot(), isBound: true }),
    ).resolves.toEqual({ status: 'error', code: 'auth-binding-missing' });
  });

  it('rejects ambiguous client package identities in the contribution catalog', async () => {
    const duplicateClient = {
      packageName: '@makaio/client-claude-code',
      definition: ClientDefinitionSchema.parse({
        id: 'claude-code',
        name: 'Claude Code',
        version: '1.0.0',
        nativeTools: [],
        defaultApprovalPolicy: 'always-ask',
        authMethods: [],
      }),
    };
    const cleanup = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({ providers: [], clients: [duplicateClient, duplicateClient] });
    });

    try {
      await expect(
        resolveAdapterRuntimeSnapshot({
          bus: MakaioBus,
          adapter: loadedAdapter(),
          snapshot: providerSnapshot(),
          isBound: true,
        }),
      ).resolves.toEqual({ status: 'error', code: 'client-incompatible' });
    } finally {
      cleanup();
    }
  });

  it('returns a typed failure when the captured config snapshot does not bind the adapter', async () => {
    await expect(
      resolveAdapterRuntimeSnapshot({
        bus: MakaioBus,
        adapter: loadedAdapter(),
        snapshot: providerSnapshot(),
        isBound: false,
      }),
    ).resolves.toEqual({ status: 'error', code: 'adapter-not-bound' });
  });

  it('keeps binding authorization coherent when an unbind interleaves the async definition lookup', async () => {
    const rawConfig: ProviderConfigFile = {
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
      },
    };
    const rawAdapter: AdapterFile = {
      $schema: 'makaio/adapter-config/v1',
      bindings: [{ providerConfigId: 'anthropic-work', isDefault: true }],
    };
    const repository = {
      loadProviderConfigs: async () => ({ configs: new Map([['anthropic-work', rawConfig]]) }),
      loadAdapterConfigs: async () => ({ configs: new Map([['claude-code', rawAdapter]]) }),
      writeProviderConfig: async () => undefined,
      deleteProviderConfig: async () => false,
      writeAdapterFile: async () => undefined,
      deleteAdapterFile: async () => false,
    };
    const store = new AdapterConfigStore({ bus: MakaioBus, configRepository: repository });
    await store.loadSnapshot();

    let releaseDefinitionLookup: (() => void) | undefined;
    const definitionLookupReleased = new Promise<void>((resolve) => {
      releaseDefinitionLookup = resolve;
    });
    let markDefinitionLookupStarted: (() => void) | undefined;
    const definitionLookupStarted = new Promise<void>((resolve) => {
      markDefinitionLookupStarted = resolve;
    });
    const cleanup = MakaioBus.on(ProviderStorageSubjects.get, async ({ setResult }) => {
      markDefinitionLookupStarted?.();
      await definitionLookupReleased;
      setResult({ provider: providerSnapshot().definition });
    });

    try {
      const pending = store.resolveBoundProviderRuntimeSnapshot('claude-code', 'anthropic-work');
      await definitionLookupStarted;
      await store.commitSnapshotMutation((nextSnapshot) => {
        nextSnapshot.adapters.set('claude-code', { ...rawAdapter, bindings: [] });
      });
      releaseDefinitionLookup?.();

      await expect(pending).resolves.toMatchObject({
        isBound: true,
        snapshot: { config: { id: 'anthropic-work' } },
      });
      expect(store.listBindings('claude-code')).toEqual([]);
    } finally {
      releaseDefinitionLookup?.();
      cleanup();
    }
  });
});
