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

  it('includes operatorConfig in the config schema response when the accessor yields a config entry', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'my-extension' ? { configSchema: z.object({ apiKey: z.string() }) } : undefined),
      (name) =>
        name === 'my-extension'
          ? { kind: 'config', source: '/etc/makaio/operator.json', config: { apiKey: 'op-key' } }
          : undefined,
      (name) => (name === 'my-extension' ? { config: { apiKey: 'op-key' }, usedSchemaDefaults: false } : undefined),
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.operatorConfig).toEqual({
      source: '/etc/makaio/operator.json',
      keys: ['apiKey'],
      values: { apiKey: 'op-key' },
    });

    cleanup();
  });

  it('omits operatorConfig from the config schema response when the accessor yields undefined', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'my-extension' ? { configSchema: z.object({ apiKey: z.string() }) } : undefined),
      () => undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.operatorConfig).toBeUndefined();

    cleanup();
  });

  it('omits operatorConfig from the config schema response when the accessor yields a failure entry', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'my-extension' ? { configSchema: z.object({ apiKey: z.string() }) } : undefined),
      (name) =>
        name === 'my-extension'
          ? { kind: 'failure', source: '/etc/makaio/bad.json', reason: 'invalid-json' }
          : undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.operatorConfig).toBeUndefined();

    cleanup();
  });

  it('omits operatorConfig when no configSchema is registered for the extension', async () => {
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'schema-less' ? {} : undefined),
      (name) =>
        name === 'schema-less'
          ? { kind: 'config', source: '/etc/makaio/operator.json', config: { flag: true } }
          : undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'schema-less',
    });

    // kernel drops the operator layer without a configSchema, so there is nothing
    // to lock in that case — provenance is omitted.
    expect(result.hasSchema).toBe(false);
    expect(result.operatorConfig).toBeUndefined();

    cleanup();
  });

  it('uses schema-resolved values for operatorConfig when the extension is active (e.g. .trim() applied)', async () => {
    // The operator file contains a value with surrounding whitespace. The schema
    // applies .trim(), so the resolved effective config has the trimmed value.
    // The provenance snapshot must reflect what the extension actually received,
    // not the raw file content.
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'my-extension' ? { configSchema: z.object({ locale: z.string().trim() }) } : undefined),
      (name) =>
        name === 'my-extension'
          ? { kind: 'config', source: '/etc/makaio/operator.json', config: { locale: ' en-US ' } }
          : undefined,
      // Simulates the coordinator returning the schema-parsed effective config.
      (name) => (name === 'my-extension' ? { config: { locale: 'en-US' }, usedSchemaDefaults: false } : undefined),
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.operatorConfig).toEqual({
      source: '/etc/makaio/operator.json',
      keys: ['locale'],
      // The trimmed value from the resolved config, not the raw ' en-US ' string.
      values: { locale: 'en-US' },
    });

    cleanup();
  });

  it('reports operator-owned keys without values when resolution fell back to schema defaults', async () => {
    // When the merged configuration is rejected, the kernel resolves to the
    // schema's own defaults with every configuration layer — the operator's
    // included — discarded, and the extension never receives those values.
    // Reporting them as effective operator values would be a lie; only the
    // owned keys are reported, so the fields stay locked.
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) =>
        name === 'my-extension' ? { configSchema: z.object({ locale: z.string().default('en') }) } : undefined,
      (name) =>
        name === 'my-extension'
          ? { kind: 'config', source: '/etc/makaio/operator.json', config: { locale: 42 } }
          : undefined,
      (name) => (name === 'my-extension' ? { config: { locale: 'en' }, usedSchemaDefaults: true } : undefined),
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.operatorConfig).toEqual({ source: '/etc/makaio/operator.json', keys: ['locale'] });
    // The schema default 'en' is never presented as an operator-managed value.
    expect(result.operatorConfig?.values).toBeUndefined();

    cleanup();
  });

  it('reports operator-owned keys without values when no resolved config is available', async () => {
    // Config resolution yields nothing when a required field has no default and
    // the merged configuration is rejected. The operator layer still shadows its
    // keys at merge time, so they must stay locked: `keys` is reported and only
    // `values` is omitted. Emitting the raw operator input as `values` is not an
    // option — the field carries no marker distinguishing raw input from
    // schema-resolved effective values, so a consumer could not tell them apart.
    const cleanup = registerRuntimeHandlers(
      MakaioBus,
      () => [],
      () => new Map(),
      (name) => (name === 'my-extension' ? { configSchema: z.object({ apiKey: z.string().trim() }) } : undefined),
      (name) =>
        name === 'my-extension'
          ? { kind: 'config', source: '/etc/makaio/operator.json', config: { apiKey: ' raw-key ' } }
          : undefined,
      () => undefined,
    );

    const result = await MakaioBus.request(SettingsSubjects.extension.getConfigSchema, {
      extensionName: 'my-extension',
    });

    expect(result.hasSchema).toBe(true);
    expect(result.operatorConfig).toEqual({ source: '/etc/makaio/operator.json', keys: ['apiKey'] });
    // The raw ' raw-key ' operator input is never surfaced as an effective value.
    expect(result.operatorConfig?.values).toBeUndefined();

    cleanup();
  });
});
