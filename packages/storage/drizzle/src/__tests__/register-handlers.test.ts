import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { NodeExtensionContext as ExtensionContext, MakaioExtension } from '@makaio/contracts';
import { registerDrizzleHandlers } from '../register-handlers.js';
import type { MakaioDatabase } from '../types.js';

/**
 * Build a minimal extension context for storage handler wrapper tests.
 * @param bus - Bus instance exposed on the context.
 * @returns Extension context with stable test identity and platform fields.
 */
function makeExtensionContext(bus: ExtensionContext['bus']): ExtensionContext {
  return {
    bus,
    identity: { extensionName: 'storage-test' } as ExtensionContext['identity'],
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

    const wrapped: NonNullable<NonNullable<MakaioExtension['storage']>['registerHandlers']> =
      registerDrizzleHandlers(registration);

    expect(wrapped(bus, db, ctx)).toBe(cleanup);
    expect(registration).toHaveBeenCalledWith(bus, db, ctx);
  });
});
