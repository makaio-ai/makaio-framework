import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  ProviderDefinitionSchema,
  type AdapterContribution,
  type ProviderDefinitionInput,
  createClientDefinition,
} from '@makaio/contracts';
import { ClientSubjects } from '@makaio/contracts/client';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ModelRegistryProviderNotFoundError, ModelRegistrySubjects } from '@makaio/services-core/model-registry';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { ExtensionSubjects } from '@makaio/kernel';
import { AdapterRuntimeRegistry } from '../adapter-runtime-registry.js';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { initializeEnabledAdapters } from '../adapter-runtime-lifecycle.js';
import { cloneAdapterClientRefs, resolveDefaultClientId } from '../adapter-client-refs.js';
import type { AdapterInitOptions, AdapterInstance, LoadedAdapter } from '../adapter-runtime-types.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

const TEST_EXTENSION_CONTEXT: KernelExtensionContext = {
  bus: MakaioBus,
  identity: { extensionName: 'test-extension' } as KernelExtensionContext['identity'],
  platform: process.platform,
  homedir: '/tmp',
  makaioHome: '/tmp/.makaio',
  username: 'test-user',
  dataDir: '/tmp/test-extension',
  machineId: TEST_MACHINE_ID,
  getService: () => undefined,
  tryImport: async () => null,
  signal: new AbortController().signal,
  hasExtension: () => false,
};

class MemoryRepository implements IAdapterConfigRepository {
  public constructor(
    private readonly providerConfigs = new Map<string, ProviderConfigFile>(),
    private readonly adapters = new Map<string, AdapterFile>(),
  ) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    return { configs: new Map([...this.adapters.entries()].map(([name, config]) => [name, structuredClone(config)])) };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    this.providerConfigs.set(id, structuredClone(config));
  }

  public async deleteProviderConfig(id: string): Promise<boolean> {
    return this.providerConfigs.delete(id);
  }

  public async writeAdapterFile(name: string, config: AdapterFile): Promise<void> {
    this.adapters.set(name, structuredClone(config));
  }

  public async deleteAdapterFile(name: string): Promise<boolean> {
    return this.adapters.delete(name);
  }
}

interface AdapterFactoryOptions {
  readonly adapterId: string;
  readonly clientId?: string;
}

function readAdapterFactoryOptions(options: unknown): AdapterFactoryOptions {
  if (
    typeof options === 'object' &&
    options !== null &&
    'adapterId' in options &&
    typeof options.adapterId === 'string'
  ) {
    if ('clientId' in options && options.clientId !== undefined) {
      if (typeof options.clientId !== 'string' || options.clientId.trim().length === 0) {
        throw new Error('Adapter factory received invalid options');
      }
    }

    return {
      adapterId: options.adapterId,
      ...('clientId' in options && typeof options.clientId === 'string' ? { clientId: options.clientId } : {}),
    };
  }

  throw new Error('Adapter factory received invalid options');
}

describe('readAdapterFactoryOptions', () => {
  it.each([42, null, '', '   '])('rejects malformed clientId value %s instead of silently dropping it', (clientId) => {
    expect(() => readAdapterFactoryOptions({ adapterId: 'adapter-id', clientId })).toThrow(
      /Adapter factory received invalid options/,
    );
  });
});

describe('resolveDefaultClientId', () => {
  it('uses a declared clientId override', () => {
    expect(
      resolveDefaultClientId({ clientId: 'claude-code-nightly' }, [
        { id: 'claude-code', version: '^1.0.0' },
        { id: 'claude-code-nightly', version: '>=2.0.0' },
      ]),
    ).toBe('claude-code-nightly');
  });

  it('falls back to the first declared client when the override is stale', () => {
    expect(
      resolveDefaultClientId({ clientId: 'retired-client' }, [
        { id: 'claude-code', version: '^1.0.0' },
        { id: 'claude-code-nightly', version: '>=2.0.0' },
      ]),
    ).toBe('claude-code');
  });

  it('drops a stale clientId override when the adapter no longer declares clients', () => {
    expect(resolveDefaultClientId({ clientId: 'retired-client' }, undefined)).toBeUndefined();
  });
});

describe('cloneAdapterClientRefs', () => {
  it('normalizes empty client declarations to the canonical absent shape', () => {
    expect(cloneAdapterClientRefs([])).toBeUndefined();
  });
});

function createLoadedAdapter(name: string, packageName: string): LoadedAdapter {
  return {
    name,
    displayName: name,
    packageName,
    factory: async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
    options: {
      adapterId: buildDeterministicAdapterId(TEST_MACHINE_ID, name),
    },
    providerDefinitionIds: [],
    providerRefs: [],
    providers: [],
  };
}

function createContribution(
  name: string,
  createAdapter: (options?: unknown) => Promise<AdapterInstance>,
  providers: AdapterContribution['definition']['providers'] = [],
  options: {
    readonly definitionProtocol?: AdapterContribution['definition']['protocol'];
    readonly manifestProtocols?: AdapterContribution['manifest']['protocols'];
  } = {},
): AdapterContribution {
  return {
    manifest: {
      name,
      displayName: name,
      protocols: options.manifestProtocols ?? ['anthropic'],
    },
    definition: {
      name,
      displayName: name,
      ...(options.definitionProtocol !== undefined ? { protocol: options.definitionProtocol } : {}),
      providers,
      defaultTimeouts: {
        initialization: 30_000,
        acknowledgement: 30_000,
        completion: 60_000,
        toolApproval: 5_000,
        eventWait: 10_000,
      },
      createAdapter,
    },
  };
}

function createExtension(
  name: string,
  adapters: readonly AdapterContribution[],
  providers?: readonly ProviderDefinitionInput[],
): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    adapters,
    ...(providers !== undefined ? { providers } : {}),
  };
}

describe('AdapterRuntimeRegistry', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('rejects duplicate adapter names and names both owning packages', () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
    });

    registry.registerAdapter(createLoadedAdapter('duplicate-adapter', '@owner/first'), '@owner/first');

    expect(() =>
      registry.registerAdapter(createLoadedAdapter('duplicate-adapter', '@owner/second'), '@owner/second'),
    ).toThrow(/duplicate-adapter.*@owner\/first.*@owner\/second/);
  });
});

describe('AdapterContributionProcessor rollback', () => {
  let service: AdapterSubsystemService;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    // Fallback catalog handler: returns an empty contributions catalog.
    // Runs at priority -1 so that per-test catalog handlers registered at the
    // default priority (0) always run first and can set the result before this
    // fallback is reached.
    MakaioBus.on(
      ExtensionSubjects.contributions.catalog,
      (ctx) => {
        ctx.setResult({ providers: [], clients: [] });
      },
      { priority: -1 },
    );
  });

  afterEach(async () => {
    await service?.destroy?.();
    MakaioBus.__resetHandlers?.();
  });

  it('deregisters the current adapter when initialization fails after registration', async () => {
    const firstShutdown = vi.fn().mockResolvedValue(undefined);
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['first-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
        ['second-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const registeredEvents: string[] = [];
    const offRegistered = MakaioBus.on(AdapterSubsystemSubjects.adapter.registered, (ctx) => {
      registeredEvents.push(ctx.payload.adapterName);
    });

    try {
      await expect(
        service.processAdapterContributions(
          '@owner/failing-package',
          createExtension('@owner/failing-package', [
            createContribution('first-adapter', async (options?: unknown) => ({
              adapterId: readAdapterFactoryOptions(options).adapterId,
              shutdown: firstShutdown,
            })),
            createContribution('second-adapter', async () => {
              throw new Error('Injected adapter init failure');
            }),
          ]),
          TEST_EXTENSION_CONTEXT,
        ),
      ).rejects.toThrow(/Injected adapter init failure/);

      expect(service.getLoadedAdapters()).toEqual([]);
      expect(service.getAdapterInstances().size).toBe(0);
      expect(firstShutdown).toHaveBeenCalledOnce();
      expect(registeredEvents).toEqual([]);
    } finally {
      offRegistered();
    }
  });

  it('loads provider definitions with empty models when the model registry has no provider entry', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['test-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const registryHandler = vi.fn((providerId: string) => {
      throw new ModelRegistryProviderNotFoundError(providerId);
    });
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: { id: 'test-provider', name: 'Test Provider', availableModels: [] },
          },
        ],
        clients: [],
      });
    });
    const offRegistry = MakaioBus.on(ModelRegistrySubjects.getProviderModels, (ctx) => {
      registryHandler(ctx.payload.providerId);
    });

    try {
      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [
          createContribution(
            'test-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'test-provider' }],
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getLoadedAdapters()[0]?.providers[0]?.definition.availableModels).toEqual([]);
      expect(registryHandler).toHaveBeenCalledOnce();
      expect(registryHandler).toHaveBeenCalledWith('test-provider');
    } finally {
      offCatalog();
      offRegistry();
    }
  });

  it('keeps catalog-declared provider models when the registry does not own that provider', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['test-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const registryHandler = vi.fn((providerId: string) => providerId);
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: {
              id: 'external-provider',
              name: 'External Provider',
              availableModels: [
                {
                  name: 'external-model',
                  friendlyName: 'External Model',
                  contextWindowSize: 8_192,
                  labId: 'external-lab',
                },
              ],
            },
          },
        ],
        clients: [],
      });
    });
    const offRegistry = MakaioBus.on(ModelRegistrySubjects.getProviderModels, (ctx) => {
      registryHandler(ctx.payload.providerId);
      throw new ModelRegistryProviderNotFoundError('external-provider');
    });

    try {
      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [
          createContribution(
            'test-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'external-provider' }],
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const [model] = service.getLoadedAdapters()[0]?.providers[0]?.definition.availableModels ?? [];
      expect(model).toMatchObject({ name: 'external-model', friendlyName: 'External Model' });
      expect(registryHandler).toHaveBeenCalledOnce();
      expect(registryHandler).toHaveBeenCalledWith('external-provider');
    } finally {
      offCatalog();
      offRegistry();
    }
  });

  it('keeps catalog-declared provider models when registry model population fails', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['test-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const registryHandler = vi.fn((providerId: string) => providerId);
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: {
              id: 'transient-provider',
              name: 'Transient Provider',
              availableModels: [
                {
                  name: 'transient-model',
                  friendlyName: 'Transient Model',
                  contextWindowSize: 8_192,
                  labId: 'transient-lab',
                },
              ],
            },
          },
        ],
        clients: [],
      });
    });
    const offRegistry = MakaioBus.on(ModelRegistrySubjects.getProviderModels, (ctx) => {
      registryHandler(ctx.payload.providerId);
      throw new Error('Injected registry refresh failure');
    });

    try {
      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [
          createContribution(
            'test-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'transient-provider' }],
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const [model] = service.getLoadedAdapters()[0]?.providers[0]?.definition.availableModels ?? [];
      expect(model).toMatchObject({ name: 'transient-model', friendlyName: 'Transient Model' });
      expect(registryHandler).toHaveBeenCalledOnce();
      expect(registryHandler).toHaveBeenCalledWith('transient-provider');
    } finally {
      offCatalog();
      offRegistry();
    }
  });

  it('serves framework-only provider storage reads from loaded adapter definitions', async () => {
    const providerDefinition = {
      id: 'runtime-provider',
      name: 'Runtime Provider',
      description: 'Provider contributed by a framework-only extension',
      endpoints: {
        anthropic: 'https://runtime-provider.example/anthropic',
      },
      defaultModel: 'runtime-model',
      fastModel: 'runtime-fast-model',
      defaultModelFilterMode: 'allowlist',
      credentialEnvVars: {
        apiKey: 'RUNTIME_PROVIDER_API_KEY',
      },
      availableModels: [
        {
          name: 'runtime-model',
          friendlyName: 'Runtime Model',
          contextWindowSize: 16_384,
          labId: 'runtime-provider',
        },
      ],
    } satisfies ProviderDefinitionInput;
    const repository = new MemoryRepository();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [{ packageName: '@owner/runtime-provider-package', definition: providerDefinition }],
        clients: [],
      });
    });

    try {
      await service.processAdapterContributions(
        '@owner/runtime-adapter-extension',
        createExtension('@owner/runtime-adapter-extension', [
          createContribution(
            'runtime-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'runtime-provider' }],
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const { provider } = await MakaioBus.request(ProviderStorageSubjects.get, { id: 'runtime-provider' });
      const { providers } = await MakaioBus.request(ProviderStorageSubjects.list, {});
      const { providers: anthropicProviders } = await MakaioBus.request(ProviderStorageSubjects.listByProtocol, {
        protocol: 'anthropic',
      });
      const { providers: openAiProviders } = await MakaioBus.request(ProviderStorageSubjects.listByProtocol, {
        protocol: 'openai',
      });

      expect(provider).toMatchObject({
        id: 'runtime-provider',
        packageName: '@owner/runtime-provider-package',
        name: 'Runtime Provider',
        description: 'Provider contributed by a framework-only extension',
        endpoints: {
          anthropic: 'https://runtime-provider.example/anthropic',
        },
        defaultModel: 'runtime-model',
        fastModel: 'runtime-fast-model',
        defaultModelFilterMode: 'allowlist',
        credentialEnvVars: {
          apiKey: 'RUNTIME_PROVIDER_API_KEY',
        },
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(provider?.availableModels).toEqual(providerDefinition.availableModels);
      expect(providers.map((entry) => entry.id)).toContain('runtime-provider');
      expect(anthropicProviders.map((entry) => entry.id)).toEqual(['runtime-provider']);
      expect(openAiProviders).toEqual([]);
    } finally {
      offCatalog();
    }
  });

  it('lets host provider storage handlers override loaded adapter fallback records', async () => {
    const repository = new MemoryRepository();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offProvider = MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: 'runtime-provider',
          packageName: '@owner/host-storage',
          name: 'Host Storage Provider',
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });

    try {
      await service.processAdapterContributions(
        '@owner/runtime-provider-extension',
        createExtension(
          '@owner/runtime-provider-extension',
          [
            createContribution(
              'runtime-adapter',
              async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
              [{ definitionId: 'runtime-provider' }],
            ),
          ],
          [{ id: 'runtime-provider', name: 'Runtime Provider' }],
        ),
        TEST_EXTENSION_CONTEXT,
      );

      await expect(MakaioBus.request(ProviderStorageSubjects.get, { id: 'runtime-provider' })).resolves.toMatchObject({
        provider: {
          packageName: '@owner/host-storage',
          name: 'Host Storage Provider',
        },
      });
    } finally {
      offProvider();
    }
  });

  it('loads adapter with empty providers when a declared provider is absent from the catalog', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['missing-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const registeredProviderDefinitionIds: string[][] = [];
    const offRegistered = MakaioBus.on(
      AdapterSubsystemSubjects.adapter.registered,
      (ctx) => {
        registeredProviderDefinitionIds.push([...ctx.payload.providerDefinitionIds]);
      },
      { filter: { adapterName: 'missing-provider-adapter' } },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution(
            'missing-provider-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'missing-provider' }],
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getLoadedAdapters()).toHaveLength(1);
      expect(service.getLoadedAdapters()[0]?.providers).toEqual([]);
      expect(service.getLoadedAdapters()[0]?.providerDefinitionIds).toEqual(['missing-provider']);
      expect(registeredProviderDefinitionIds).toEqual([['missing-provider']]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing-provider'));
    } finally {
      offRegistered();
      warnSpy.mockRestore();
    }
  });

  it('resolves declared provider definitions when their provider extension becomes active later', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['late-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const providers: ProviderDefinitionInput[] = [];
    const factory = vi.fn(async (options?: unknown) => {
      const adapterOptions = options as AdapterInitOptions;
      return { adapterId: readAdapterFactoryOptions(options).adapterId, providers: adapterOptions.definitionProviders };
    });
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: providers.map((definition) => ({
          packageName: '@owner/provider-package',
          definition: ProviderDefinitionSchema.parse(definition),
        })),
        clients: [],
      });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('late-provider-adapter', factory, [{ definitionId: 'late-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, {
          adapterName: 'late-provider-adapter',
        }),
      ).resolves.toEqual({ definitions: [] });
      expect(service.getAdapterInstances().size).toBe(0);
      expect(factory).not.toHaveBeenCalled();

      providers.push({ id: 'late-provider', name: 'Late Provider', availableModels: [] });

      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [], providers),
        TEST_EXTENSION_CONTEXT,
      );

      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, {
          adapterName: 'late-provider-adapter',
        }),
      ).resolves.toEqual({
        definitions: [{ id: 'late-provider', name: 'Late Provider', availableModels: [] }],
      });
      await expect(MakaioBus.request(ProviderStorageSubjects.get, { id: 'late-provider' })).resolves.toMatchObject({
        provider: {
          id: 'late-provider',
          packageName: '@owner/provider-package',
          name: 'Late Provider',
        },
      });
      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect((factory.mock.calls[0]?.[0] as AdapterInitOptions).definitionProviders?.[0]?.definition.id).toBe(
        'late-provider',
      );
    } finally {
      offCatalog();
      warnSpy.mockRestore();
    }
  });

  it('uses providers from the activating extension when retrying deferred adapter initialization', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['activating-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const factory = vi.fn(async (options?: unknown) => {
      const adapterOptions = options as AdapterInitOptions;
      return { adapterId: readAdapterFactoryOptions(options).adapterId, providers: adapterOptions.definitionProviders };
    });
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({ providers: [], clients: [] });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('activating-provider-adapter', factory, [{ definitionId: 'activating-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(0);
      expect(factory).not.toHaveBeenCalled();

      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension(
          '@owner/provider-package',
          [],
          [{ id: 'activating-provider', name: 'Activating Provider', availableModels: [] }],
        ),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect((factory.mock.calls[0]?.[0] as AdapterInitOptions).definitionProviders?.[0]).toMatchObject({
        providerPackageName: '@owner/provider-package',
        definition: { id: 'activating-provider', name: 'Activating Provider' },
      });
    } finally {
      offCatalog();
      warnSpy.mockRestore();
    }
  });

  it('does not fail provider package activation when deferred adapter initialization fails', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['late-failing-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const providers: ProviderDefinitionInput[] = [];
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: providers.map((definition) => ({
          packageName: '@owner/provider-package',
          definition: ProviderDefinitionSchema.parse(definition),
        })),
        clients: [],
      });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('late-failing-adapter', async () => {
            throw new Error('Injected deferred init failure');
          }, [{ definitionId: 'late-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      providers.push({ id: 'late-provider', name: 'Late Provider', availableModels: [] });

      await expect(
        service.processAdapterContributions(
          '@owner/provider-package',
          createExtension('@owner/provider-package', [], providers),
          TEST_EXTENSION_CONTEXT,
        ),
      ).resolves.toBeUndefined();

      expect(service.getAdapterInstances().size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Deferred initialization failed for adapter "late-failing-adapter"'),
        expect.any(Error),
      );
    } finally {
      offCatalog();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rejects a definition protocol that is absent from the adapter manifest protocols', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['protocol-mismatch-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    await expect(
      service.processAdapterContributions(
        '@owner/protocol-package',
        createExtension('@owner/protocol-package', [
          createContribution(
            'protocol-mismatch-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [],
            { definitionProtocol: 'openai', manifestProtocols: ['anthropic'] },
          ),
        ]),
        TEST_EXTENSION_CONTEXT,
      ),
    ).rejects.toThrow(/protocol-mismatch-adapter.*openai.*manifest\.protocols.*anthropic/);

    expect(service.getLoadedAdapters()).toEqual([]);
    expect(service.getAdapterInstances().size).toBe(0);
  });

  it('derives the runtime protocol when the manifest declares exactly one protocol', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['single-protocol-adapter', { $schema: 'makaio/adapter-config/v1', enabled: false }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    await service.processAdapterContributions(
      '@owner/protocol-package',
      createExtension('@owner/protocol-package', [
        createContribution(
          'single-protocol-adapter',
          async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
          [],
          { manifestProtocols: [{ openai: { endpoint: 'https://example.test/v1' } }] },
        ),
      ]),
      TEST_EXTENSION_CONTEXT,
    );

    expect(service.getLoadedAdapters()[0]?.protocol).toBe('openai');
  });

  it('does not infer a runtime protocol from a multi-protocol manifest', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['multi-protocol-adapter', { $schema: 'makaio/adapter-config/v1', enabled: false }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    await service.processAdapterContributions(
      '@owner/protocol-package',
      createExtension('@owner/protocol-package', [
        createContribution(
          'multi-protocol-adapter',
          async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
          [],
          { manifestProtocols: ['anthropic', 'openai'] },
        ),
      ]),
      TEST_EXTENSION_CONTEXT,
    );

    expect(service.getLoadedAdapters()[0]?.protocol).toBeUndefined();
  });

  it('applies adapter-level provider schemas and preserves per-provider overrides during resolution', async () => {
    const adapterLevelConfigSchema = z.object({ baseUrl: z.string().url() });
    const adapterLevelCredentialSchema = z.object({ apiKey: z.string().min(1) });
    const providerOverrideConfigSchema = z.object({ endpoint: z.string().url() });
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['schema-adapter', { $schema: 'makaio/adapter-config/v1', enabled: false }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: { id: 'default-schema-provider', name: 'Default Schema Provider', availableModels: [] },
          },
          {
            packageName: '@owner/provider-package',
            definition: { id: 'override-schema-provider', name: 'Override Schema Provider', availableModels: [] },
          },
        ],
        clients: [],
      });
    });

    try {
      const contribution = createContribution(
        'schema-adapter',
        async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
        [
          { definitionId: 'default-schema-provider' },
          { definitionId: 'override-schema-provider', configSchema: providerOverrideConfigSchema },
        ],
      );

      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          {
            ...contribution,
            definition: {
              ...contribution.definition,
              providerConfigSchema: adapterLevelConfigSchema,
              providerCredentialSchema: adapterLevelCredentialSchema,
            },
          },
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const [defaultProvider, overrideProvider] = service.getLoadedAdapters()[0]?.providers ?? [];
      expect(defaultProvider?.configSchema).toBe(adapterLevelConfigSchema);
      expect(defaultProvider?.credentialSchema).toBe(adapterLevelCredentialSchema);
      expect(overrideProvider?.configSchema).toBe(providerOverrideConfigSchema);
      expect(overrideProvider?.credentialSchema).toBe(adapterLevelCredentialSchema);
    } finally {
      offCatalog();
    }
  });

  it('passes the runtime bus as globalBus to the adapter factory', async () => {
    const adapterId = buildDeterministicAdapterId(TEST_MACHINE_ID, 'bus-check-adapter');
    const adapterInstances = new Map<string, AdapterInstance>();
    let capturedGlobalBus: unknown;
    const offGetConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'bus-check-adapter', enabled: true, bindings: [] } });
    });

    try {
      await initializeEnabledAdapters(
        MakaioBus,
        TEST_MACHINE_ID,
        [
          {
            name: 'bus-check-adapter',
            displayName: 'Bus Check Adapter',
            packageName: '@owner/bus-check-package',
            factory: async (options?: unknown) => {
              const opts = options as Record<string, unknown>;
              capturedGlobalBus = opts?.globalBus;
              return { adapterId: readAdapterFactoryOptions(options).adapterId };
            },
            options: { adapterId },
            providerDefinitionIds: [],
            providerRefs: [],
            providers: [],
          },
        ],
        adapterInstances,
        TEST_PLATFORM_DEFAULTS,
      );

      expect(capturedGlobalBus).toBe(MakaioBus);
    } finally {
      offGetConfig();
      adapterInstances.clear();
    }
  });

  it('rolls back a directly initialized instance when adapter.initialized emission fails', async () => {
    const adapterId = buildDeterministicAdapterId(TEST_MACHINE_ID, 'event-failing-adapter');
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const adapterInstances = new Map<string, AdapterInstance>();
    const offGetConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'event-failing-adapter', enabled: true, bindings: [] } });
    });
    const offInitialized = MakaioBus.on(AdapterSubjects.initialized, () => {
      throw new Error('Injected initialized emit failure');
    });

    try {
      await expect(
        initializeEnabledAdapters(
          MakaioBus,
          TEST_MACHINE_ID,
          [
            {
              name: 'event-failing-adapter',
              displayName: 'Event Failing Adapter',
              packageName: '@owner/event-failing-package',
              factory: async (options?: unknown) => ({
                adapterId: readAdapterFactoryOptions(options).adapterId,
                shutdown,
              }),
              options: { adapterId },
              providerDefinitionIds: [],
              providerRefs: [],
              providers: [],
            },
          ],
          adapterInstances,
          TEST_PLATFORM_DEFAULTS,
        ),
      ).rejects.toThrow(/event-failing-adapter: Injected initialized emit failure/);

      expect(adapterInstances.size).toBe(0);
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      offInitialized();
      offGetConfig();
    }
  });

  it('projects manifest client refs and forwards the first client as the runtime default', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.2.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code-nightly',
              name: 'Claude Code Nightly',
              version: '2.0.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
        ],
      });
    });

    let capturedOptions: AdapterFactoryOptions | undefined;
    try {
      await service.processAdapterContributions(
        '@owner/client-backed-package',
        createExtension('@owner/client-backed-package', [
          {
            manifest: {
              name: 'client-backed-adapter',
              displayName: 'Client Backed Adapter',
              protocols: ['anthropic'],
              clients: [
                { id: 'claude-code', version: '^1.0.0' },
                { id: 'claude-code-nightly', version: '>=2.0.0' },
              ],
            },
            definition: {
              name: 'client-backed-adapter',
              displayName: 'Client Backed Adapter',
              providers: [],
              defaultTimeouts: {
                initialization: 30_000,
                acknowledgement: 30_000,
                completion: 60_000,
                toolApproval: 5_000,
                eventWait: 10_000,
              },
              createAdapter: async (options?: unknown) => {
                capturedOptions = readAdapterFactoryOptions(options);
                return { adapterId: capturedOptions.adapterId };
              },
            },
          },
        ]),
        TEST_EXTENSION_CONTEXT,
      );
    } finally {
      offCatalog();
    }

    expect(service.getLoadedAdapters()[0]).toMatchObject({
      clients: [
        { id: 'claude-code', version: '^1.0.0' },
        { id: 'claude-code-nightly', version: '>=2.0.0' },
      ],
    });
    expect(capturedOptions).toMatchObject({
      clientId: 'claude-code',
    });
  });

  it('rejects an adapter that references a missing client', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    await expect(
      service.processAdapterContributions(
        '@owner/client-backed-package',
        {
          name: '@owner/client-backed-package',
          displayName: '@owner/client-backed-package',
          version: '0.1.0',
          adapters: [
            {
              ...createContribution('client-backed-adapter', async (options?: unknown) => ({
                adapterId: readAdapterFactoryOptions(options).adapterId,
              })),
              manifest: {
                name: 'client-backed-adapter',
                displayName: 'Client Backed Adapter',
                protocols: ['anthropic'],
                clients: [{ id: 'missing-client', version: '^1.0.0' }],
              },
            },
          ],
        },
        TEST_EXTENSION_CONTEXT,
      ),
    ).rejects.toThrow(/references missing client "missing-client"/);
  });

  it('rejects an adapter when the referenced client definition version is incompatible', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.2.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
        ],
      });
    });

    try {
      await expect(
        service.processAdapterContributions(
          '@owner/client-backed-package',
          {
            name: '@owner/client-backed-package',
            displayName: '@owner/client-backed-package',
            version: '0.1.0',
            adapters: [
              {
                ...createContribution('client-backed-adapter', async (options?: unknown) => ({
                  adapterId: readAdapterFactoryOptions(options).adapterId,
                })),
                manifest: {
                  name: 'client-backed-adapter',
                  displayName: 'Client Backed Adapter',
                  protocols: ['anthropic'],
                  clients: [{ id: 'claude-code', version: '^2.0.0' }],
                },
              },
            ],
          },
          TEST_EXTENSION_CONTEXT,
        ),
      ).rejects.toThrow(/client "claude-code" definition version 1\.2\.0 does not satisfy \^2\.0\.0/);
    } finally {
      offCatalog();
    }
  });

  it('rejects an adapter when the resolved client binary version is incompatible', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.2.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
        ],
      });
    });
    const offResolve = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult({ binaryPath: null, env: {}, configDir: null, source: 'global', version: '1.5.0' });
    });

    try {
      await expect(
        service.processAdapterContributions(
          '@owner/client-backed-package',
          {
            name: '@owner/client-backed-package',
            displayName: '@owner/client-backed-package',
            version: '0.1.0',
            adapters: [
              {
                ...createContribution('client-backed-adapter', async (options?: unknown) => ({
                  adapterId: readAdapterFactoryOptions(options).adapterId,
                })),
                manifest: {
                  name: 'client-backed-adapter',
                  displayName: 'Client Backed Adapter',
                  protocols: ['anthropic'],
                  clients: [{ id: 'claude-code', version: '^1.0.0', binaryVersion: '>=2.0.0' }],
                },
              },
            ],
          },
          TEST_EXTENSION_CONTEXT,
        ),
      ).rejects.toThrow(/client "claude-code" binary version 1\.5\.0 does not satisfy >=2\.0\.0/);
    } finally {
      offCatalog();
      offResolve();
    }
  });

  it('defers client binary resolution for disabled adapters', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: false }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.2.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
        ],
      });
    });
    const resolveHandler = vi.fn();
    const offResolve = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      resolveHandler();
      ctx.setResult({ binaryPath: null, env: {}, configDir: null, source: 'global', version: null });
    });

    try {
      await service.processAdapterContributions(
        '@owner/client-backed-package',
        {
          name: '@owner/client-backed-package',
          displayName: '@owner/client-backed-package',
          version: '0.1.0',
          adapters: [
            {
              ...createContribution('client-backed-adapter', async (options?: unknown) => ({
                adapterId: readAdapterFactoryOptions(options).adapterId,
              })),
              manifest: {
                name: 'client-backed-adapter',
                displayName: 'Client Backed Adapter',
                protocols: ['anthropic'],
                clients: [{ id: 'claude-code', version: '^1.0.0', binaryVersion: '>=2.0.0' }],
              },
            },
          ],
        },
        TEST_EXTENSION_CONTEXT,
      );

      expect(resolveHandler).not.toHaveBeenCalled();
      expect(service.getLoadedAdapters()[0]?.name).toBe('client-backed-adapter');
    } finally {
      offCatalog();
      offResolve();
    }
  });

  it('does not resolve a client binary for universal binaryVersion ranges', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['client-backed-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [],
        clients: [
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code',
              name: 'Claude Code',
              version: '1.2.0',
              defaultApprovalPolicy: 'always-ask',
            }),
          },
        ],
      });
    });
    const resolveHandler = vi.fn();
    const offResolve = MakaioBus.on(ClientSubjects.resolveBinary, (ctx) => {
      resolveHandler();
      ctx.setResult({ binaryPath: null, env: {}, configDir: null, source: 'global', version: null });
    });

    try {
      await service.processAdapterContributions(
        '@owner/client-backed-package',
        {
          name: '@owner/client-backed-package',
          displayName: '@owner/client-backed-package',
          version: '0.1.0',
          adapters: [
            {
              ...createContribution('client-backed-adapter', async (options?: unknown) => ({
                adapterId: readAdapterFactoryOptions(options).adapterId,
              })),
              manifest: {
                name: 'client-backed-adapter',
                displayName: 'Client Backed Adapter',
                protocols: ['anthropic'],
                clients: [{ id: 'claude-code', version: '^1.0.0', binaryVersion: '*' }],
              },
            },
          ],
        },
        TEST_EXTENSION_CONTEXT,
      );

      expect(resolveHandler).not.toHaveBeenCalled();
      expect(service.getLoadedAdapters()[0]?.name).toBe('client-backed-adapter');
    } finally {
      offCatalog();
      offResolve();
    }
  });
});
