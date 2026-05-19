import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterRuntimeSubjects,
  buildDeterministicAdapterId,
  registerAdapterRuntimeIdentityHandlers,
} from '@makaio/services-core/adapter-runtime';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import {
  type AdapterFileConfigSet,
  type IAdapterConfigRepository,
  type ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { AdapterSubsystemService } from '../adapter-subsystem-service.js';
import { createStubCoordinator, TEST_MACHINE_ID, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

class CountingRepository implements IAdapterConfigRepository {
  public providerLoads = 0;
  public adapterLoads = 0;

  public constructor(
    private readonly providerConfigs: Map<string, ProviderConfigFile>,
    private readonly adapters: Map<string, AdapterFile>,
  ) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    this.adapterLoads += 1;
    return { configs: new Map([...this.adapters.entries()].map(([name, config]) => [name, structuredClone(config)])) };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    this.providerLoads += 1;
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(): Promise<void> {
    throw new Error('Unexpected provider config write during identity test');
  }

  public async deleteProviderConfig(): Promise<boolean> {
    throw new Error('Unexpected provider config delete during identity test');
  }

  public async writeAdapterFile(): Promise<void> {
    throw new Error('Unexpected adapter write during identity test');
  }

  public async deleteAdapterFile(): Promise<boolean> {
    throw new Error('Unexpected adapter delete during identity test');
  }
}

describe('AdapterSubsystemService identity and demand', () => {
  let service: AdapterSubsystemService;
  let cleanupIdentityHandlers: (() => void) | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    cleanupIdentityHandlers?.();
    cleanupIdentityHandlers = undefined;
    await service?.destroy?.();
    MakaioBus.__resetHandlers?.();
  });

  it('dedupes concurrent init and keeps readiness as a direct no-op barrier', async () => {
    const repository = new CountingRepository(new Map<string, ProviderConfigFile>(), new Map<string, AdapterFile>());
    const readyEvents: Array<Record<string, never>> = [];
    const offReady = MakaioBus.on(AdapterSubsystemSubjects.ready, (ctx) => {
      readyEvents.push(ctx.payload);
    });

    try {
      service = new AdapterSubsystemService({
        bus: MakaioBus,
        configRepository: repository,
        coordinator: createStubCoordinator(),
        machineId: TEST_MACHINE_ID,
        platformDefaults: TEST_PLATFORM_DEFAULTS,
      });

      await Promise.all([service.init(), service.init(), service.init()]);
      await service.init();
      cleanupIdentityHandlers = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
        currentMachineId: 'machine-local',
        knownAdapterNames: ['claude-code'],
      }).cleanup;

      const { adapterId } = await MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName: 'claude-code',
        machineId: 'machine-local',
      });
      expect(adapterId).toBe(buildDeterministicAdapterId('machine-local', 'claude-code'));

      const { adapterName } = await MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
        adapterId,
      });
      expect(adapterName).toBe('claude-code');

      await expect(
        MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
          adapterId: ':claude-code',
        }),
      ).rejects.toThrow(/Adapter not found/);

      const remoteResolved = await MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName: 'claude-code',
        machineId: 'other-machine',
      });
      expect(remoteResolved).toEqual({
        adapterId: buildDeterministicAdapterId('other-machine', 'claude-code'),
      });

      await expect(
        MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
          adapterId: buildDeterministicAdapterId('other-machine', 'missing-adapter'),
        }),
      ).rejects.toThrow(/Adapter not found/);

      await expect(
        MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
          adapterId: remoteResolved.adapterId,
        }),
      ).resolves.toEqual({ adapterName: 'claude-code' });

      await expect(
        MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
          adapterId: '00000000-0000-5000-a000-000000000000',
        }),
      ).rejects.toThrow(/Adapter not found/);

      await expect(
        MakaioBus.request(AdapterRuntimeSubjects.resolveName, {
          adapterId: 'missing-separator',
        }),
      ).rejects.toThrow(/Adapter not found/);

      expect(repository.providerLoads).toBe(1);
      expect(repository.adapterLoads).toBe(1);
      expect(readyEvents).toEqual([{}]);

      expect(await MakaioBus.request(AdapterSubsystemSubjects.ensureReady, {})).toEqual({ ready: true });
      expect(await MakaioBus.request(AdapterSubsystemSubjects.ensureReady, {})).toEqual({ ready: true });
      expect(repository.providerLoads).toBe(1);
      expect(repository.adapterLoads).toBe(1);
    } finally {
      offReady();
    }
  });

  it('hashes machineId and adapterName as an unambiguous tuple', () => {
    expect(buildDeterministicAdapterId('machine', 'adapter:child')).not.toBe(
      buildDeterministicAdapterId('machine:adapter', 'child'),
    );
  });
});
