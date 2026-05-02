import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Cleanup handle returned by storage registration.
 */
export interface StorageCleanup {
  /** Unregister all storage handlers from the bus. */
  cleanup: () => void;
  /** Database handle, if this provider uses a database (e.g., Drizzle). */
  db?: unknown;
}

/**
 * Platform-specific storage backend.
 * Registers bus handlers that respond to storage namespace subjects.
 */
export interface StorageProvider {
  /**
   * Register storage handlers on the bus.
   * Called before app.start() in the composition root.
   * @param bus - Bus instance to register handlers on
   * @param machineId - Machine identifier for storage scoping
   */
  registerHandlers(bus: IMakaioBus, machineId: string): Promise<StorageCleanup>;

  /** Release storage resources (close DB connections, etc.). */
  dispose(): Promise<void>;
}
