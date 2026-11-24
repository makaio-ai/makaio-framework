import { createBusInstance } from '@makaio/bus-core';
import { expect, it } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts';
import { ExtensionCoordinator } from '../index.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

const nodeFields = {
  platform: 'linux',
  username: 'host',
  homedir: '/home/host',
  makaioHome: '/home/host/.makaio',
  machineId: 'machine',
  tryImport: async () => null,
} as const;

it('passes the default and explicitly constructed host contexts to extension factories', async () => {
  const defaultBus = createBusInstance();
  const isolatedBus = createBusInstance();
  const defaultCoordinator = new ExtensionCoordinator(defaultBus, {
    extensionContextBase: { ...nodeFields, constructContext },
  });
  const isolatedCoordinator = new ExtensionCoordinator<IsolatedNodeExtensionContext<IMakaioBus>>(isolatedBus, {
    extensionContextBase: {
      ...nodeFields,
      constructContext: (context) => ({ ...context, username: 'isolated' }),
    },
  });
  const received: Array<IsolatedNodeExtensionContext<IMakaioBus>> = [];
  const extension = {
    name: 'context-reader',
    displayName: 'Context reader',
    version: '1.0.0',
    create: (context: IsolatedNodeExtensionContext<IMakaioBus>) => {
      received.push(context);
      return { init: async () => {}, destroy: async () => {} };
    },
  } as const;

  try {
    defaultCoordinator.load([extension]);
    isolatedCoordinator.load([extension]);
    await defaultCoordinator.startAll();
    await isolatedCoordinator.startAll();

    expect(received.map((context) => context.username)).toEqual(['host', 'isolated']);
    expect(received[0]?.bus).not.toBe(defaultBus);
    expect(received[1]?.bus).not.toBe(isolatedBus);
    expect(received[0]?.bus).not.toBe(received[1]?.bus);
  } finally {
    await Promise.all([defaultCoordinator.shutdown(), isolatedCoordinator.shutdown()]);
  }
});
