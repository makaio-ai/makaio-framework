/**
 * Integration gate for the adapter-teardown → ownership-retirement ordering.
 *
 * A real coordinator and the real two services are used because the package
 * dependency is the ordering mechanism. Calling either service directly would
 * not prove the dependency continues to put the teardown fact first.
 */
import { describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  type MakaioNodeExtension,
  type NodeExtensionContext,
} from '@makaio/contracts';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import { ExtensionCoordinator } from '@makaio/kernel';
import { SessionToken, MakaioSessionService } from '@makaio/services-core';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { createAdapterSubsystemPackage } from '../index.js';

/** Empty but fully writable adapter config repository for service boot. */
class EmptyAdapterConfigRepository implements IAdapterConfigRepository {
  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    return { configs: new Map() };
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

const EXTENSION_CONTEXT: Omit<
  NodeExtensionContext,
  'bus' | 'identity' | 'getService' | 'dataDir' | 'signal' | 'hasExtension'
> = {
  platform: 'linux',
  homedir: '/tmp',
  makaioHome: '/tmp/.makaio',
  username: 'test',
  machineId: 'retirement-order-machine',
  tryImport: async () => null,
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
    const sessionExtension: MakaioNodeExtension<IMakaioBus> = {
      name: SessionToken.name,
      displayName: 'Session',
      version: '0.1.0',
      critical: true,
      create: (ctx) => new MakaioSessionService(ctx.bus, { machineId: ctx.machineId }),
    };
    const adapterExtension = createAdapterSubsystemPackage({
      configRepository: new EmptyAdapterConfigRepository(),
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
