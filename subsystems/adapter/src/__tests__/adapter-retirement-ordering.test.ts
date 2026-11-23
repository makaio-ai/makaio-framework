/**
 * Integration gate for the adapter-teardown → ownership-retirement ordering.
 *
 * A real coordinator and the real two services are used because the package
 * dependency is the ordering mechanism. Calling either service directly would
 * not prove the dependency continues to put the teardown fact first.
 */
import { describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { McpSubjects, SessionOwnershipStorageSubjects, type MakaioNodeExtension } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import { ExtensionCoordinator, type ExtensionContextBase } from '@makaio/kernel';
import { SessionToken, MakaioSessionService } from '@makaio/services-core';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import {
  AdapterSubsystemToken,
  createAdapterSubsystemContributionProcessor,
  createAdapterSubsystemPackage,
  orderAfterAdapterSubsystem,
} from '../index.js';
import type { AdapterRuntimeInitOptions } from '../adapter-runtime-types.js';

/** In-memory adapter config fixture for service boot. */
class TestAdapterConfigRepository implements IAdapterConfigRepository {
  /**
   * Seed the config read by the real adapter subsystem at startup.
   * @param configs - Adapter files already configured by the host.
   */
  public constructor(private readonly configs: Map<string, AdapterFile> = new Map()) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    return { configs: this.configs };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    return { configs: new Map() };
  }

  public async writeProviderConfig(_id: string, _config: ProviderConfigFile): Promise<void> {}

  public async deleteProviderConfig(_id: string): Promise<boolean> {
    return false;
  }

  public async writeAdapterFile(_name: string, _config: AdapterFile): Promise<void> {}

  public async deleteAdapterFile(_name: string): Promise<boolean> {
    return false;
  }
}

const EXTENSION_CONTEXT: ExtensionContextBase = {
  platform: 'linux',
  homedir: '/tmp',
  makaioHome: '/tmp/.makaio',
  username: 'test',
  machineId: 'retirement-order-machine',
  tryImport: async () => null,
};

const sessionExtension: MakaioNodeExtension<IMakaioBus> = {
  name: SessionToken.name,
  displayName: 'Session',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new MakaioSessionService(ctx.bus, { machineId: ctx.machineId }),
};

describe('adapter retirement ordering', () => {
  it('publishes the actual adapter aggregate before the session authority retires', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: EXTENSION_CONTEXT });
    const order: string[] = [];
    const cleanups = [
      bus.on(AdapterRuntimeSubjects.teardownCompleted, (ctx) => {
        order.push(`teardown:${ctx.payload.evidence}`);
      }),
      bus.on(SessionOwnershipStorageSubjects.retireInstance, (ctx) => {
        order.push('retire');
        ctx.setResult({ retiredMachines: 1 });
      }),
    ];
    const adapterExtension = createAdapterSubsystemPackage({
      configRepository: new TestAdapterConfigRepository(),
      coordinator,
      platformDefaults: {},
    });

    try {
      coordinator.load([sessionExtension, adapterExtension]);
      await coordinator.startAll();
      await coordinator.shutdown();

      // Empty adapter registries truthfully aggregate to `released`. Retirement
      // follows only because the real producer published that observed class.
      expect(order).toEqual(['teardown:released', 'retire']);
    } finally {
      await coordinator.shutdown().catch(() => undefined);
      for (const cleanup of cleanups) cleanup();
    }
  });
});

describe('adapter contribution carrier', () => {
  it('attributes a lifecycle MCP registration to the extension that contributed the adapter', async () => {
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: EXTENSION_CONTEXT });
    const extensionName = 'mcp-adapter-extension';
    const adapterName = 'mcp-adapter';
    const calls: CallContext[] = [];
    const offRegister = bus.on(McpSubjects.session.register, (ctx) => {
      calls.push(ctx.call);
      ctx.setResult({ port: 12_345 });
    });
    const adapterExtension = createAdapterSubsystemPackage({
      configRepository: new TestAdapterConfigRepository(
        new Map([[adapterName, { $schema: 'makaio/adapter-config/v1', enabled: true }]]),
      ),
      coordinator,
      platformDefaults: {},
    });
    const contributor: MakaioNodeExtension<IMakaioBus> = {
      name: extensionName,
      displayName: 'MCP Adapter Extension',
      version: '1.0.0',
      adapters: [
        {
          manifest: { name: adapterName, protocols: ['openai'] },
          definition: {
            name: adapterName,
            providers: [],
            defaultTimeouts: { initialization: 1, acknowledgement: 1, completion: 1, toolApproval: 1, eventWait: 1 },
            /**
             * Register a session during adapter startup on the factory's injected carrier.
             * @param options - Adapter identity and carrier supplied by the subsystem.
             */
            createAdapter: async ({ adapterId, globalBus }: AdapterRuntimeInitOptions) => {
              const session = { agentId: 'agent', sessionId: 'session', adapterSessionId: 'native-session' };
              await globalBus.request(globalBus.own('start'), McpSubjects.session.register, {
                ...session,
                adapterId,
                adapterName,
                contextOverrides: { ...session, cwd: '/tmp', env: {} },
              });
              return { adapterId };
            },
          },
        },
      ],
    };
    coordinator.registerContributionProcessor(
      createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => coordinator.getExtensionService(AdapterSubsystemToken),
      }),
    );

    try {
      coordinator.load([sessionExtension, adapterExtension, ...orderAfterAdapterSubsystem([contributor])]);
      await coordinator.startAll();

      expect(calls.map(({ caller }) => caller)).toEqual([{ kind: 'makaio.extension', id: extensionName }]);
    } finally {
      await coordinator.shutdown();
      offRegister();
    }
  });
});
