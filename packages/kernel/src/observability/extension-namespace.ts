/**
 * Extension bus namespace registration (`kernel:extension.*`).
 *
 * Replaces `extension/extension-subjects.ts`. Registers the kernel-owned
 * extension namespace prefix with an expanded set of subjects for full lifecycle
 * observability and enable/disable control.
 *
 * Subjects:
 * - `kernel:extension.stateChanged`      — fire-and-forget lifecycle transition event
 * - `kernel:extension.list`              — RPC listing all extensions with current state
 * - `kernel:extension.get`               — RPC fetching a single extension by name
 * - `kernel:extension.setEnabled`        — RPC enabling or disabling an extension at runtime
 * - `kernel:extension.enabledChanged`    — fire-and-forget event when enabled flag changes
 * - `kernel:extension.warnings.list`     — RPC listing active health warnings per extension
 * - `kernel:extension.warnings.changed`  — fire-and-forget snapshot after each health-check run
 */
import { MakaioBus } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import { ClientDefinitionSchema, ProviderDefinitionSchema } from '@makaio/contracts';
import { ComponentStateSchema, ExtensionInfoSchema, ExtensionWarningEntrySchema } from './shared-schemas.js';

const ExtensionContributionCatalogEntrySchema = z.object({
  packageName: z.string(),
});

const ExtensionProviderContributionSchema = ExtensionContributionCatalogEntrySchema.extend({
  definition: ProviderDefinitionSchema,
});

const ExtensionClientContributionSchema = ExtensionContributionCatalogEntrySchema.extend({
  definition: ClientDefinitionSchema,
});

/**
 * Schema definitions for the `kernel:extension` bus namespace.
 */
const ExtensionSchemas = {
  /**
   * Signal that an extension has transitioned between lifecycle states.
   *
   * Subject: `kernel:extension.stateChanged`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted by the ExtensionCoordinator whenever an extension moves
   * from one lifecycle state to another. Observers (e.g. debug logging,
   * boot progress UI, adapter subsystem) subscribe to track extension health.
   * @param name - Unique machine-readable extension identifier.
   * @param displayName - Human-readable extension label.
   * @param from - Previous lifecycle state.
   * @param to - New lifecycle state.
   * @param error - Human-readable error message when transitioning to `'failed'`.
   * @param contributes - Static flags indicating which contribution surfaces the
   *   extension declares. Absent when the extension declares no contributions.
   *   Subsystems use these flags as declarative bus filters to react only to
   *   relevant extensions (e.g. `{ 'contributes.adapters': true, to: 'active' }`).
   */
  stateChanged: z.object({
    name: z.string(),
    displayName: z.string(),
    from: ComponentStateSchema,
    to: ComponentStateSchema,
    error: z.string().optional(),
    contributes: z
      .object({
        adapters: z.boolean(),
        tools: z.boolean(),
        triggers: z.boolean(),
        providers: z.boolean(),
        clients: z.boolean(),
        ui: z.boolean(),
        storage: z.boolean(),
        sessionEventActions: z.boolean(),
      })
      .optional(),
  }),

  /**
   * Request the current state of all registered extensions.
   *
   * Subject: `kernel:extension.list`
   * Type: RPC (request/response)
   * Purpose: Allows late subscribers (e.g. CLI status commands, debug panels)
   * to retrieve the full extension list with current lifecycle states without
   * waiting for incremental `stateChanged` events.
   */
  list: {
    request: z.object({}),
    response: z.object({
      extensions: z.array(ExtensionInfoSchema),
    }),
  },

  /**
   * Request info for a single extension by name.
   *
   * Subject: `kernel:extension.get`
   * Type: RPC (request/response)
   * Purpose: Allows targeted lookup of a single extension's state and metadata.
   * Returns `{ extension: null }` when no extension with the given name is registered.
   * @param name - Unique extension identifier to look up.
   */
  get: {
    request: z.object({ name: z.string() }),
    response: z.object({ extension: ExtensionInfoSchema.nullable() }),
  },

  /**
   * Enable or disable an extension at runtime.
   *
   * Subject: `kernel:extension.setEnabled`
   * Type: RPC (request/response)
   * Purpose: Allows the user or platform config to toggle an extension without
   * a full restart. The coordinator re-enters the load path on enable, or runs
   * cleanup and transitions to `stopped` on disable.
   * @param name - Unique extension identifier to toggle.
   * @param enabled - Target enabled state.
   */
  setEnabled: {
    request: z.object({ name: z.string(), enabled: z.boolean() }),
    response: z.object({ success: z.boolean() }),
  },

  /**
   * Request active extension-owned provider and client contributions.
   *
   * Subject: `kernel:extension.contributions.catalog`
   * Type: RPC (request/response)
   * Purpose: Exposes boot/runtime contribution metadata through a typed bus seam
   * without passing the coordinator object through lifecycle phase payloads.
   */
  'contributions.catalog': {
    request: z.object({}),
    response: z.object({
      providers: z.array(ExtensionProviderContributionSchema),
      clients: z.array(ExtensionClientContributionSchema),
    }),
  },

  /**
   * Signal that an extension's enabled state has changed.
   *
   * Subject: `kernel:extension.enabledChanged`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted after a successful `kernel:extension.setEnabled` call so
   * observers can react to enable/disable changes without polling.
   * @param name - Unique extension identifier.
   * @param enabled - New enabled state.
   */
  enabledChanged: z.object({
    name: z.string(),
    enabled: z.boolean(),
  }),

  /**
   * Request the current health warnings for all (or a specific) extension.
   *
   * Subject: `kernel:extension.warnings.list`
   * Type: RPC (request/response)
   * Purpose: Allows late subscribers (e.g. notification panels, CLI health
   * commands) to retrieve a snapshot of active extension warnings without
   * waiting for incremental `warnings.changed` events.
   * @param extensionName - Optional extension name to filter results.
   *   When omitted, entries for all extensions with active warnings are returned.
   */
  'warnings.list': {
    request: z.object({ extensionName: z.string().optional() }),
    response: z.object({
      entries: z.array(ExtensionWarningEntrySchema),
    }),
  },

  /**
   * Snapshot of an extension's health warnings after a health-check run.
   *
   * Subject: `kernel:extension.warnings.changed`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted by the ExtensionCoordinator after every health-check run,
   * regardless of whether the warning set actually changed. This unconditional
   * emission simplifies subscriber logic — consumers always receive the latest
   * snapshot without needing to diff against a prior state.
   * @param extensionName - Unique machine-readable identifier of the extension.
   * @param warnings - Full set of active health warnings; an empty array signals no active warnings.
   */
  'warnings.changed': ExtensionWarningEntrySchema,
} satisfies SchemaRecord;

/**
 * Extension namespace for bus operations.
 */
export const ExtensionNamespace = MakaioBus.registerNamespace('kernel:extension', ExtensionSchemas);

/**
 * Extension subjects for type-safe bus operations.
 *
 * Subjects:
 * - `stateChanged`        — event: emitted when an extension transitions between lifecycle states
 * - `list`                — RPC: retrieve all registered extensions and their current state
 * - `get`                 — RPC: retrieve a single extension's info by name
 * - `setEnabled`          — RPC: enable or disable an extension at runtime
 * - `enabledChanged`      — event: emitted when an extension's enabled flag changes
 * - `warnings.list`       — RPC: retrieve active health warnings for all (or one) extension
 * - `warnings.changed`    — event: emitted after every health-check run with the latest warning snapshot
 * @example
 * ```typescript
 * ExtensionSubjects.stateChanged
 * ExtensionSubjects.list
 * ExtensionSubjects.warnings.list
 * ExtensionSubjects.warnings.changed
 * ```
 */
export const ExtensionSubjects = ExtensionNamespace.subjects;
