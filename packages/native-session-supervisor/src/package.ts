/**
 * MakaioExtension manifest for the native session supervisor.
 *
 * Registers:
 * - The `SupervisorService` as the package service (lifecycle owner).
 * - The Drizzle-backed storage handlers for supervisor runtime persistence.
 *
 * The `storage.registerHandlers` callback is invoked by the composition root
 * after migrations have been applied but before services are started.
 */

import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import type { MakaioExtension } from '@makaio/contracts';
import { SupervisorService } from './supervisor-service.js';
import { registerDrizzleSupervisorRuntimeStorage } from './storage/drizzle-handler.js';

/**
 * MakaioExtension manifest for the native session supervisor package.
 *
 * Critical because the supervisor service manages process runtimes that other
 * packages depend on for native CLI attachment.
 */
export const nativeSessionSupervisorPackage: MakaioExtension = {
  name: 'makaio.native-session-supervisor',
  displayName: 'Native Session Supervisor',
  critical: true,

  /**
   * Creates the supervisor service.
   * @param ctx - Runtime package context.
   * @returns The supervisor service instance (not yet initialized).
   */
  create: (ctx) => new SupervisorService(ctx.bus),

  storage: {
    /**
     * Registers Drizzle-backed bus storage handlers for supervisor runtimes.
     * @param bus - The application bus instance.
     * @param db - The Drizzle database instance.
     * @returns Cleanup function that unregisters handlers during shutdown.
     */
    registerHandlers: registerDrizzleHandlers(registerDrizzleSupervisorRuntimeStorage),
  },
};
