import { describe, expect, it } from 'vitest';
import { AIAdapter, createAdapterNamespace, type AIAdapterRuntimeInitOptions } from '@makaio/ai-adapters-core';
import { createBusInstance, type ScopedBus } from '@makaio/bus-core';
import { hasNamespace, NamespaceOwnershipError } from '@makaio/bus-core/kernel-api';
import { dep } from '@makaio/contracts';
import { ADAPTER_FILE_SCHEMA_VERSION, type AdapterFile } from '@makaio/contracts/config';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import {
  AdapterSubsystemService,
  AdapterSubsystemToken,
  createAdapterSubsystemContributionProcessor,
} from '@makaio/subsystem-adapter';
import { DEFAULT_TIMEOUTS } from '@makaio/utils';
import { z } from 'zod';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

const namespace = createAdapterNamespace('adapter:namespace-test', { chunk: z.object({ content: z.string() }) });

/** A real adapter lifecycle with no provider, agents, or external I/O. */
class LifecycleAdapter extends AIAdapter<ScopedBus<string>, never, never> {
  /**
   * Bind the fixture adapter to the bus and runtime identity supplied by the subsystem.
   * @param name - Adapter name in the subsystem registry.
   * @param options - Runtime options provided before initialization.
   */
  public constructor(name: string, options: AIAdapterRuntimeInitOptions) {
    /** Reject agent construction, which this lifecycle fixture never requests. */
    const unusedFactory = (): never => {
      throw new Error('This adapter does not create agents');
    };
    super({
      ...options,
      name,
      namespace,
      capabilities: [],
      agentFactory: unusedFactory,
      configFactory: unusedFactory,
      connectorFactory: unusedFactory,
    });
  }
}

/**
 * Contribute one enabled adapter with the shared test namespace.
 * @param name - Name of both the contribution and the extension supplying it.
 * @param initErrors - Original errors from the adapter before the runtime wraps them.
 * @returns Extension with a factory that initializes the real adapter before returning.
 */
function adapterExtension(name: string, initErrors: unknown[]): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '1.0.0',
    critical: true,
    dependencies: [dep(AdapterSubsystemToken.name)],
    adapters: [
      {
        manifest: { name, displayName: name, protocols: ['anthropic'] },
        definition: {
          name,
          providers: [],
          busNamespace: namespace.definition,
          defaultTimeouts: DEFAULT_TIMEOUTS,
          /**
           * Create and initialize the adapter on the supplied bus.
           * @param options - Type-erased factory options supplied by the adapter subsystem.
           * @returns Initialized adapter instance.
           */
          async createAdapter(options: AIAdapterRuntimeInitOptions) {
            const adapter = new LifecycleAdapter(name, options);
            try {
              await adapter.init();
              return adapter;
            } catch (error) {
              initErrors.push(error);
              throw error;
            }
          },
        },
      },
    ],
  };
}

describe('adapter contribution namespace lifetime', () => {
  it('claims before the factory, survives adapter regeneration, rejects another holder, and releases on stop', async () => {
    const initErrors: unknown[] = [];
    const first = adapterExtension('namespace-test', initErrors);
    const second = adapterExtension('conflicting-adapter', initErrors);
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, {
      extensionContextBase: {
        constructContext,
        platform: 'linux',
        homedir: '/tmp',
        makaioHome: '/tmp/.makaio',
        username: 'test',
        machineId: 'namespace-test-machine',
        tryImport: async () => null,
      },
    });
    const configs = new Map<string, AdapterFile>(
      [first.name, second.name].map((name) => [name, { $schema: ADAPTER_FILE_SCHEMA_VERSION, enabled: true }]),
    );
    const subsystem: KernelMakaioExtension = {
      name: AdapterSubsystemToken.name,
      displayName: 'Adapter Subsystem',
      version: '1.0.0',
      critical: true,
      create: (ctx) =>
        new AdapterSubsystemService({
          bus: ctx.bus,
          coordinator,
          configRepository: {
            loadAdapterConfigs: async () => ({ configs }),
            loadProviderConfigs: async () => ({ configs: new Map() }),
            writeAdapterFile: async () => {},
            writeProviderConfig: async () => {},
            deleteAdapterFile: async () => false,
            deleteProviderConfig: async () => false,
          },
          machineId: ctx.machineId,
          platformDefaults: {},
          resolveOwnerInstanceId: () => 'namespace-test-authority',
        }),
    };
    const service = () => coordinator.getExtensionService(AdapterSubsystemToken);
    coordinator.registerContributionProcessor(
      createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: service,
      }),
    );
    coordinator.load([subsystem, first, second]);

    try {
      const failure = await coordinator.startAll().catch((error: unknown) => error);
      const owners = coordinator.namespaceOwners();
      const [initError] = initErrors;
      const diagnostic =
        initError instanceof NamespaceOwnershipError ? `${initError.code}: ${initError.message}` : undefined;
      expect(owners.ownerOf(namespace.name), diagnostic).toEqual({ kind: 'extension', extension: first.name });
      expect(initErrors).toEqual([]);
      expect(failure).toMatchObject({
        code: 'namespace-already-owned',
        namespace: namespace.name,
        owner: { kind: 'extension', extension: first.name },
        requester: { kind: 'extension', extension: second.name },
      });

      const [adapter] = service()?.getAdapterInstances().values() ?? [];
      expect(adapter).toBeInstanceOf(LifecycleAdapter);
      if (!(adapter instanceof LifecycleAdapter)) throw new Error('The first adapter failed to initialize');
      expect(await adapter.closeAsync()).toEqual({ evidence: 'released' });
      expect(hasNamespace(bus, namespace.name)).toBe(true);
      await adapter.init();
      expect(adapter.isInitialized()).toBe(true);
      expect(hasNamespace(bus, namespace.name)).toBe(true);

      expect(await coordinator.applyExtensionTransition(first.name, false)).toBe('applied');
      expect(hasNamespace(bus, namespace.name)).toBe(false);
      expect(owners.ownerOf(namespace.name)).toBeUndefined();
    } finally {
      await coordinator.shutdown();
    }
  });
});
