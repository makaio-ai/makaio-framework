import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension, NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import { registerDrizzleHandlers } from '../register-handlers';
import type { MakaioDatabase } from '../types';

/**
 * Build a minimal extension context for storage handler wrapper tests.
 * @param bus - Bus instance exposed on the context.
 * @returns Extension context with stable test identity and platform fields.
 */
function makeExtensionContext(bus: IMakaioBus): ExtensionContext<IMakaioBus> {
  return {
    bus,
    identity: { extensionName: 'storage-test' } as ExtensionContext<IMakaioBus>['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/storage-test',
    username: 'test',
    machineId: 'machine-1',
    getService: () => undefined,
    tryImport: async () => null,
    signal: new AbortController().signal,
    hasExtension: () => false,
  };
}

describe('registerDrizzleHandlers', () => {
  it('adapts typed Drizzle registration to the extension storage handler contract', () => {
    const bus = createBusInstance();
    const db = {} as MakaioDatabase;
    const ctx = makeExtensionContext(bus);
    const cleanup = vi.fn();
    const registration = vi.fn(() => cleanup);

    const wrapped: NonNullable<NonNullable<MakaioNodeExtension<IMakaioBus>['storage']>['registerHandlers']> =
      registerDrizzleHandlers(registration);

    expect(wrapped(bus, db, ctx)).toBe(cleanup);
    expect(registration).toHaveBeenCalledWith(bus, db, ctx);
  });
});
