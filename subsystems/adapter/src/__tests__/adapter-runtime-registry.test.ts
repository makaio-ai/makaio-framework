import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  ProviderDefinitionSchema,
  defineAdapterProviderAuth,
  type AdapterContribution,
  type ConnectorTeardownResult,
  type ProviderDefinition,
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
import {
  AdapterSubsystemService as RuntimeAdapterSubsystemService,
  type AdapterSubsystemServiceOptions,
} from '../adapter-subsystem-service.js';
import { ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS } from '../adapter-runtime-lifecycle.js';
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

/** Test composition with an explicit ownership-authority incarnation. */
class AdapterSubsystemService extends RuntimeAdapterSubsystemService {
  public constructor(options: Omit<AdapterSubsystemServiceOptions, 'resolveOwnerInstanceId'>) {
    super({ ...options, resolveOwnerInstanceId: () => 'test-owner-instance' });
  }
}

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

type RestartCloseHook = 'shutdown' | 'closeAsync' | 'close';

function createRestartTrackingFactory(
  closeHook: () => void | ConnectorTeardownResult | Promise<void | ConnectorTeardownResult>,
  hookName: RestartCloseHook = 'shutdown',
) {
  const factory = vi.fn(async (options?: unknown) => {
    const adapterOptions = options as AdapterInitOptions;
    const callCount = factory.mock.calls.length;
    return {
      adapterId: readAdapterFactoryOptions(options).adapterId,
      providers: adapterOptions.definitionProviders,
      ...(callCount === 1 ? { [hookName]: closeHook } : {}),
    };
  });
  return factory;
}

function getFactoryInitOptions(factory: { mock: { calls: Array<[unknown?, ...unknown[]]> } }, callIndex: number) {
  const options = factory.mock.calls[callIndex]?.[0];
  if (!options) {
    throw new Error(`Factory call ${callIndex} was not recorded`);
  }
  return options as AdapterInitOptions;
}

/**
 * Create adapter/provider auth metadata for one provider-backed API-key method.
 * @param providerDefinitionId - Provider definition that owns the method.
 * @returns Validated adapter/provider auth metadata.
 */
function createTestProviderAuth(providerDefinitionId: string) {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'TEST_PROVIDER_API_KEY' } }],
      },
    ],
    scrubEnvVars: ['TEST_PROVIDER_API_KEY'],
  });
}

/**
 * Create a provider definition matching {@link createTestProviderAuth}.
 * @param id - Stable provider definition ID.
 * @param name - Human-readable provider name.
 * @returns Provider definition with one explicit API-key method.
 */
function createTestAuthProviderDefinition(id: string, name: string): ProviderDefinition {
  return ProviderDefinitionSchema.parse({
    id,
    name,
    authMethods: [
      {
        id: 'api-key',
        mode: 'explicit',
        label: 'API key',
        fields: [
          {
            id: 'apiKey',
            label: 'API key',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: 'TEST_PROVIDER_API_KEY' }],
          },
        ],
      },
    ],
    availableModels: [],
  });
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
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });

    registry.registerAdapter(createLoadedAdapter('duplicate-adapter', '@owner/first'), '@owner/first');

    expect(() =>
      registry.registerAdapter(createLoadedAdapter('duplicate-adapter', '@owner/second'), '@owner/second'),
    ).toThrow(/duplicate-adapter.*@owner\/first.*@owner\/second/);
  });

  it('resolves only a current live instance and reflects restart and deregistration', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const explicitAdapterId = 'host-configured-live-adapter-id';
    const shutdown = vi.fn().mockResolvedValue({ evidence: 'released' });
    const adapter: LoadedAdapter = {
      ...createLoadedAdapter('live-adapter', '@owner/live'),
      factory: async () => ({ adapterId: explicitAdapterId, shutdown }),
      options: { adapterId: explicitAdapterId },
    };
    registry.registerAdapter(adapter, '@owner/live');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'live-adapter', enabled: true, bindings: [] } });
    });

    expect(registry.resolveLiveAdapterId('live-adapter')).toBeUndefined();
    await registry.initializeAdapter(adapter, TEST_PLATFORM_DEFAULTS);
    expect(registry.resolveLiveAdapterId('live-adapter')).toBe(explicitAdapterId);

    await registry.restartAdapterInstance(adapter, TEST_PLATFORM_DEFAULTS);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(registry.resolveLiveAdapterId('live-adapter')).toBe(explicitAdapterId);

    await registry.deregisterAdapter('live-adapter');
    expect(registry.resolveLiveAdapterId('live-adapter')).toBeUndefined();
  });

  it('keeps a weakly retired dynamic adapter non-routable until a later activation proves it stopped', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('retry-retiring-adapter', '@owner/retry-retiring');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const closeAsync = vi
      .fn<() => Promise<{ evidence: 'detached' } | { evidence: 'released' }>>()
      .mockResolvedValueOnce({ evidence: 'detached' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const factory = vi.fn(async () => ({ adapterId, closeAsync }));
    const retiringAdapter = { ...adapter, factory };
    registry.registerAdapter(retiringAdapter, '@owner/retry-retiring');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: retiringAdapter.name, enabled: true, bindings: [] } });
    });

    await registry.initializeAdapter(retiringAdapter, TEST_PLATFORM_DEFAULTS);
    await registry.deregisterAdapter(retiringAdapter.name);

    expect(closeAsync).toHaveBeenCalledOnce();
    expect(registry.resolveLiveAdapterId(retiringAdapter.name)).toBeUndefined();
    expect(registry.getAdapterInstances()).toEqual(new Map());
    expect(factory).toHaveBeenCalledOnce();

    // A package that comes back while its former handle is still retiring must
    // reuse the slot and retry close, never construct a competing instance.
    registry.registerAdapter(retiringAdapter, '@owner/retry-retiring');
    await registry.initializeAdapter(retiringAdapter, TEST_PLATFORM_DEFAULTS);

    expect(closeAsync).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(registry.resolveLiveAdapterId(retiringAdapter.name)).toBe(adapterId);
  });

  it('replaces a dynamically restarted adapter immediately after observed teardown', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('released-restart-adapter', '@owner/released-restart');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const closeAsync = vi.fn().mockResolvedValue({ evidence: 'released' });
    const factory = vi.fn(async () => ({ adapterId, ...(factory.mock.calls.length === 1 ? { closeAsync } : {}) }));
    const restartableAdapter = { ...adapter, factory };
    registry.registerAdapter(restartableAdapter, '@owner/released-restart');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: restartableAdapter.name, enabled: true, bindings: [] } });
    });

    await registry.initializeAdapter(restartableAdapter, TEST_PLATFORM_DEFAULTS);
    await registry.restartAdapterInstance(restartableAdapter, TEST_PLATFORM_DEFAULTS);

    expect(closeAsync).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(registry.resolveLiveAdapterId(restartableAdapter.name)).toBe(adapterId);
  });

  it('retries retiring handles during host shutdown before clearing the registry', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('shutdown-retry-adapter', '@owner/shutdown-retry');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const closeAsync = vi
      .fn<() => Promise<ConnectorTeardownResult>>()
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'first close did not prove exit' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const shutdownRetryAdapter = {
      ...adapter,
      factory: async () => ({ adapterId, closeAsync }),
    };
    registry.registerAdapter(shutdownRetryAdapter, '@owner/shutdown-retry');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: shutdownRetryAdapter.name, enabled: true, bindings: [] } });
    });

    await registry.initializeAdapter(shutdownRetryAdapter, TEST_PLATFORM_DEFAULTS);
    await registry.deregisterAdapter(shutdownRetryAdapter.name);
    const report = await registry.shutdownAll();

    expect(closeAsync).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ evidence: 'released', results: [{ adapterId, evidence: 'released' }] });
    expect(registry.getAdapterInstances()).toEqual(new Map());
    expect(registry.getLoadedAdapters()).toEqual([]);
  });

  it.each([
    'deregister',
    'restart',
    'shutdown',
  ] as const)('leaves the withdrawal attempt owned by a self-publishing instance during %s', async (operation) => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter(`self-publishing-${operation}`, '@owner/self-publishing');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const withdrawn = vi.fn();
    const selfPublishingAdapter: LoadedAdapter = {
      ...adapter,
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          await MakaioBus.emit(AdapterSubjects.deinitialized, {
            adapterId,
            adapterName: adapter.name,
            machineId: TEST_MACHINE_ID,
            ownerInstanceId: 'test-owner-instance',
          });
          return { evidence: 'released' };
        },
      }),
    };
    registry.registerAdapter(selfPublishingAdapter, '@owner/self-publishing');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);
    await registry.initializeAdapter(selfPublishingAdapter, TEST_PLATFORM_DEFAULTS);

    if (operation === 'deregister') await registry.deregisterAdapter(selfPublishingAdapter.name);
    else if (operation === 'restart')
      await registry.restartAdapterInstance(selfPublishingAdapter, TEST_PLATFORM_DEFAULTS);
    else await registry.shutdownAll();

    expect(withdrawn).toHaveBeenCalledOnce();
  });

  it.each([
    'deregister',
    'restart',
  ] as const)('withdraws a self-publishing instance from live routing when %s cleanup throws afterward', async (operation) => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter(`withdraw-then-fail-${operation}`, '@owner/withdraw-then-fail');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const selfPublishingAdapter: LoadedAdapter = {
      ...adapter,
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          await MakaioBus.emit(AdapterSubjects.deinitialized, {
            adapterId,
            adapterName: adapter.name,
            machineId: TEST_MACHINE_ID,
            ownerInstanceId: 'test-owner-instance',
          });
          throw new Error('cleanup failed after withdrawal');
        },
      }),
    };
    registry.registerAdapter(selfPublishingAdapter, '@owner/withdraw-then-fail');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    await registry.initializeAdapter(selfPublishingAdapter, TEST_PLATFORM_DEFAULTS);

    const cleanup =
      operation === 'deregister'
        ? registry.deregisterAdapter(adapter.name)
        : registry.restartAdapterInstance(selfPublishingAdapter, TEST_PLATFORM_DEFAULTS);
    await expect(cleanup).resolves.toBeUndefined();

    expect(registry.getAdapterInstances().has(adapterId)).toBe(false);
    expect(registry.resolveLiveAdapterId(adapter.name)).toBeUndefined();
    expect(registry.resolveLiveAdapterIdentity(adapterId)).toBeUndefined();
  });

  it.each([
    'deregister',
    'restart',
    'shutdown',
  ] as const)('publishes one ordered fallback withdrawal for a generic instance during %s', async (operation) => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter(`generic-${operation}`, '@owner/generic');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const order: string[] = [];
    const genericAdapter: LoadedAdapter = {
      ...adapter,
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          order.push('close');
        },
      }),
    };
    registry.registerAdapter(genericAdapter, '@owner/generic');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, () => {
      order.push('deinitialized');
    });
    await registry.initializeAdapter(genericAdapter, TEST_PLATFORM_DEFAULTS);

    if (operation === 'deregister') await registry.deregisterAdapter(genericAdapter.name);
    else if (operation === 'restart') await registry.restartAdapterInstance(genericAdapter, TEST_PLATFORM_DEFAULTS);
    else await registry.shutdownAll();

    expect(order).toEqual(['close', 'deinitialized']);
  });

  it.each([
    'deregister',
    'restart',
    'shutdown',
  ] as const)('keeps generic-instance %s cleanup independent of withdrawal subscribers', async (operation) => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter(`rejecting-generic-${operation}`, '@owner/rejecting-generic');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const factory = vi.fn(async () => ({ adapterId, closeAsync: vi.fn().mockResolvedValue(undefined) }));
    const genericAdapter = { ...adapter, factory };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registry.registerAdapter(genericAdapter, '@owner/rejecting-generic');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, () => {
      throw new Error('withdrawal subscriber failed');
    });
    await registry.initializeAdapter(genericAdapter, TEST_PLATFORM_DEFAULTS);

    if (operation === 'deregister') await expect(registry.deregisterAdapter(adapter.name)).resolves.toBeUndefined();
    else if (operation === 'restart')
      await expect(registry.restartAdapterInstance(genericAdapter, TEST_PLATFORM_DEFAULTS)).resolves.toBeUndefined();
    else await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'detached' });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to publish deinitialization for "${adapter.name}"`),
      expect.any(Error),
    );
    expect(registry.getAdapterInstances().size).toBe(0);
    expect(registry.resolveLiveAdapterId(adapter.name)).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it.each([
    'deregister',
    'restart',
    'shutdown',
  ] as const)('keeps managed %s cleanup independent of a rejecting withdrawal subscriber without duplicating the attempt', async (operation) => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter(`rejecting-managed-${operation}`, '@owner/rejecting-managed');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const withdrawn = vi.fn();
    const managedAdapter: LoadedAdapter = {
      ...adapter,
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          try {
            await MakaioBus.emit(AdapterSubjects.deinitialized, {
              adapterId,
              adapterName: adapter.name,
              machineId: TEST_MACHINE_ID,
              ownerInstanceId: 'test-owner-instance',
            });
          } catch {
            // Managed adapters own this best-effort attempt even when a subscriber rejects.
          }
          return { evidence: 'released' };
        },
      }),
    };
    registry.registerAdapter(managedAdapter, '@owner/rejecting-managed');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);
    MakaioBus.on(AdapterSubjects.deinitialized, () => {
      throw new Error('withdrawal subscriber failed');
    });
    await registry.initializeAdapter(managedAdapter, TEST_PLATFORM_DEFAULTS);

    if (operation === 'deregister') await registry.deregisterAdapter(adapter.name);
    else if (operation === 'restart') await registry.restartAdapterInstance(managedAdapter, TEST_PLATFORM_DEFAULTS);
    else await registry.shutdownAll();

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(registry.getAdapterInstances().size).toBe(operation === 'restart' ? 1 : 0);
  });

  it('isolates every shutdown withdrawal fallback from sibling subscriber failures', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const first = createLoadedAdapter('shutdown-first', '@owner/shutdown');
    const second = createLoadedAdapter('shutdown-second', '@owner/shutdown');
    const attempted: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registry.registerAdapter(first, '@owner/shutdown');
    registry.registerAdapter(second, '@owner/shutdown');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: ctx.payload.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, (ctx) => {
      attempted.push(ctx.payload.adapterName);
      if (ctx.payload.adapterName === first.name) throw new Error('first withdrawal failed');
    });
    await registry.initializeAdapter(first, TEST_PLATFORM_DEFAULTS);
    await registry.initializeAdapter(second, TEST_PLATFORM_DEFAULTS);

    await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });

    expect(attempted).toEqual([first.name, second.name]);
    expect(registry.getAdapterInstances().size).toBe(0);
    warn.mockRestore();
  });

  it('withdraws each self-publishing shutdown instance while sibling cleanup is still running', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const first = createLoadedAdapter('early-withdrawal', '@owner/concurrent-shutdown');
    const second = createLoadedAdapter('gated-cleanup', '@owner/concurrent-shutdown');
    const firstAdapterId = registry.resolveLoadedAdapterId(first);
    const secondAdapterId = registry.resolveLoadedAdapterId(second);
    const firstWithdrawn = Promise.withResolvers<void>();
    const secondCloseStarted = Promise.withResolvers<void>();
    const releaseSecondClose = Promise.withResolvers<void>();
    const selfPublishingFirst: LoadedAdapter = {
      ...first,
      factory: async () => ({
        adapterId: firstAdapterId,
        closeAsync: async () => {
          await MakaioBus.emit(AdapterSubjects.deinitialized, {
            adapterId: firstAdapterId,
            adapterName: first.name,
            machineId: TEST_MACHINE_ID,
            ownerInstanceId: 'test-owner-instance',
          });
        },
      }),
    };
    const gatedSecond: LoadedAdapter = {
      ...second,
      factory: async () => ({
        adapterId: secondAdapterId,
        closeAsync: async () => {
          secondCloseStarted.resolve();
          await releaseSecondClose.promise;
        },
      }),
    };
    registry.registerAdapter(selfPublishingFirst, '@owner/concurrent-shutdown');
    registry.registerAdapter(gatedSecond, '@owner/concurrent-shutdown');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: ctx.payload.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, (ctx) => {
      if (ctx.payload.adapterId === firstAdapterId) firstWithdrawn.resolve();
    });
    await registry.initializeAdapter(selfPublishingFirst, TEST_PLATFORM_DEFAULTS);
    await registry.initializeAdapter(gatedSecond, TEST_PLATFORM_DEFAULTS);

    const shutdown = registry.shutdownAll();
    await Promise.all([firstWithdrawn.promise, secondCloseStarted.promise]);

    expect(registry.getAdapterInstances().has(firstAdapterId)).toBe(false);
    expect(registry.resolveLiveAdapterId(first.name)).toBeUndefined();
    expect(registry.resolveLiveAdapterIdentity(firstAdapterId)).toBeUndefined();
    expect(registry.getAdapterInstances().has(secondAdapterId)).toBe(false);
    expect(registry.resolveLiveAdapterId(second.name)).toBeUndefined();

    releaseSecondClose.resolve();
    await expect(shutdown).resolves.toMatchObject({ evidence: 'detached' });
    expect(registry.getAdapterInstances().size).toBe(0);
    expect(registry.getLoadedAdapters()).toEqual([]);
  });

  it('withdraws routing availability while preserving unknown shutdown evidence', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('unknown-shutdown', '@owner/unknown-shutdown');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const withdrawn = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknownAdapter: LoadedAdapter = {
      ...adapter,
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          throw new Error('close outcome unknown');
        },
      }),
    };
    registry.registerAdapter(unknownAdapter, '@owner/unknown-shutdown');
    MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);
    await registry.initializeAdapter(unknownAdapter, TEST_PLATFORM_DEFAULTS);

    const report = await registry.shutdownAll();

    expect(report).toMatchObject({
      evidence: 'unknown',
      results: [{ adapterId, evidence: 'unknown' }],
    });
    expect(withdrawn).toHaveBeenCalledOnce();
    expect(registry.getAdapterInstances().size).toBe(0);
    expect(registry.resolveLiveAdapterId(adapter.name)).toBeUndefined();
    error.mockRestore();
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
    const firstShutdown = vi.fn().mockResolvedValue({ evidence: 'released' });
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

  it('retains rollback state when adapter close rejects during activation rollback', async () => {
    let shouldFailClose = true;
    const closeAsync = vi.fn(async (): Promise<ConnectorTeardownResult> => {
      if (shouldFailClose) {
        throw new Error('close failed');
      }
      return { evidence: 'released' };
    });
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['rollback-retained-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
        ['rollback-failing-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        service.processAdapterContributions(
          '@owner/rollback-package',
          createExtension('@owner/rollback-package', [
            createContribution('rollback-retained-adapter', async (options?: unknown) => ({
              adapterId: readAdapterFactoryOptions(options).adapterId,
              closeAsync,
            })),
            createContribution('rollback-failing-adapter', async () => {
              throw new Error('Injected adapter init failure');
            }),
          ]),
          TEST_EXTENSION_CONTEXT,
        ),
      ).rejects.toThrow(/Injected adapter init failure/);

      expect(closeAsync).toHaveBeenCalledOnce();
      expect(service.getLoadedAdapters().map((adapter) => adapter.name)).toEqual(['rollback-retained-adapter']);
      expect(service.getAdapterInstances().size).toBe(0);

      shouldFailClose = false;
      await service.stopAdapterContributions('@owner/rollback-package');

      expect(closeAsync).toHaveBeenCalledTimes(2);
      expect(service.getLoadedAdapters()).toEqual([]);
      expect(service.getAdapterInstances().size).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('preserves parsed auth metadata while populating provider models for initial activation', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['test-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    const prepareAuthRuntime = vi.fn();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
      prepareAuthRuntime,
    });
    await service.init();
    const registryHandler = vi.fn((providerId: string) => {
      throw new ModelRegistryProviderNotFoundError(providerId);
    });
    const adapterProviderAuth = createTestProviderAuth('test-provider');
    const factory = vi.fn(async (options?: unknown) => ({
      adapterId: readAdapterFactoryOptions(options).adapterId,
    }));
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: createTestAuthProviderDefinition('test-provider', 'Test Provider'),
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
          createContribution('test-adapter', factory, [{ definitionId: 'test-provider', auth: adapterProviderAuth }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const resolvedProvider = service.getLoadedAdapters()[0]?.providers[0];
      expect(resolvedProvider?.definition.availableModels).toEqual([]);
      expect(resolvedProvider?.auth).toEqual(adapterProviderAuth);
      expect(resolvedProvider?.auth).not.toBe(adapterProviderAuth);
      expect(getFactoryInitOptions(factory, 0).definitionProviders?.[0]?.auth).toEqual(adapterProviderAuth);
      expect(getFactoryInitOptions(factory, 0).prepareAuthRuntime).toBe(prepareAuthRuntime);
      expect(registryHandler).toHaveBeenCalledOnce();
      expect(registryHandler).toHaveBeenCalledWith('test-provider');
    } finally {
      offCatalog();
      offRegistry();
    }
  });

  it('rejects malformed auth metadata at the central provider-resolution boundary', async () => {
    const repository = new MemoryRepository();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator(),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const malformedAuth = structuredClone(createTestProviderAuth('test-provider'));
    malformedAuth.scrubEnvVars.push('TEST_PROVIDER_API_KEY');
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: createTestAuthProviderDefinition('test-provider', 'Test Provider'),
          },
        ],
        clients: [],
      });
    });

    try {
      await expect(
        service.processAdapterContributions(
          '@owner/adapter-package',
          createExtension('@owner/adapter-package', [
            createContribution(
              'malformed-auth-adapter',
              async (options?: unknown) => ({
                adapterId: readAdapterFactoryOptions(options).adapterId,
              }),
              [{ definitionId: 'test-provider', auth: malformedAuth }],
            ),
          ]),
          TEST_EXTENSION_CONTEXT,
        ),
      ).rejects.toThrow(/Duplicate scrub environment variable/);
      expect(service.getLoadedAdapters()).toEqual([]);
    } finally {
      offCatalog();
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
              authMethods: [],
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
              authMethods: [],
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
      authMethods: [],
      description: 'Provider contributed by a framework-only extension',
      endpoints: {
        anthropic: 'https://runtime-provider.example/anthropic',
      },
      defaultModel: 'runtime-model',
      fastModel: 'runtime-fast-model',
      defaultModelFilterMode: 'allowlist',
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

  it('removes stopped provider packages from loaded adapter provider fallback records', async () => {
    const providerDefinition = {
      id: 'runtime-provider',
      name: 'Runtime Provider',
      authMethods: [],
      availableModels: [],
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
    let activeProviders: ProviderDefinitionInput[] = [providerDefinition];
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: activeProviders.map((definition) => ({
          packageName: '@owner/runtime-provider-package',
          definition: ProviderDefinitionSchema.parse(definition),
        })),
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

      expect(service.getLoadedAdapters()[0]?.providers.map((entry) => entry.definition.id)).toEqual([
        'runtime-provider',
      ]);
      await expect(MakaioBus.request(ProviderStorageSubjects.get, { id: 'runtime-provider' })).resolves.toMatchObject({
        provider: { id: 'runtime-provider', packageName: '@owner/runtime-provider-package' },
      });

      activeProviders = [];
      await service.stopAdapterContributions('@owner/runtime-provider-package');

      expect(service.getLoadedAdapters()[0]?.providers).toEqual([]);
      await expect(MakaioBus.request(ProviderStorageSubjects.get, { id: 'runtime-provider' })).resolves.toEqual({
        provider: null,
      });
      await expect(MakaioBus.request(ProviderStorageSubjects.list, {})).resolves.toEqual({ providers: [] });
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
          authMethods: [],
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
          [{ id: 'runtime-provider', name: 'Runtime Provider', authMethods: [] }],
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
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['late-provider']) }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const providers: ProviderDefinitionInput[] = [];
    const lateProviderDefinition = createTestAuthProviderDefinition('late-provider', 'Late Provider');
    const adapterProviderAuth = createTestProviderAuth('late-provider');
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
          createContribution('late-provider-adapter', factory, [
            { definitionId: 'late-provider', auth: adapterProviderAuth },
          ]),
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

      providers.push(lateProviderDefinition);

      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [], providers),
        TEST_EXTENSION_CONTEXT,
      );

      await expect(
        MakaioBus.request(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, {
          adapterName: 'late-provider-adapter',
        }),
      ).resolves.toEqual({ definitions: [lateProviderDefinition] });
      await expect(MakaioBus.request(ProviderStorageSubjects.get, { id: 'late-provider' })).resolves.toMatchObject({
        provider: {
          id: 'late-provider',
          packageName: '@owner/provider-package',
          name: 'Late Provider',
        },
      });
      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 0).definitionProviders?.[0]?.definition.id).toBe('late-provider');
      expect(getFactoryInitOptions(factory, 0).definitionProviders?.[0]?.auth).toEqual(adapterProviderAuth);
    } finally {
      offCatalog();
      warnSpy.mockRestore();
    }
  });

  // Keep the restart setup inline in these cases: each test changes the provider
  // timing and close hook, and a broad fixture would hide the lifecycle phase
  // that the assertions are protecting.
  it('restarts a live optional-provider adapter when its provider extension becomes active', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([['late-live-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
    );
    const loadedProviderIds = new Set<string>();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: loadedProviderIds }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const providers: ProviderDefinitionInput[] = [];
    const adapterProviderAuth = createTestProviderAuth('late-provider');
    const firstCloseAsync = vi.fn().mockResolvedValue({ evidence: 'released' });
    const factory = createRestartTrackingFactory(firstCloseAsync, 'closeAsync');
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
          createContribution('late-live-adapter', factory, [
            { definitionId: 'late-provider', auth: adapterProviderAuth },
          ]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 0).definitionProviders).toEqual([]);

      loadedProviderIds.add('late-provider');
      providers.push(createTestAuthProviderDefinition('late-provider', 'Late Provider'));

      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [], providers),
        TEST_EXTENSION_CONTEXT,
      );

      expect(factory).toHaveBeenCalledTimes(2);
      expect(firstCloseAsync).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 1).definitionProviders?.[0]).toMatchObject({
        providerPackageName: '@owner/provider-package',
        definition: { id: 'late-provider', name: 'Late Provider' },
        auth: adapterProviderAuth,
      });
    } finally {
      offCatalog();
      warnSpy.mockRestore();
    }
  });

  it('publishes refreshed provider metadata when provider activation restart close fails', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['late-live-failing-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    const loadedProviderIds = new Set<string>();
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: loadedProviderIds }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const providers: ProviderDefinitionInput[] = [];
    const closeAsync = vi.fn(async (): Promise<ConnectorTeardownResult> => {
      throw new Error('close failed');
    });
    const factory = createRestartTrackingFactory(closeAsync, 'closeAsync');
    const registeredEvents: Array<{ adapterName: string; initialized: boolean }> = [];
    const offRegistered = MakaioBus.on(AdapterSubsystemSubjects.adapter.registered, (ctx) => {
      registeredEvents.push({ adapterName: ctx.payload.adapterName, initialized: ctx.payload.initialized });
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('late-live-failing-adapter', factory, [{ definitionId: 'late-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      loadedProviderIds.add('late-provider');
      providers.push({ id: 'late-provider', name: 'Late Provider', authMethods: [], availableModels: [] });

      await service.processAdapterContributions(
        '@owner/provider-package',
        createExtension('@owner/provider-package', [], providers),
        TEST_EXTENSION_CONTEXT,
      );

      expect(closeAsync).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
      expect(service.getAdapterInstances().size).toBe(0);
      expect(service.getLoadedAdapters()[0]?.providers[0]?.definition.id).toBe('late-provider');
      expect(registeredEvents.at(-1)).toEqual({
        adapterName: 'late-live-failing-adapter',
        initialized: false,
      });
    } finally {
      offRegistered();
      offCatalog();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('restarts live adapters after an active provider package stops', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['removed-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['runtime-provider']) }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const close = vi.fn().mockResolvedValue({ evidence: 'released' });
    const factory = createRestartTrackingFactory(close, 'close');
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-package',
            definition: ProviderDefinitionSchema.parse({
              id: 'runtime-provider',
              name: 'Runtime Provider',
              authMethods: [],
              availableModels: [],
            }),
          },
        ],
        clients: [],
      });
    });

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('removed-provider-adapter', factory, [{ definitionId: 'runtime-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(factory).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 0).definitionProviders?.[0]?.definition.id).toBe('runtime-provider');

      await service.stopAdapterContributions('@owner/provider-package');

      expect(factory).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 1).definitionProviders).toEqual([]);
      expect(service.getLoadedAdapters()[0]?.providers).toEqual([]);
    } finally {
      offCatalog();
    }
  });

  it('keeps the latest provider-stop epoch deferred across a timed-out close', async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['deferred-provider-stop-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['provider-one', 'provider-two']) }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const releaseClose = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const replacementFactoryStarted = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const closeAsync = vi.fn(async () => {
      closeStarted.resolve();
      await releaseClose.promise;
      return { evidence: 'released' as const };
    });
    const factory = vi.fn(async (options?: unknown) => {
      const adapterId = readAdapterFactoryOptions(options).adapterId;
      if (factory.mock.calls.length === 1) return { adapterId, closeAsync };
      if (factory.mock.calls.length === 2) {
        replacementFactoryStarted.resolve();
        await releaseReplacementFactory.promise;
      }
      return { adapterId };
    });
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/provider-one',
            definition: ProviderDefinitionSchema.parse({
              id: 'provider-one',
              name: 'Provider One',
              authMethods: [],
              availableModels: [],
            }),
          },
          {
            packageName: '@owner/provider-two',
            definition: ProviderDefinitionSchema.parse({
              id: 'provider-two',
              name: 'Provider Two',
              authMethods: [],
              availableModels: [],
            }),
          },
        ],
        clients: [],
      });
    });

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('deferred-provider-stop-adapter', factory, [
            { definitionId: 'provider-one' },
            { definitionId: 'provider-two' },
          ]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const firstProviderStop = service.stopAdapterContributions('@owner/provider-one');
      await closeStarted.promise;
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await firstProviderStop;

      releaseClose.resolve();
      await replacementFactoryStarted.promise;
      await service.stopAdapterContributions('@owner/provider-two');
      expect(factory).toHaveBeenCalledTimes(2);

      releaseReplacementFactory.resolve();
      await vi.runAllTimersAsync();

      expect(factory).toHaveBeenCalledTimes(3);
      expect(getFactoryInitOptions(factory, 2).definitionProviders).toEqual([]);
      expect(service.getAdapterInstances().size).toBe(1);
    } finally {
      offCatalog();
      vi.useRealTimers();
    }
  });

  it('retains adapter package state when adapter close rejects during stop until retry succeeds', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['rejecting-close-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
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

    let shouldFailClose = true;
    const closeAsync = vi.fn(async (): Promise<ConnectorTeardownResult> => {
      if (shouldFailClose) {
        throw new Error('close failed');
      }
      return { evidence: 'released' };
    });
    const factory = createRestartTrackingFactory(closeAsync, 'closeAsync');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [createContribution('rejecting-close-adapter', factory)]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getLoadedAdapters()).toHaveLength(1);
      expect(service.getAdapterInstances().size).toBe(1);

      await service.stopAdapterContributions('@owner/adapter-package');

      expect(closeAsync).toHaveBeenCalledOnce();
      expect(service.getLoadedAdapters()).toHaveLength(1);
      expect(service.getAdapterInstances().size).toBe(0);

      shouldFailClose = false;
      await service.stopAdapterContributions('@owner/adapter-package');

      expect(closeAsync).toHaveBeenCalledTimes(2);
      expect(service.getLoadedAdapters()).toEqual([]);
      expect(service.getAdapterInstances().size).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retains stale provider-package instance when adapter close hangs instead of starting a duplicate', async () => {
    let offCatalog: (() => void) | undefined;
    let offRegistered: (() => void) | undefined;
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      vi.useFakeTimers();
      const repository = new MemoryRepository(
        new Map(),
        new Map<string, AdapterFile>([
          ['hanging-close-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
        ]),
      );
      service = new AdapterSubsystemService({
        bus: MakaioBus,
        configRepository: repository,
        coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['runtime-provider']) }),
        machineId: TEST_MACHINE_ID,
        platformDefaults: TEST_PLATFORM_DEFAULTS,
      });
      await service.init();

      const releaseClose = Promise.withResolvers<void>();
      const hangingCloseAsync = vi.fn(async () => {
        await releaseClose.promise;
      });
      const factory = createRestartTrackingFactory(hangingCloseAsync, 'closeAsync');
      const hangingCloseRegisteredEvents: Array<{ adapterName: string; initialized: boolean }> = [];
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      offRegistered = MakaioBus.on(AdapterSubsystemSubjects.adapter.registered, (ctx) => {
        hangingCloseRegisteredEvents.push({
          adapterName: ctx.payload.adapterName,
          initialized: ctx.payload.initialized,
        });
      });
      offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
        ctx.setResult({
          providers: [
            {
              packageName: '@owner/provider-package',
              definition: ProviderDefinitionSchema.parse({
                id: 'runtime-provider',
                name: 'Runtime Provider',
                authMethods: [],
                availableModels: [],
              }),
            },
          ],
          clients: [],
        });
      });

      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('hanging-close-adapter', factory, [{ definitionId: 'runtime-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const stopPromise = service.stopAdapterContributions('@owner/provider-package');
      await vi.waitFor(() => expect(hangingCloseAsync).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await stopPromise;

      expect(factory).toHaveBeenCalledOnce();
      expect(service.getAdapterInstances().size).toBe(0);
      expect(service.getLoadedAdapters()[0]?.providers).toEqual([]);
      expect(hangingCloseRegisteredEvents.at(-1)).toEqual({
        adapterName: 'hanging-close-adapter',
        initialized: false,
      });
      releaseClose.resolve();
      await vi.runAllTimersAsync();
    } finally {
      offCatalog?.();
      offRegistered?.();
      errorSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it('initializes deferred adapters when pending provider extensions stop being activation-eligible', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['optional-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    const loadedProviderIds = new Set(['late-provider']);
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: loadedProviderIds }),
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
          createContribution('optional-provider-adapter', factory, [{ definitionId: 'late-provider' }]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(0);
      expect(factory).not.toHaveBeenCalled();

      loadedProviderIds.delete('late-provider');

      await service.processAdapterContributions(
        '@owner/unrelated-provider-package',
        createExtension(
          '@owner/unrelated-provider-package',
          [],
          [{ id: 'unrelated-provider', name: 'Unrelated Provider', authMethods: [], availableModels: [] }],
        ),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 0).definitionProviders).toEqual([]);
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
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['activating-provider']) }),
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
          [{ id: 'activating-provider', name: 'Activating Provider', authMethods: [], availableModels: [] }],
        ),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
      expect(getFactoryInitOptions(factory, 0).definitionProviders?.[0]).toMatchObject({
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
      coordinator: createStubCoordinator({ loadedProviderDefinitionIds: new Set(['late-provider']) }),
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

      providers.push({ id: 'late-provider', name: 'Late Provider', authMethods: [], availableModels: [] });

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

  it('initializes immediately when unresolved provider IDs belong to uninstalled extensions', async () => {
    const repository = new MemoryRepository(
      new Map(),
      new Map<string, AdapterFile>([
        ['multi-provider-adapter', { $schema: 'makaio/adapter-config/v1', enabled: true }],
      ]),
    );
    service = new AdapterSubsystemService({
      bus: MakaioBus,
      configRepository: repository,
      coordinator: createStubCoordinator({
        loadedProviderDefinitionIds: new Set(['installed-provider']),
      }),
      machineId: TEST_MACHINE_ID,
      platformDefaults: TEST_PLATFORM_DEFAULTS,
    });
    await service.init();

    const factory = vi.fn(async (options?: unknown) => ({
      adapterId: readAdapterFactoryOptions(options).adapterId,
    }));
    const offCatalog = MakaioBus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      ctx.setResult({
        providers: [
          {
            packageName: '@owner/installed-provider-package',
            definition: ProviderDefinitionSchema.parse({
              id: 'installed-provider',
              name: 'Installed Provider',
              authMethods: [],
              availableModels: [],
            }),
          },
        ],
        clients: [],
      });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await service.processAdapterContributions(
        '@owner/adapter-package',
        createExtension('@owner/adapter-package', [
          createContribution('multi-provider-adapter', factory, [
            { definitionId: 'installed-provider' },
            { definitionId: 'uninstalled-provider' },
          ]),
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      expect(service.getAdapterInstances().size).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      offCatalog();
      warnSpy.mockRestore();
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

  it('applies the adapter-level provider config schema and preserves per-provider overrides', async () => {
    const adapterLevelConfigSchema = z.object({ baseUrl: z.string().url() });
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
            definition: {
              id: 'default-schema-provider',
              name: 'Default Schema Provider',
              authMethods: [],
              availableModels: [],
            },
          },
          {
            packageName: '@owner/provider-package',
            definition: {
              id: 'override-schema-provider',
              name: 'Override Schema Provider',
              authMethods: [],
              availableModels: [],
            },
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
            },
          },
        ]),
        TEST_EXTENSION_CONTEXT,
      );

      const [defaultProvider, overrideProvider] = service.getLoadedAdapters()[0]?.providers ?? [];
      expect(defaultProvider?.configSchema).toBe(adapterLevelConfigSchema);
      expect(overrideProvider?.configSchema).toBe(providerOverrideConfigSchema);
    } finally {
      offCatalog();
    }
  });

  it('passes the runtime bus as globalBus to the adapter factory', async () => {
    const adapterId = buildDeterministicAdapterId(TEST_MACHINE_ID, 'bus-check-adapter');
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    let capturedGlobalBus: unknown;
    let capturedOwnerInstanceId: unknown;
    const offGetConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'bus-check-adapter', enabled: true, bindings: [] } });
    });

    try {
      const adapter: LoadedAdapter = {
        ...createLoadedAdapter('bus-check-adapter', '@owner/bus-check-package'),
        factory: async (options?: unknown) => {
          const opts = options as Record<string, unknown>;
          capturedGlobalBus = opts.globalBus;
          capturedOwnerInstanceId = opts.ownerInstanceId;
          return { adapterId: readAdapterFactoryOptions(options).adapterId };
        },
        options: { adapterId },
      };
      registry.registerAdapter(adapter, '@owner/bus-check-package');
      await registry.initializeAdapter(adapter, TEST_PLATFORM_DEFAULTS);

      expect(capturedGlobalBus).toBe(MakaioBus);
      expect(capturedOwnerInstanceId).toBe('test-owner-instance');
    } finally {
      offGetConfig();
    }
  });

  it('rolls back a registry-owned instance when adapter.initialized emission fails', async () => {
    const adapterId = buildDeterministicAdapterId(TEST_MACHINE_ID, 'event-failing-adapter');
    const shutdown = vi.fn().mockResolvedValue({ evidence: 'released' });
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const offGetConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'event-failing-adapter', enabled: true, bindings: [] } });
    });
    const offInitialized = MakaioBus.on(AdapterSubjects.initialized, () => {
      throw new Error('Injected initialized emit failure');
    });

    try {
      const adapter: LoadedAdapter = {
        ...createLoadedAdapter('event-failing-adapter', '@owner/event-failing-package'),
        factory: async (options?: unknown) => ({ adapterId: readAdapterFactoryOptions(options).adapterId, shutdown }),
        options: { adapterId },
      };
      registry.registerAdapter(adapter, '@owner/event-failing-package');
      await expect(registry.initializeAdapter(adapter, TEST_PLATFORM_DEFAULTS)).rejects.toThrow(
        /event-failing-adapter: Injected initialized emit failure/,
      );

      expect(registry.getAdapterInstances()).toEqual(new Map());
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      offInitialized();
      offGetConfig();
    }
  });

  it('keeps a weak failed-initialization rollback retiring until a later retry observes teardown', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('weak-initialization-rollback', '@owner/weak-initialization-rollback');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const closeAsync = vi
      .fn<() => Promise<ConnectorTeardownResult>>()
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'first close is unproven' })
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'retry is still unproven' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const factory = vi.fn(async () => ({ adapterId, closeAsync }));
    const rollbackAdapter = { ...adapter, factory };
    let rejectInitialized = true;
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: rollbackAdapter.name, enabled: true, bindings: [] } });
    });
    const offInitialized = MakaioBus.on(AdapterSubjects.initialized, () => {
      if (rejectInitialized) throw new Error('initialized publication failed');
    });

    try {
      registry.registerAdapter(rollbackAdapter, '@owner/weak-initialization-rollback');
      await expect(registry.initializeAdapter(rollbackAdapter, TEST_PLATFORM_DEFAULTS)).rejects.toThrow(
        /initialized publication failed/,
      );
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
      expect(registry.getAdapterInstances()).toEqual(new Map());

      rejectInitialized = false;
      await registry.initializeAdapter(rollbackAdapter, TEST_PLATFORM_DEFAULTS);
      expect(closeAsync).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenCalledOnce();

      await registry.initializeAdapter(rollbackAdapter, TEST_PLATFORM_DEFAULTS);
      expect(closeAsync).toHaveBeenCalledTimes(3);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(registry.resolveLiveAdapterId(rollbackAdapter.name)).toBe(adapterId);
    } finally {
      offInitialized();
      offConfig();
    }
  });

  it('waits for a timed-out close hook to self-publish before choosing a deinitialization fallback', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('late-self-publishing-close', '@owner/late-self-publishing-close');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseClose = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const withdrawn = vi.fn();
    const closeAsync = vi.fn(async () => {
      if (closeAsync.mock.calls.length > 1) return { evidence: 'released' as const };
      closeStarted.resolve();
      await releaseClose.promise;
      await MakaioBus.emit(AdapterSubjects.deinitialized, {
        adapterId,
        adapterName: adapter.name,
        machineId: TEST_MACHINE_ID,
        ownerInstanceId: 'test-owner-instance',
      });
      return { evidence: 'released' as const };
    });
    const factory = vi.fn(async () => ({ adapterId, closeAsync }));
    const lateSelfPublishingAdapter: LoadedAdapter = {
      ...adapter,
      factory,
    };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    const offDeinitialized = MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    try {
      registry.registerAdapter(lateSelfPublishingAdapter, '@owner/late-self-publishing-close');
      await registry.initializeAdapter(lateSelfPublishingAdapter, TEST_PLATFORM_DEFAULTS);

      const restart = registry.restartAdapterInstance(lateSelfPublishingAdapter, TEST_PLATFORM_DEFAULTS);
      await closeStarted.promise;
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await restart;

      expect(withdrawn).not.toHaveBeenCalled();
      expect(registry.getAdapterInstances()).toEqual(new Map());

      releaseClose.resolve();
      await vi.runAllTimersAsync();

      expect(withdrawn).toHaveBeenCalledOnce();
      expect(withdrawn).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ adapterId, adapterName: adapter.name }),
        }),
      );
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(registry.resolveLiveAdapterId(adapter.name)).toBe(adapterId);
    } finally {
      offDeinitialized();
      offConfig();
      vi.useRealTimers();
    }
  });

  it('removes a late-released deregistration before admitting a replacement without a second close', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('late-released-deregistration', '@owner/late-released-deregistration');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseClose = Promise.withResolvers<void>();
    const closeAsync = vi.fn(async () => {
      await releaseClose.promise;
      return { evidence: 'released' as const };
    });
    const factory = vi.fn(async () => ({ adapterId, ...(factory.mock.calls.length === 1 ? { closeAsync } : {}) }));
    const deregisteredAdapter = { ...adapter, factory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(deregisteredAdapter, '@owner/late-released-deregistration');
      await registry.initializeAdapter(deregisteredAdapter, TEST_PLATFORM_DEFAULTS);
      const deregister = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await deregister;
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(registry.getLoadedAdapters()).toEqual([deregisteredAdapter]);

      releaseClose.resolve();
      await vi.runAllTimersAsync();
      expect(registry.getLoadedAdapters()).toEqual([]);

      registry.registerAdapter(deregisteredAdapter, '@owner/late-released-deregistration');
      await registry.initializeAdapter(deregisteredAdapter, TEST_PLATFORM_DEFAULTS);
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(registry.resolveLiveAdapterId(adapter.name)).toBe(adapterId);
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('activates an exact replacement registered during a pending retirement flight', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('pending-flight-replacement', '@owner/pending-flight-replacement');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseClose = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseClose.promise;
      return { evidence: 'released' as const };
    });
    const oldFactory = vi.fn(async () => ({ adapterId, closeAsync: oldClose }));
    const replacementFactory = vi.fn(async () => ({ adapterId }));
    const oldAdapter = { ...adapter, factory: oldFactory };
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, '@owner/pending-flight-replacement');
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const deregister = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await deregister;

      registry.registerAdapter(replacementAdapter, '@owner/pending-flight-replacement');
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      expect(oldClose).toHaveBeenCalledOnce();
      expect(replacementFactory).not.toHaveBeenCalled();

      releaseClose.resolve();
      await vi.runAllTimersAsync();

      expect(oldClose).toHaveBeenCalledOnce();
      expect(replacementFactory).toHaveBeenCalledOnce();
      expect(registry.resolveLiveAdapterIdentity(adapterId)).toEqual({
        adapterId,
        adapterName: adapter.name,
        machineId: TEST_MACHINE_ID,
        ownerInstanceId: 'test-owner-instance',
      });
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('keeps a current replacement deferred when the older restart later times out', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('stale-restart-replacement', '@owner/stale-restart-replacement');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseOldClose = Promise.withResolvers<void>();
    const oldCloseStarted = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      oldCloseStarted.resolve();
      await releaseOldClose.promise;
      return { evidence: 'released' as const };
    });
    const oldFactory = vi.fn(async () => ({ adapterId, closeAsync: oldClose }));
    const replacementFactory = vi.fn(async () => ({
      adapterId,
      closeAsync: async () => ({ evidence: 'released' as const }),
    }));
    const oldAdapter = { ...adapter, factory: oldFactory };
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);

      const restartOldAdapter = registry.restartAdapterInstance(oldAdapter, TEST_PLATFORM_DEFAULTS);
      await oldCloseStarted.promise;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      expect(replacementFactory).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await restartOldAdapter;
      releaseOldClose.resolve();
      await vi.runAllTimersAsync();

      expect(oldFactory).toHaveBeenCalledOnce();
      expect(replacementFactory).toHaveBeenCalledOnce();
      expect(registry.resolveLiveAdapterIdentity(adapterId)).toEqual({
        adapterId,
        adapterName: adapter.name,
        machineId: TEST_MACHINE_ID,
        ownerInstanceId: 'test-owner-instance',
      });

      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('coalesces a public restart while the exact deferred replacement factory is active', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('coalesced-deferred-replacement', '@owner/coalesced-deferred-replacement');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseOldClose = Promise.withResolvers<void>();
    const replacementFactoryStarted = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseOldClose.promise;
      return { evidence: 'released' as const };
    });
    const replacementClose = vi.fn(async () => ({ evidence: 'released' as const }));
    const oldAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync: oldClose }) };
    const replacementFactory = vi.fn(async () => {
      replacementFactoryStarted.resolve();
      await releaseReplacementFactory.promise;
      return { adapterId, closeAsync: replacementClose };
    });
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const initialized = vi.fn();
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    const offInitialized = MakaioBus.on(AdapterSubjects.initialized, initialized);

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      initialized.mockClear();

      const deregister = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await deregister;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await replacementFactoryStarted.promise;

      const concurrentRestart = registry.restartAdapterInstance(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      await Promise.resolve();
      expect(oldClose).toHaveBeenCalledOnce();
      expect(replacementFactory).toHaveBeenCalledOnce();

      releaseReplacementFactory.resolve();
      await concurrentRestart;

      expect(replacementFactory).toHaveBeenCalledOnce();
      expect(initialized).toHaveBeenCalledOnce();
      expect(registry.resolveLiveAdapterIdentity(adapterId)).toEqual({
        adapterId,
        adapterName: adapter.name,
        machineId: TEST_MACHINE_ID,
        ownerInstanceId: 'test-owner-instance',
      });

      await registry.deregisterAdapter(adapter.name);
      expect(replacementClose).toHaveBeenCalledOnce();
      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offInitialized();
      offConfig();
      vi.useRealTimers();
    }
  });

  it('joins public admissions for a successor waiting behind a gated deferred factory', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('waiting-successor-coalescing', '@owner/waiting-successor-coalescing');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const provider: LoadedAdapter['providers'][number] = {
      definition: ProviderDefinitionSchema.parse({
        id: 'waiting-successor-provider',
        name: 'Waiting Successor Provider',
        authMethods: [],
        availableModels: [],
      }),
      providerPackageName: '@owner/waiting-successor-provider',
    };
    const releaseOldClose = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const replacementFactoryStarted = Promise.withResolvers<void>();
    const releaseRollbackClose = Promise.withResolvers<void>();
    const rollbackCloseStarted = Promise.withResolvers<void>();
    const releaseFinalFactory = Promise.withResolvers<void>();
    const finalFactoryStarted = Promise.withResolvers<void>();
    const oldAdapter = {
      ...adapter,
      providers: [provider],
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          await releaseOldClose.promise;
          return { evidence: 'released' as const };
        },
      }),
    };
    const replacementFactory = vi.fn(async (options?: unknown) => {
      if (replacementFactory.mock.calls.length === 1) {
        replacementFactoryStarted.resolve();
        await releaseReplacementFactory.promise;
        return {
          adapterId: readAdapterFactoryOptions(options).adapterId,
          closeAsync: async () => {
            rollbackCloseStarted.resolve();
            await releaseRollbackClose.promise;
            return { evidence: 'released' as const };
          },
        };
      }
      finalFactoryStarted.resolve();
      await releaseFinalFactory.promise;
      return { adapterId: readAdapterFactoryOptions(options).adapterId };
    });
    const replacementAdapter = { ...adapter, providers: [provider], factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const deregister = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await deregister;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await replacementFactoryStarted.promise;

      const [successor] = await registry.removeProviderPackage(
        '@owner/waiting-successor-provider',
        TEST_PLATFORM_DEFAULTS,
      );
      if (successor === undefined) throw new Error('Provider stop did not produce a successor adapter epoch');
      const publicInitialize = registry.initializeAdapter(successor, TEST_PLATFORM_DEFAULTS);
      const publicRestart = registry.restartAdapterInstance(successor, TEST_PLATFORM_DEFAULTS);
      await Promise.resolve();
      expect(replacementFactory).toHaveBeenCalledOnce();

      releaseReplacementFactory.resolve();
      await rollbackCloseStarted.promise;
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      expect(replacementFactory).toHaveBeenCalledOnce();
      releaseRollbackClose.resolve();
      await finalFactoryStarted.promise;
      let deregistrationSettled = false;
      const deregistration = registry.deregisterAdapter(successor.name).then(() => {
        deregistrationSettled = true;
      });
      await Promise.resolve();
      expect(deregistrationSettled).toBe(false);
      releaseFinalFactory.resolve();
      await vi.runAllTimersAsync();
      await deregistration;
      await Promise.all([publicInitialize, publicRestart]);

      expect(replacementFactory).toHaveBeenCalledTimes(2);
      expect(getFactoryInitOptions(replacementFactory, 1).definitionProviders).toEqual([]);
      expect(registry.resolveLiveAdapterId(adapter.name)).toBeUndefined();
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('keeps a stopped waiting successor tracked until its predecessor rollback can be retried', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('stopped-waiting-successor', '@owner/stopped-waiting-successor');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const provider: LoadedAdapter['providers'][number] = {
      definition: ProviderDefinitionSchema.parse({
        id: 'stopped-waiting-successor-provider',
        name: 'Stopped Waiting Successor Provider',
        authMethods: [],
        availableModels: [],
      }),
      providerPackageName: '@owner/stopped-waiting-successor-provider',
    };
    const releaseOldClose = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const replacementFactoryStarted = Promise.withResolvers<void>();
    const replacementClose = vi
      .fn<() => Promise<ConnectorTeardownResult>>()
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'stale rollback remains unobserved' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const oldAdapter = {
      ...adapter,
      providers: [provider],
      factory: async () => ({
        adapterId,
        closeAsync: async () => {
          await releaseOldClose.promise;
          return { evidence: 'released' as const };
        },
      }),
    };
    const replacementAdapter = {
      ...adapter,
      providers: [provider],
      factory: async () => {
        replacementFactoryStarted.resolve();
        await releaseReplacementFactory.promise;
        return { adapterId, closeAsync: replacementClose };
      },
    };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const deregister = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await deregister;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await replacementFactoryStarted.promise;

      const [successor] = await registry.removeProviderPackage(
        '@owner/stopped-waiting-successor-provider',
        TEST_PLATFORM_DEFAULTS,
      );
      if (successor === undefined) throw new Error('Provider stop did not produce a successor adapter epoch');
      let successorStopSettled = false;
      const successorStop = registry.deregisterAdapter(successor.name).then(() => {
        successorStopSettled = true;
      });
      await Promise.resolve();
      expect(successorStopSettled).toBe(false);

      releaseReplacementFactory.resolve();
      await successorStop;

      expect(replacementClose).toHaveBeenCalledOnce();
      expect(registry.getLoadedAdapters()).toEqual([successor]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });
      expect(replacementClose).toHaveBeenCalledTimes(2);
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('cancels a replacement stopped before its blocking retirement flight settles', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('cancelled-pending-replacement', '@owner/cancelled-pending-replacement');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseClose = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseClose.promise;
      return { evidence: 'released' as const };
    });
    const oldAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync: oldClose }) };
    const replacementFactory = vi.fn(async () => ({ adapterId }));
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const firstStop = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await firstStop;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      let replacementStopSettled = false;
      const replacementStop = registry.deregisterAdapter(adapter.name).then(() => {
        replacementStopSettled = true;
      });
      await Promise.resolve();
      expect(replacementStopSettled).toBe(false);

      releaseClose.resolve();
      await vi.runAllTimersAsync();
      await replacementStop;

      expect(replacementFactory).not.toHaveBeenCalled();
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('keeps cancellation and shutdown bounded when an ordinary deferred close never settles', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('never-settling-deferred-close', '@owner/never-settling-deferred-close');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const closeAsync = vi.fn(() => new Promise<void>(() => {}));
    const factory = vi.fn(async () => ({ adapterId, closeAsync }));
    const deferredAdapter = { ...adapter, factory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(deferredAdapter, adapter.packageName);
      await registry.initializeAdapter(deferredAdapter, TEST_PLATFORM_DEFAULTS);
      const restart = registry.restartAdapterInstance(deferredAdapter, TEST_PLATFORM_DEFAULTS);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await restart;

      await registry.deregisterAdapter(adapter.name);
      expect(factory).toHaveBeenCalledOnce();
      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'unknown' });
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('keeps a stopped in-flight replacement rollback retryable after weak teardown', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('stopped-in-flight-replacement', '@owner/stopped-in-flight-replacement');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseOldClose = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseOldClose.promise;
      return { evidence: 'released' as const };
    });
    const replacementClose = vi
      .fn<() => Promise<ConnectorTeardownResult>>()
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'rollback remains unobserved' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const replacementFactory = vi.fn(async () => {
      await releaseReplacementFactory.promise;
      return { adapterId, closeAsync: replacementClose };
    });
    const oldAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync: oldClose }) };
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const firstStop = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await firstStop;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacementFactory).toHaveBeenCalledOnce();

      const secondStop = registry.deregisterAdapter(adapter.name);
      releaseReplacementFactory.resolve();
      await secondStop;

      expect(registry.getAdapterInstances()).toEqual(new Map());
      expect(registry.getLoadedAdapters()).toEqual([replacementAdapter]);
      expect(replacementClose).toHaveBeenCalledOnce();
      await expect(registry.shutdownAll()).resolves.toMatchObject({ evidence: 'released' });
      expect(replacementClose).toHaveBeenCalledTimes(2);
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('cleans a stopped replacement after its timed-out rollback later proves release', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('late-released-replacement-rollback', '@owner/late-released-rollback');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseOldClose = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const releaseRollbackClose = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseOldClose.promise;
      return { evidence: 'released' as const };
    });
    const rollbackClose = vi.fn(async () => {
      await releaseRollbackClose.promise;
      return { evidence: 'released' as const };
    });
    const replacementFactory = vi.fn(async () => {
      await releaseReplacementFactory.promise;
      return { adapterId, closeAsync: rollbackClose };
    });
    const oldAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync: oldClose }) };
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const firstStop = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await firstStop;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacementFactory).toHaveBeenCalledOnce();

      const secondStop = registry.deregisterAdapter(adapter.name);
      releaseReplacementFactory.resolve();
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await secondStop;
      expect(registry.getLoadedAdapters()).toEqual([replacementAdapter]);

      releaseRollbackClose.resolve();
      await vi.runAllTimersAsync();
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(rollbackClose).toHaveBeenCalledOnce();

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      expect(replacementFactory).toHaveBeenCalledTimes(2);
      expect(registry.resolveLiveAdapterId(adapter.name)).toBe(adapterId);
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('joins a started deferred factory before host shutdown retires its rollback slot', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('shutdown-deferred-factory', '@owner/shutdown-deferred-factory');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseOldClose = Promise.withResolvers<void>();
    const releaseReplacementFactory = Promise.withResolvers<void>();
    const oldClose = vi.fn(async () => {
      await releaseOldClose.promise;
      return { evidence: 'released' as const };
    });
    const replacementClose = vi
      .fn<() => Promise<ConnectorTeardownResult>>()
      .mockResolvedValueOnce({ evidence: 'unknown', detail: 'shutdown must retry the rollback handle' })
      .mockResolvedValueOnce({ evidence: 'released' });
    const replacementFactory = vi.fn(async () => {
      await releaseReplacementFactory.promise;
      return { adapterId, closeAsync: replacementClose };
    });
    const oldAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync: oldClose }) };
    const replacementAdapter = { ...adapter, factory: replacementFactory };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });

    try {
      registry.registerAdapter(oldAdapter, adapter.packageName);
      await registry.initializeAdapter(oldAdapter, TEST_PLATFORM_DEFAULTS);
      const firstStop = registry.deregisterAdapter(adapter.name);
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await firstStop;

      registry.registerAdapter(replacementAdapter, adapter.packageName);
      await registry.initializeAdapter(replacementAdapter, TEST_PLATFORM_DEFAULTS);
      releaseOldClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacementFactory).toHaveBeenCalledOnce();

      let shutdownSettled = false;
      const shutdown = registry.shutdownAll().then((report) => {
        shutdownSettled = true;
        return report;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      releaseReplacementFactory.resolve();
      await expect(shutdown).resolves.toMatchObject({ evidence: 'released' });
      expect(replacementClose).toHaveBeenCalledTimes(2);
      expect(registry.getLoadedAdapters()).toEqual([]);
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offConfig();
      vi.useRealTimers();
    }
  });

  it('withdraws an early observed initialized identity exactly once when a later initialized subscriber rejects', async () => {
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('partially-published-initialization', '@owner/partially-published');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const identitySnapshots: unknown[] = [];
    const deinitialized = vi.fn();
    const rejectingAdapter = {
      ...adapter,
      factory: async () => ({ adapterId, closeAsync: async () => ({ evidence: 'released' as const }) }),
    };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    const offEarlyInitialized = MakaioBus.on(AdapterSubjects.initialized, () => {
      identitySnapshots.push(registry.resolveLiveAdapterIdentity(adapterId));
    });
    const offRejectingInitialized = MakaioBus.on(AdapterSubjects.initialized, () => {
      throw new Error('late initialized subscriber rejected');
    });
    const offDeinitialized = MakaioBus.on(AdapterSubjects.deinitialized, deinitialized);

    try {
      registry.registerAdapter(rejectingAdapter, '@owner/partially-published');
      await expect(registry.initializeAdapter(rejectingAdapter, TEST_PLATFORM_DEFAULTS)).rejects.toThrow(
        /late initialized subscriber rejected/,
      );

      expect(identitySnapshots).toEqual([
        { adapterId, adapterName: adapter.name, machineId: TEST_MACHINE_ID, ownerInstanceId: 'test-owner-instance' },
      ]);
      expect(deinitialized).toHaveBeenCalledOnce();
      expect(registry.resolveLiveAdapterIdentity(adapterId)).toBeUndefined();
      expect(registry.getAdapterInstances()).toEqual(new Map());
    } finally {
      offDeinitialized();
      offRejectingInitialized();
      offEarlyInitialized();
      offConfig();
    }
  });

  it('does not overlap a timed-out shutdown close and publishes one eventual fallback', async () => {
    vi.useFakeTimers();
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const adapter = createLoadedAdapter('timed-out-shutdown', '@owner/timed-out-shutdown');
    const adapterId = registry.resolveLoadedAdapterId(adapter);
    const releaseClose = Promise.withResolvers<void>();
    const closeAsync = vi.fn(async () => {
      await releaseClose.promise;
      return { evidence: 'released' as const };
    });
    const withdrawn = vi.fn();
    const shutdownAdapter = { ...adapter, factory: async () => ({ adapterId, closeAsync }) };
    const offConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: adapter.name, enabled: true, bindings: [] } });
    });
    const offDeinitialized = MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    try {
      registry.registerAdapter(shutdownAdapter, '@owner/timed-out-shutdown');
      await registry.initializeAdapter(shutdownAdapter, TEST_PLATFORM_DEFAULTS);
      const shutdown = registry.shutdownAll();
      await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
      await expect(shutdown).resolves.toMatchObject({ evidence: 'unknown' });
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(withdrawn).not.toHaveBeenCalled();

      releaseClose.resolve();
      await vi.runAllTimersAsync();
      expect(closeAsync).toHaveBeenCalledOnce();
      expect(withdrawn).toHaveBeenCalledOnce();
    } finally {
      offDeinitialized();
      offConfig();
      vi.useRealTimers();
    }
  });

  it('retires a registry-owned instance without withdrawal when adapterId validation fails', async () => {
    const adapterId = buildDeterministicAdapterId(TEST_MACHINE_ID, 'mismatch-adapter');
    const shutdown = vi.fn().mockResolvedValue({ evidence: 'released' });
    const registry = new AdapterRuntimeRegistry({
      bus: MakaioBus,
      machineId: TEST_MACHINE_ID,
      resolveOwnerInstanceId: () => 'test-owner-instance',
    });
    const deinitialized = vi.fn();
    const offGetConfig = MakaioBus.on(AdapterSubsystemSubjects.getAdapterConfig, (ctx) => {
      ctx.setResult({ config: { name: 'mismatch-adapter', enabled: true, bindings: [] } });
    });

    const offDeinitialized = MakaioBus.on(AdapterSubjects.deinitialized, deinitialized);
    try {
      const adapter: LoadedAdapter = {
        ...createLoadedAdapter('mismatch-adapter', '@owner/mismatch-package'),
        factory: async () => ({ adapterId: 'wrong-adapter-id', shutdown }),
        options: { adapterId },
      };
      registry.registerAdapter(adapter, '@owner/mismatch-package');
      await expect(registry.initializeAdapter(adapter, TEST_PLATFORM_DEFAULTS)).rejects.toThrow(
        /mismatch-adapter: Adapter 'mismatch-adapter' initialized with mismatched adapterId/,
      );

      expect(registry.getAdapterInstances()).toEqual(new Map());
      expect(shutdown).toHaveBeenCalledOnce();
      expect(deinitialized).not.toHaveBeenCalled();
    } finally {
      offDeinitialized();
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
              authMethods: [],
              defaultApprovalPolicy: 'always-ask',
            }),
          },
          {
            packageName: '@owner/client-package',
            definition: createClientDefinition({
              id: 'claude-code-nightly',
              name: 'Claude Code Nightly',
              version: '2.0.0',
              authMethods: [],
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
              authMethods: [],
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
              authMethods: [],
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
              authMethods: [],
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
              authMethods: [],
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
