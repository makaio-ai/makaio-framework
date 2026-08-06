import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { AutomationTriggerDescriptorSchema, AutomationTriggerKindSchema } from './schemas.js';

/**
 * Framework-level automation trigger discovery bus schemas.
 *
 * Defines the RPC and event subjects for the automation trigger registry.
 * The schema set covers:
 *
 * - `list` — query all currently registered trigger descriptors (RPC)
 * - `changed` — emitted when the trigger registry changes (event)
 *
 * Callers use `list` to populate the Builder UI's trigger catalog.
 * The `changed` event enables reactive updates without polling.
 *
 * Hosts that extend the trigger surface should register an additional
 * host-owned namespace rather than merging subjects into this one.
 */
export const AutomationTriggerSchemas = {
  /**
   * List all currently registered automation trigger descriptors (RPC).
   *
   * Returns the complete set of serializable descriptors contributed by all
   * active extensions. Callers should re-query on {@link changed} events to
   * keep their catalog current.
   */
  list: {
    request: z.object({}),
    response: z.object({ triggers: z.array(AutomationTriggerDescriptorSchema) }),
  },

  /**
   * Emitted when the automation trigger registry changes.
   *
   * Fired whenever an extension registers or deregisters its trigger batch.
   * The `revision` counter monotonically increases so that subscribers can
   * detect missed events. `kinds` is the exact union of the owner's previous
   * and replacement batches, so consumers can refresh only identities whose
   * registration may have changed without inferring ownership from a prefix.
   */
  changed: z.object({
    /** Name of the extension that owns the changed trigger batch. */
    owner: z.string().min(1),
    /**
     * Monotonically increasing registry revision number.
     * Starts at 0 and increments on every registration or deregistration.
     */
    revision: z.number().int().nonnegative(),
    /** Exact trigger kinds whose registration may have changed. */
    kinds: z.array(AutomationTriggerKindSchema).min(1),
    /** Whether triggers were added or removed. */
    reason: z.enum(['registered', 'deregistered']),
  }),
} satisfies SchemaRecord;

/**
 * Automation trigger discovery bus namespace.
 *
 * Registers the `automation-triggers` namespace with framework-level RPC and
 * event subjects for the trigger registry. Use {@link AutomationTriggerSubjects}
 * to access typed bus subject descriptors.
 */
export const AutomationTriggerNamespace = createBusNamespace('automation-triggers', AutomationTriggerSchemas);

/**
 * Typed subjects for automation trigger bus communication.
 *
 * Available subjects:
 * - `AutomationTriggerSubjects['list']` — list registered triggers (RPC)
 * - `AutomationTriggerSubjects['changed']` — trigger registry changed event
 */
export const AutomationTriggerSubjects = AutomationTriggerNamespace.subjects;

// ---------------------------------------------------------------------------
// RPC request / response types
// ---------------------------------------------------------------------------

/** Request payload for listing registered automation triggers. */
export type AutomationTriggerListRequest = z.infer<(typeof AutomationTriggerSchemas)['list']['request']>;

/** Response payload for listing registered automation triggers. */
export type AutomationTriggerListResponse = z.infer<(typeof AutomationTriggerSchemas)['list']['response']>;

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** Payload for the automation trigger registry changed event. */
export type AutomationTriggerChangedPayload = z.infer<(typeof AutomationTriggerSchemas)['changed']>;
