import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { registerDrizzleRuntimeStorage } from './storage/runtime-drizzle-handler.js';
import { registerDrizzleClientBinaryStorage } from './storage/client-binary-drizzle-handler.js';
import { registerDrizzleProfileStorage } from './storage/profile-drizzle-handler.js';
import { ClientBinaryStorageNamespace } from './storage/client-binary-storage-namespace.js';
import { ClientRuntimeStorageNamespace } from './storage/runtime-storage-namespace.js';
import { ClientProfileStorageNamespace } from './storage/profile-storage-namespace.js';

/**
 * Run storage handler registrations and return one cleanup that unwinds every
 * successful registration in reverse order.
 *
 * If any registration throws, previously registered handlers are immediately
 * rolled back so package startup remains retry-safe.
 * @param registrations - Ordered storage registration callbacks
 * @returns Cleanup function for all successful registrations
 */
export function registerStorageHandlersWithRollback(registrations: ReadonlyArray<() => () => void>): () => void {
  const cleanups: Array<() => void> = [];
  const rollback = (): void => {
    for (const cleanup of [...cleanups].reverse()) {
      cleanup();
    }
  };

  try {
    for (const register of registrations) {
      cleanups.push(register());
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return rollback;
}

/** Owns the persistent client runtime, binary, and profile handlers. */
export const clientStoragePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'makaio.client-storage',
  displayName: 'Client Storage',
  version: '0.1.0',
  critical: true,
  namespaces: [ClientBinaryStorageNamespace, ClientRuntimeStorageNamespace, ClientProfileStorageNamespace],
  storage: {
    /**
     * Register all persistence handlers (runtime, client binary, and
     * profile) on the bus.
     * @param bus - Application bus instance
     * @param db - Drizzle database instance
     * @returns Cleanup function that unregisters all storage handlers
     */
    registerHandlers: registerDrizzleHandlers((bus, db) => {
      return registerStorageHandlersWithRollback([
        () => registerDrizzleRuntimeStorage(bus, db),
        () => registerDrizzleClientBinaryStorage(bus, db),
        () => registerDrizzleProfileStorage(bus, db),
      ]);
    }),
  },
};
