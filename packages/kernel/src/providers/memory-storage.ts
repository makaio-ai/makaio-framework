import type { IMakaioBus } from '@makaio/bus-core';
import type { StorageCleanup, StorageProvider } from './storage.js';

/**
 * No-op storage provider.
 *
 * Satisfies the {@link StorageProvider} interface when no platform-specific storage
 * (e.g., Drizzle) is needed.
 */
export class MemoryStorageProvider implements StorageProvider {
  /**
   * Returns a no-op cleanup handle.
   *
   * In-memory bus handler registration is performed by individual service
   * storage factories before service construction.
   * @param _bus - Unused bus instance
   * @param _machineId - Unused machine identifier
   * @returns A no-op cleanup handle
   */
  public async registerHandlers(_bus: IMakaioBus, _machineId: string): Promise<StorageCleanup> {
    return { cleanup: () => {} };
  }

  /** Nothing to dispose for in-memory storage. */
  public async dispose(): Promise<void> {}
}
