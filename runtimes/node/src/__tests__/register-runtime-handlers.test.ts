import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createChannelEndpoint, MakaioBus, NoHandlerError, type ChannelEndpoint } from '@makaio/bus-core';
import {
  AuthCredentialRefSchema,
  CredentialSubjects,
  ExplicitAuthMethodDefinitionSchema,
  ProviderDefinitionSchema,
  defineAdapterProviderAuth,
  type AIModel,
} from '@makaio/contracts';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { AdapterInstance, LoadedAdapter } from '@makaio/subsystem-adapter';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderRuntimeSubjects } from '@makaio/services-core/provider-runtime';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import {
  ProviderModelFetchProtocolError,
  registerRuntimeHandlers,
  resolveModelFetchBaseUrl,
} from '../register-runtime-handlers.js';

describe('registerRuntimeHandlers', () => {
  it('requires the selected provider-ref protocol and never guesses from endpoint order', () => {
    const snapshot = {
      context: {
        endpointOverrides: {
          anthropic: 'https://must-not-be-selected.example/v1',
          openai: 'https://selected.example/v1',
        },
      },
      definition: { endpoints: { openai: 'https://default.example/v1' } },
    };

    expect(resolveModelFetchBaseUrl({ providerProtocol: 'openai', snapshot })).toBe('https://selected.example/v1');
    expect(() => resolveModelFetchBaseUrl({ snapshot })).toThrow(ProviderModelFetchProtocolError);
  });

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('registers extension config schema lookup through framework boot handlers', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) =>
        name === 'configured-extension'
          ? {
              configSchema: z.object({ enabled: z.boolean().default(true) }),
              uiConfig: { editMode: 'slidePanel' },
            }
          : undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'configured-extension',
    });

    expect(result).toMatchObject({
      hasSchema: true,
      uiConfig: { editMode: 'slidePanel' },
    });
    expect(result.schema).not.toHaveProperty('$schema');

    cleanup();
    await expect(
      MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
        extensionName: 'configured-extension',
      }),
    ).rejects.toBeInstanceOf(NoHandlerError);
  });

  it('omits extension config schema lookup when no coordinator lookup is supplied', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
    );

    await expect(
      MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
        extensionName: 'configured-extension',
      }),
    ).rejects.toBeInstanceOf(NoHandlerError);

    cleanup();
  });

  it('preserves provider package identity when adapter and provider packages differ', async () => {
    const adapters: LoadedAdapter[] = [
      {
        name: 'claude-agent-sdk',
        packageName: '@makaio/adapter-claude-agent-sdk',
        factory: async () => ({}),
        options: {},
        providerDefinitionIds: ['anthropic-oauth'],
        providerRefs: [],
        providers: [
          {
            providerPackageName: '@makaio/provider-anthropic',
            definition: {
              id: 'anthropic-oauth',
              name: 'Anthropic OAuth',
              authMethods: [],
              availableModels: [],
            },
          },
        ],
      },
      {
        name: 'codex-app-server',
        packageName: '@makaio/adapter-codex-app-server',
        factory: async () => ({}),
        options: {},
        providerDefinitionIds: ['openai-codex'],
        providerRefs: [],
        providers: [
          {
            providerPackageName: '@makaio/provider-openai-codex',
            definition: {
              id: 'openai-codex',
              name: 'OpenAI Codex',
              authMethods: [],
              availableModels: [],
            },
          },
        ],
      },
    ];
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => adapters,
      () => new Map(),
    );

    const [anthropic, codex, listed] = await Promise.all([
      MakaioBus.request(ProviderStorageSubjects.get, { id: 'anthropic-oauth' }),
      MakaioBus.request(ProviderStorageSubjects.get, { id: 'openai-codex' }),
      MakaioBus.request(ProviderStorageSubjects.list, {}),
    ]);

    expect(anthropic.provider?.packageName).toBe('@makaio/provider-anthropic');
    expect(codex.provider?.packageName).toBe('@makaio/provider-openai-codex');
    expect(listed.providers.map(({ id, packageName }) => [id, packageName])).toEqual([
      ['anthropic-oauth', '@makaio/provider-anthropic'],
      ['openai-codex', '@makaio/provider-openai-codex'],
    ]);

    cleanup();
  });

  it('fetches models from the explicitly requested adapter when definition IDs are duplicated', async () => {
    const method = {
      owner: 'provider',
      providerDefinitionId: 'shared-provider',
      methodId: 'api-key',
    } as const;
    const authDefinition = ExplicitAuthMethodDefinitionSchema.parse({
      id: 'api-key',
      mode: 'explicit',
      label: 'API key',
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'SHARED_API_KEY' }],
        },
      ],
    });
    const adapterProviderAuth = defineAdapterProviderAuth({
      bindings: [
        {
          method,
          deliveries: [
            {
              kind: 'connector',
              target: 'shared-adapter.constructor',
              fields: { apiKey: 'apiKey' },
              constants: { opposingKey: null },
            },
          ],
        },
      ],
      scrubEnvVars: ['SHARED_API_KEY', 'OPPOSING_API_KEY'],
    });
    const providerDefinition = ProviderDefinitionSchema.parse({
      id: 'shared-provider',
      name: 'Shared Provider',
      endpoints: { openai: 'https://default.example/v1' },
      authMethods: [authDefinition],
      availableModels: [],
      defaultModelFilterMode: 'show-all' as const,
    });
    type FetchModels = (baseUrl: string | undefined, auth: ResolvedAdapterAuth) => Promise<AIModel[]>;
    const wrongFetchModels = vi.fn<FetchModels>(async () => [
      { name: 'wrong-model', contextWindowSize: 1, labId: 'test-lab' },
    ]);
    const boundFetchModels = vi.fn<FetchModels>(async () => [
      { name: 'bound-model', contextWindowSize: 2, labId: 'test-lab' },
    ]);
    const wrongInstance: AdapterInstance & { fetchModels: typeof wrongFetchModels } = {
      adapterId: 'wrong-adapter-id',
      fetchModels: wrongFetchModels,
    };
    const boundInstance: AdapterInstance & { fetchModels: typeof boundFetchModels } = {
      adapterId: 'bound-adapter-id',
      fetchModels: boundFetchModels,
    };
    const noFetchInstance: AdapterInstance = { adapterId: 'no-fetch-adapter-id' };
    const adapters: LoadedAdapter[] = [
      {
        name: 'wrong-adapter',
        protocol: 'anthropic',
        packageName: 'wrong-package',
        factory: async () => ({ adapterId: 'wrong-adapter-id' }),
        options: { adapterId: 'wrong-adapter-id' },
        providerDefinitionIds: [providerDefinition.id],
        providerRefs: [{ definitionId: providerDefinition.id, protocol: 'anthropic', auth: adapterProviderAuth }],
        providers: [{ definition: providerDefinition, providerPackageName: 'wrong-package' }],
      },
      {
        name: 'bound-adapter',
        protocol: 'anthropic',
        packageName: 'bound-package',
        factory: async () => ({ adapterId: 'bound-adapter-id' }),
        options: { adapterId: 'bound-adapter-id' },
        providerDefinitionIds: [providerDefinition.id],
        providerRefs: [{ definitionId: providerDefinition.id, protocol: 'openai', auth: adapterProviderAuth }],
        providers: [{ definition: providerDefinition, providerPackageName: 'bound-package' }],
      },
      {
        name: 'no-fetch-adapter',
        protocol: 'openai',
        packageName: 'no-fetch-package',
        factory: async () => ({ adapterId: 'no-fetch-adapter-id' }),
        options: { adapterId: 'no-fetch-adapter-id' },
        providerDefinitionIds: [providerDefinition.id],
        providerRefs: [{ definitionId: providerDefinition.id, protocol: 'openai', auth: adapterProviderAuth }],
        providers: [{ definition: providerDefinition, providerPackageName: 'no-fetch-package' }],
      },
    ];
    const instances = new Map<string, AdapterInstance>([
      ['wrong-adapter-id', wrongInstance],
      ['bound-adapter-id', boundInstance],
      ['no-fetch-adapter-id', noFetchInstance],
    ]);
    const resolvedAdapterNames: string[] = [];

    const offSnapshot = MakaioBus.on(
      AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot,
      ({ payload, setResult }) => {
        resolvedAdapterNames.push(payload.adapterName);
        if (payload.adapterName === 'wrong-adapter') {
          setResult({ status: 'error', code: 'adapter-not-bound' });
          return;
        }
        expect(payload.adapterName).toMatch(/^(bound|no-fetch)-adapter$/);
        expect(payload.providerConfigId).toBe('shared.work');
        setResult({
          status: 'resolved',
          runtime: {
            adapterName: payload.adapterName,
            providerProtocol: 'openai',
            adapterProviderAuth,
            compatibleProviderAuths: [],
            runtimePackages: {
              adapter: { packageName: payload.adapterName === 'bound-adapter' ? 'bound-package' : 'no-fetch-package' },
              provider: { packageName: 'shared-provider-package', definitionId: 'shared-provider' },
            },
            snapshot: {
              config: {
                id: 'shared.work',
                definitionId: 'shared-provider',
                name: 'Shared Work',
                modelFilterMode: 'show-all',
                isDefault: true,
                enabled: true,
                auth: { mode: 'explicit', method, hasCredentials: true },
              },
              context: {
                state: 'resolved',
                providerConfigId: 'shared.work',
                definitionId: 'shared-provider',
                endpointOverrides: {
                  anthropic: 'https://must-not-be-selected.example/v1',
                  openai: 'https://bound.example/v1',
                },
                auth: {
                  mode: 'explicit',
                  method,
                  definition: authDefinition,
                  credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:SHARED_API_KEY') },
                },
              },
              definition: {
                id: 'shared-provider',
                packageName: 'shared-provider-package',
                name: 'Shared Provider',
                endpoints: { openai: 'https://default.example/v1' },
                availableModels: [],
                defaultModelFilterMode: 'show-all',
                authMethods: [authDefinition],
                enabled: true,
                createdAt: 0,
                updatedAt: 0,
              },
            },
          },
        });
      },
    );
    const token = 'model-fetch-test-token';
    const offToken = MakaioBus.on(CredentialSubjects.getChannelToken, ({ setResult }) => {
      setResult({ token });
    });
    const credentialEndpoint: ChannelEndpoint = createChannelEndpoint(
      MakaioBus.getContext(),
      'credentials',
      (channel) => {
        channel.on(CredentialSubjects.resolve, ({ payload, setResult }) => {
          expect(payload.ref).toBe('env:SHARED_API_KEY');
          setResult({ value: 'selected-api-key' });
        });
      },
      { token },
    );
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => adapters,
      () => instances,
    );

    await expect(
      MakaioBus.request(ProviderRuntimeSubjects.listModelFetchAdapters, { providerConfigId: 'shared.work' }),
    ).resolves.toEqual({ adapterNames: ['bound-adapter'] });
    expect(resolvedAdapterNames).toEqual(['wrong-adapter', 'bound-adapter']);

    const result = await MakaioBus.request(ProviderRuntimeSubjects.fetchModels, {
      adapterName: 'bound-adapter',
      providerConfigId: 'shared.work',
    });

    expect(result.models).toEqual([{ name: 'bound-model', contextWindowSize: 2, labId: 'test-lab' }]);
    expect(wrongFetchModels).not.toHaveBeenCalled();
    expect(boundFetchModels).toHaveBeenCalledWith('https://bound.example/v1', {
      processEnv: {},
      connectorDeliveries: [
        {
          target: 'shared-adapter.constructor',
          values: { apiKey: 'selected-api-key', opposingKey: null },
        },
      ],
      configInheritance: 'empty',
    });

    cleanup();
    credentialEndpoint.close();
    offToken();
    offSnapshot();
  });

  it('rejects a loaded, auth-compatible adapter that is not bound to the selected provider config', async () => {
    const method = {
      owner: 'provider',
      providerDefinitionId: 'shared-provider',
      methodId: 'api-key',
    } as const;
    const authDefinition = ExplicitAuthMethodDefinitionSchema.parse({
      id: 'api-key',
      mode: 'explicit',
      label: 'API key',
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'SHARED_API_KEY' }],
        },
      ],
    });
    const adapterProviderAuth = defineAdapterProviderAuth({
      bindings: [
        {
          method,
          deliveries: [{ kind: 'connector', target: 'shared-adapter.constructor', fields: { apiKey: 'apiKey' } }],
        },
      ],
      scrubEnvVars: ['SHARED_API_KEY'],
    });
    const providerDefinition = ProviderDefinitionSchema.parse({
      id: 'shared-provider',
      name: 'Shared Provider',
      authMethods: [authDefinition],
      availableModels: [],
      defaultModelFilterMode: 'show-all' as const,
    });
    const fetchModels = vi.fn(async (): Promise<AIModel[]> => []);
    const adapter: LoadedAdapter = {
      name: 'compatible-but-unbound',
      protocol: 'openai',
      packageName: 'compatible-package',
      factory: async () => ({ adapterId: 'compatible-adapter-id' }),
      options: { adapterId: 'compatible-adapter-id' },
      providerDefinitionIds: [providerDefinition.id],
      providerRefs: [{ definitionId: providerDefinition.id, protocol: 'openai', auth: adapterProviderAuth }],
      providers: [{ definition: providerDefinition, providerPackageName: 'compatible-package' }],
    };
    const instance: AdapterInstance & { fetchModels: typeof fetchModels } = {
      adapterId: 'compatible-adapter-id',
      fetchModels,
    };
    const offSnapshot = MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, ({ setResult }) => {
      setResult({ status: 'error', code: 'adapter-not-bound' });
    });
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [adapter],
      () => new Map([['compatible-adapter-id', instance]]),
    );

    await expect(
      MakaioBus.request(ProviderRuntimeSubjects.fetchModels, {
        adapterName: 'compatible-but-unbound',
        providerConfigId: 'shared.work',
      }),
    ).rejects.toThrow('Adapter runtime snapshot resolution failed (adapter-not-bound).');

    expect(fetchModels).not.toHaveBeenCalled();

    cleanup();
    offSnapshot();
  });

  it('rejects live model discovery for an unknown adapter instead of selecting another binding', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
    );

    await expect(
      MakaioBus.request(ProviderRuntimeSubjects.fetchModels, {
        adapterName: 'missing-adapter',
        providerConfigId: 'shared.work',
      }),
    ).rejects.toThrow("Adapter 'missing-adapter' is not loaded for live model discovery");

    cleanup();
  });
});
