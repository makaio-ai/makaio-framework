import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import type { MakaioExtension } from '@makaio/contracts';
import { registerHybridPreferencesStorage } from './storage/hybrid-handler.js';

/**
 * MakaioExtension manifest for preferences-domain storage.
 *
 * Registers the hybrid (localStorage + SQLite) storage handler for preference
 * entities. No background service is started (`create` is intentionally absent).
 */
export const preferencesStoragePackage: MakaioExtension = {
  name: 'preferences-storage',
  displayName: 'Preferences Storage',
  critical: true,
  storage: {
    /**
     * Registers hybrid preferences storage handlers on the bus.
     * @param bus - The application bus instance
     * @param db - The Drizzle database instance
     * @returns Cleanup function that unregisters handlers during shutdown
     */
    registerHandlers: registerDrizzleHandlers<Record<string, unknown>>(registerHybridPreferencesStorage),
  },
};
