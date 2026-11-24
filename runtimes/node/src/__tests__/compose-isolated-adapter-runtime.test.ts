import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ownerOf } from '@makaio/bus-core/kernel-api';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces } from '@makaio/contracts';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import { FrameworkServicesCoreNamespaces, MakaioSessionService, SessionToken } from '@makaio/services-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { FileAdapterConfigRepository, orderAfterAdapterSubsystem } from '@makaio/subsystem-adapter';
import { expect, it } from 'vitest';
import { prepareAdapterRuntime } from '../compose-adapter-runtime.js';

type IsolatedContext = IsolatedNodeExtensionContext<IMakaioBus>;

it('activates an adapter contribution and releases its namespace on an isolated coordinator', async () => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-adapter-'));
  const bus = createBusInstance();
  bus.registerNamespaces([
    ...FrameworkContractNamespaces,
    ...FrameworkStorageNamespaces,
    ...FrameworkServicesCoreNamespaces,
  ]);
  const coordinator = new ExtensionCoordinator<IsolatedContext>(bus, {
    extensionContextBase: {
      platform: process.platform,
      homedir: home,
      makaioHome: home,
      username: 'test',
      machineId: 'isolated-machine',
      tryImport: async () => null,
      constructContext: (context) => context,
    },
  });

  try {
    const { adapterSubsystemPackage } = prepareAdapterRuntime({
      coordinator,
      configRepository: new FileAdapterConfigRepository({
        adaptersDir: join(home, 'adapters'),
        providerConfigsDir: join(home, 'provider-configs'),
      }),
      platformDefaults: {},
    });
    const name = 'isolated-adapter';
    const namespace = createBusNamespace('adapter:isolated-adapter', {});
    const contributor: KernelMakaioExtension<IsolatedContext> = {
      name,
      displayName: 'Isolated adapter',
      version: '1.0.0',
      adapters: [
        {
          manifest: { name, protocols: ['openai'] },
          definition: {
            name,
            providers: [],
            busNamespace: namespace,
            defaultTimeouts: { initialization: 1, acknowledgement: 1, completion: 1, toolApproval: 1, eventWait: 1 },
            createAdapter: async () => ({ namespaceName: namespace.name }),
          },
        },
      ],
    };
    coordinator.load(
      orderAfterAdapterSubsystem([
        {
          name: SessionToken.name,
          displayName: 'Session',
          version: '1.0.0',
          create: (ctx) => new MakaioSessionService(ctx.bus, { machineId: ctx.machineId }),
        },
        adapterSubsystemPackage,
        contributor,
      ]),
    );
    await coordinator.startAll();

    expect(ownerOf(bus, namespace.name)).toEqual({ kind: 'extension', extension: name });
    // ORIGIN: the host test queries the adapter config on its own bus.
    const call = bus.own('root');
    const { config } = await bus.request(call, AdapterSubsystemSubjects.getAdapterConfig, { name });
    expect(config).toMatchObject({ name, enabled: false });

    await coordinator.shutdown();
    expect(ownerOf(bus, namespace.name)).toBeUndefined();
  } finally {
    await coordinator.shutdown().finally(() => rm(home, { recursive: true, force: true }));
  }
});
