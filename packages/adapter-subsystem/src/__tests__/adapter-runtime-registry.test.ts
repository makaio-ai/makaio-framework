import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  type AdapterContribution,
  type ExtensionContext,
  type MakaioExtension,
} from '@makaio/contracts';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ModelRegistryProviderNotFoundError, ModelRegistrySubjects } from '@makaio/services-core/model-registry';
import { ExtensionSubjects } from '@makaio/kernel';
import { AdapterRuntimeRegistry } from '../adapter-runtime-registry.js';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { initializeEnabledAdapters } from '../adapter-runtime-lifecycle.js';
import { cloneAdapterClientRefs, resolveDefaultClientId } from '../adapter-client-refs.js';
import type { AdapterInstance, LoadedAdapter } from '../adapter-runtime-types.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

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
    providers: [],
  };
}

function createContribution(
  name: string,
  createAdapter: (options?: unknown) => Promise<AdapterInstance>,
  providers: AdapterContribution['definition']['providers'] = [],
): AdapterContribution {
  return {
    manifest: {
      name,
      displayName: name,
      protocols: ['anthropic'],
    },
    definition: {
      name,
      displayName: name,
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

function createExtension(name: string, adapters: readonly AdapterContribution[]): MakaioExtension {
  return {
    name,
    displayName: name,
    adapters,
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
          { bus: MakaioBus } as ExtensionContext,
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
        { bus: MakaioBus } as ExtensionContext,
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
        { bus: MakaioBus } as ExtensionContext,
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

  it('fails activation before registration when a declared provider is absent from the catalog', async () => {
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

    await expect(
      service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution(
            'missing-provider-adapter',
            async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId }),
            [{ definitionId: 'missing-provider' }],
          ),
        ]),
        { bus: MakaioBus } as ExtensionContext,
      ),
    ).rejects.toThrow(/missing-provider.*dependencies/);

    expect(service.getLoadedAdapters()).toEqual([]);
    expect(service.getAdapterInstances().size).toBe(0);
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
        { bus: MakaioBus } as ExtensionContext,
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

    let capturedOptions: AdapterFactoryOptions | undefined;
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
      { bus: MakaioBus } as ExtensionContext,
    );

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
});
