import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension, NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import { stubExtensionIdentity } from '@makaio/test-utils';
import { useJournalHostFixture } from '@makaio/storage-conformance';
import { registerDrizzleHandlers } from '../register-handlers';
const { makeContext, getDatabase } = useJournalHostFixture();

/**
 * Build a minimal extension context for storage handler wrapper tests.
 * @param bus - Bus instance exposed on the context.
 * @returns Extension context with stable test identity and platform fields.
 */
function makeExtensionContext(bus: IMakaioBus): ExtensionContext<IMakaioBus> {
  return makeContext(bus, {
    identity: stubExtensionIdentity('storage-test'),
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/storage-test',
    username: 'test',
    machineId: 'machine-1',
  });
}

describe('registerDrizzleHandlers', () => {
  it('adapts typed Drizzle registration to the extension storage handler contract', () => {
    const bus = createBusInstance();
    const { db } = getDatabase();
    const ctx = makeExtensionContext(bus);
    const cleanup = vi.fn();
    const registration = vi.fn(() => cleanup);

    const wrapped: NonNullable<NonNullable<MakaioNodeExtension<IMakaioBus>['storage']>['registerHandlers']> =
      registerDrizzleHandlers(registration);

    expect(wrapped(bus, db, ctx)).toBe(cleanup);
    expect(registration).toHaveBeenCalledWith(bus, db, ctx);
  });
});
