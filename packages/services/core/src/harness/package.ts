import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { HarnessService } from './harness-service.js';
import { registerDrizzleHarnessStorage } from './storage/handler.js';

/**
 * MakaioExtension manifest for {@link HarnessService}.
 *
 * Test harness management is surface-agnostic — used in both interactive
 * and headless runtimes for agent execution environment provisioning.
 *
 * Storage handlers are registered before `create` so that
 * `HarnessService.onInit()` can seed default harnesses via the bus immediately.
 */
export const harnessPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'makaio.harness',
  displayName: 'Harness',
  version: '0.1.0',
  critical: true,
  storage: {
    /**
     * Registers harness definition Drizzle storage handlers on the bus.
     * @param bus - The application bus instance
     * @param db - The Drizzle database instance
     * @returns Cleanup function that unregisters all handlers during shutdown
     */
    registerHandlers: registerDrizzleHandlers(registerDrizzleHarnessStorage),
  },
  /**
   * Creates a new {@link HarnessService} bound to the package bus.
   * @param ctx - Runtime context providing the bus instance.
   * @returns Uninitialized service instance; host calls `init()`.
   */
  create: (ctx) => new HarnessService(ctx.bus),
};
