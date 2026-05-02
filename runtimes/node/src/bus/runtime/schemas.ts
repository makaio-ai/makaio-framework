import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Runtime resource schemas.
 *
 * Provides bus subjects for querying runtime-specific resources
 * (database, machine identity) that vary by runtime environment.
 * NodeRuntime registers providers; memory-only runtimes leave them unregistered.
 */
export const RuntimeSchemas = {
  /**
   * Query for database handle.
   * Registered by NodeRuntime. Absent in memory-only runtimes.
   *
   * Subject: `runtime.database`
   * Type: Request (RPC)
   */
  database: {
    request: z.object({}),
    response: z.object({
      /** Drizzle database instance (opaque — consumer casts to MakaioDatabase). */
      db: z.unknown(),
    }),
  },

  /**
   * Query for machine identity (E2E encryption keys).
   * Registered by NodeRuntime. Absent in memory-only runtimes.
   *
   * Subject: `runtime.machineIdentity`
   * Type: Request (RPC)
   */
  machineIdentity: {
    request: z.object({}),
    response: z.object({
      /** MachineIdentity (opaque — consumer casts). */
      identity: z.unknown(),
    }),
  },

  /**
   * Query for the bus server WebSocket port.
   * Registered at the app entry point (Electron main, CLI) where the bus
   * server is created. Absent in memory-only runtimes.
   *
   * Subject: `runtime.busPort`
   * Type: Request (RPC)
   */
  busPort: {
    request: z.object({}),
    response: z.object({
      /** WebSocket port the bus server is listening on. */
      port: z.number(),
    }),
  },
} satisfies SchemaRecord;
