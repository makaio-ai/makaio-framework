/**
 * Boot bus namespace registration.
 *
 * Registers the `kernel:boot` namespace with typed event schemas for
 * service lifecycle and boot progress observability.
 * Import this module to ensure the namespace is registered before use.
 */
import { MakaioBus } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';

/** Shared identity fields emitted in all per-service lifecycle events. */
const ServiceIdentitySchema = z.object({
  name: z.string(),
  displayName: z.string(),
});

/**
 * Boot domain schemas.
 *
 * Includes both RPC and fire-and-forget event subjects for service
 * lifecycle observability and boot progress tracking.
 */
const BootSchemas = {
  /**
   * Request the current boot state for late subscribers.
   *
   * Subject: `kernel:boot.getState`
   * Type: RPC (request/response)
   * Purpose: Allows clients that connect after boot has started (or completed)
   * to retrieve the current boot state. Returns the same shape as `progress`
   * plus additional fields indicating whether boot is complete and any failures.
   */
  getState: {
    request: z.object({}),
    response: z.object({
      /** Whether boot has completed (all services settled). */
      complete: z.boolean(),
      /** Number of services that have finished (ready or failed). */
      completedCount: z.number(),
      /** Total number of services registered for this boot sequence. */
      totalCount: z.number(),
      /** Display name of the service currently starting, if any. */
      currentService: z.string().optional(),
      /** Services that failed to start (may be empty). */
      failedServices: z.array(z.string()),
      /** Services that intentionally skipped startup (may be empty). */
      skippedServices: z.array(z.string()).default([]),
      /** Total boot duration in milliseconds (only set when complete=true). */
      totalDurationMs: z.number().optional(),
    }),
  },

  /**
   * Signal that a service has begun its startup sequence.
   *
   * Subject: `kernel:boot.service.starting`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted immediately before a service's `create()` method is invoked.
   * Allows observers to track which services are actively starting.
   */
  'service.starting': ServiceIdentitySchema,

  /**
   * Signal that a service has successfully completed startup.
   *
   * Subject: `kernel:boot.service.ready`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted after a service's `create()` method resolves successfully.
   * Includes elapsed startup duration for performance monitoring.
   * @param durationMs - Elapsed time in milliseconds from `service.starting` to ready.
   */
  'service.ready': ServiceIdentitySchema.extend({
    durationMs: z.number().int().nonnegative(),
  }),

  /**
   * Signal that a service failed to start.
   *
   * Subject: `kernel:boot.service.failed`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted when a service's `create()` method throws or rejects.
   * Carries the error message for diagnostics and UI error display.
   * @param errorMessage - Stringified error from the failed startup attempt.
   */
  'service.failed': ServiceIdentitySchema.extend({
    errorMessage: z.string(),
  }),

  /**
   * Signal that a service intentionally skipped startup.
   *
   * Subject: `kernel:boot.service.skipped`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted when a service's `create()` throws a {@link ServiceSkipError},
   * indicating the service opted out due to role, feature flag, or environment
   * mismatch — not an error condition.
   * @param reason - Human-readable explanation from the ServiceSkipError.
   */
  'service.skipped': ServiceIdentitySchema.extend({
    reason: z.string(),
  }),

  /**
   * Signal the current boot progress across all services.
   *
   * Subject: `kernel:boot.progress`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted after each service completes (successfully or not).
   * Used by progress indicators to show startup completion percentage.
   * @param completedCount - Number of services that have finished (ready or failed).
   * @param totalCount - Total number of services registered for this boot sequence.
   * @param currentService - Display name of the service currently starting, if any.
   */
  progress: z.object({
    completedCount: z.number(),
    totalCount: z.number(),
    currentService: z.string().optional(),
  }),

  /**
   * Signal that all services have completed their startup attempts.
   *
   * Subject: `kernel:boot.complete`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted once all registered services have resolved or rejected.
   * Carries the total boot duration and names of any failed services.
   * @param totalDurationMs - Elapsed time in milliseconds for the entire boot sequence.
   * @param failedServices - Array of service names that failed to start (may be empty).
   */
  complete: z.object({
    totalDurationMs: z.number(),
    failedServices: z.array(z.string()),
  }),
} satisfies SchemaRecord;

/**
 * Boot namespace for bus operations.
 */
export const BootNamespace = MakaioBus.registerNamespace('kernel:boot', BootSchemas);

/**
 * Boot subjects for type-safe bus operations.
 *
 * Subjects:
 * - `getState`         — RPC to retrieve the current boot state for late subscribers
 * - `service.starting` — event: emitted before a service begins startup
 * - `service.ready`    — event: emitted when a service finishes startup successfully
 * - `service.failed`   — event: emitted when a service startup throws an unexpected error
 * - `service.skipped`  — event: emitted when a service throws ServiceSkipError (intentional opt-out)
 * - `progress`         — event: emitted after each service completes, with overall progress
 * - `complete`         — event: emitted once all services have settled
 *
 * Dot-notation keys produce nested access:
 * ```typescript
 * BootSubjects.service.starting
 * BootSubjects.complete
 * ```
 */
export const BootSubjects = BootNamespace.subjects;
