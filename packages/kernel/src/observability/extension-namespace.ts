/**
 * Extension bus namespace definition (`kernel:extension.*`).
 *
 * Replaces `extension/extension-subjects.ts`. Defines the kernel-owned
 * extension namespace prefix with an expanded set of subjects for full
 * lifecycle observability and enable/disable control.
 *
 * Subjects:
 * - `kernel:extension.stateChanged`      — fire-and-forget lifecycle transition event
 * - `kernel:extension.list`              — RPC listing all extensions with current state
 * - `kernel:extension.get`               — RPC fetching a single extension by name
 * - `kernel:extension.setEnabled`        — RPC persisting an operator enable/disable preference
 * - `kernel:extension.catalog`           — RPC listing every extension package installed on the coordinator's host
 * - `kernel:extension.enabledChanged`    — fire-and-forget event confirming an accepted enable/disable call and the extension's effective state
 * - `kernel:extension.warnings.list`     — RPC listing active health warnings per extension
 * - `kernel:extension.warnings.changed`  — fire-and-forget snapshot after each health-check run
 */
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import { ClientDefinitionSchema, ProviderDefinitionSchema } from '@makaio/contracts';
import { ComponentStateSchema, ExtensionInfoSchema, ExtensionWarningEntrySchema } from './shared-schemas.js';
import { InstalledExtensionCatalogEntrySchema } from './installed-extension-catalog-schemas.js';

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
 * Outcome of one `kernel:extension.setEnabled` request.
 *
 * Mirrors the `TransitionOutcome` union the coordinator's toggle helpers
 * compute internally (see `extension/extension-toggle.ts`) so the bus
 * response can carry the same fidelity instead of collapsing it to a single
 * `success` boolean. `kernel:extension.setEnabled` is persist-only — it never
 * runs a live state-machine transition — so for that RPC this is a
 * comparison between the durably persisted preference and the process's
 * actual runtime state, not the result of an attempted transition:
 * - `'applied'` — the persisted preference already matches the process's
 *   current runtime state; no restart is needed for it to take effect.
 * - `'rejected'` — the request was refused outright without persisting
 *   anything: an unknown extension name, a disable of a `critical` package or
 *   of one whose criticality could not be resolved, or a coordinator already
 *   shutting down. Every such refusal is a *response*, carrying a
 *   {@link SetEnabledReasonSchema} code for which one it was, rather than a
 *   fault — a caller that cannot inspect the host itself must be able to tell
 *   "refused, and here is why" apart from "the call failed".
 *   `TransitionOutcome` is shared with the coordinator-internal
 *   `applyExtensionTransition` primitive, where `'rejected'` additionally
 *   covers a state-machine refusal such as retrying a transition on an entry
 *   the boot phase skipped entirely.
 * - `'restart-required'` — the preference was persisted, but it diverges
 *   from the process's current runtime state; only the next process restart
 *   applies it.
 */
export const TransitionOutcomeSchema = z.enum(['applied', 'rejected', 'restart-required']);

/** Inferred union type for {@link TransitionOutcomeSchema}. */
export type TransitionOutcome = z.infer<typeof TransitionOutcomeSchema>;

/**
 * Machine-readable detail accompanying one `kernel:extension.setEnabled`
 * outcome.
 *
 * The {@link TransitionOutcomeSchema} alone cannot tell a caller *why* a
 * request was refused, or why a persisted preference cannot take effect yet —
 * both of which decide what an operator is told and whether they can act on
 * it. Codes rather than prose so the wording stays with the surface that
 * renders it:
 *
 * Refusals (`'rejected'`, nothing was written):
 * - `'critical'` — a disable targeting a `critical` package. The runtime
 *   force-starts it on every boot regardless of the store, so persisting the
 *   disable would only produce a permanent, ignored entry.
 * - `'criticality-unknown'` — a disable targeting a package whose criticality
 *   could not be resolved, because its server entrypoint could not be read.
 *   Fail-closed: a later boot that *can* read the export might force-start it.
 * - `'not-installed'` — no loaded extension and no installed package carries
 *   this name on this host.
 * - `'no-catalog'` — the name is not loaded here and this runtime exposes no
 *   installed-extension catalog, so it cannot tell a real installed package
 *   apart from a typo and refuses rather than persisting on the caller's word.
 * - `'name-collision'` — more than one installed package claims this name and
 *   the runtime cannot resolve it to a single extension, so the next boot
 *   refuses before any preference is read. A preference written now could
 *   never be acted on, and would silently apply to whichever copy an operator
 *   happens to leave behind.
 * - `'shutting-down'` — the coordinator is tearing down.
 *
 * Persisted, but not in effect (`'restart-required'`, or `'applied'` when the
 * runtime already matches the request):
 * - `'runtime-state-diverges'` — the loaded extension's runtime state differs
 *   from the persisted preference; only a restart reconciles them.
 * - `'not-loaded'` — the package is installed but this process never loaded it
 *   (surface affinity, unmet requirements, or boot-time suppression).
 * - `'framework-package-shadowed'` — a framework package currently holds this
 *   name, so the installed package under it stays shadowed until it no longer
 *   does.
 */
export const SetEnabledReasonSchema = z.enum([
  'critical',
  'criticality-unknown',
  'not-installed',
  'no-catalog',
  'name-collision',
  'shutting-down',
  'runtime-state-diverges',
  'not-loaded',
  'framework-package-shadowed',
]);

/** Inferred union type for {@link SetEnabledReasonSchema}. */
export type SetEnabledReason = z.infer<typeof SetEnabledReasonSchema>;

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
        hashTriggers: z.boolean(),
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
   * Durably record the operator's enablement preference for an extension.
   *
   * Subject: `kernel:extension.setEnabled`
   * Type: RPC (request/response)
   * Purpose: Allows the user or platform config to persist an enable/disable
   * preference for an extension. This is persist-only: the coordinator never
   * applies the change to the running process, because several package
   * contributions are composed exactly once at boot and cannot be replayed
   * for one package in isolation. The response's `outcome` reports whether
   * the process's current runtime state already matches the request
   * (`'applied'`) or a restart is needed for it to take effect
   * (`'restart-required'`).
   *
   * Names this coordinator never loaded are addressable too, provided it
   * exposes an installed-extension catalog (`kernel:extension.catalog`): the
   * request is validated against that catalog — the name must be installed
   * here, and a disable of a `critical` package, or of one whose criticality
   * could not be resolved, is refused — before anything is written. This is
   * what lets a caller that cannot see this host's filesystem persist a
   * preference without having to vouch for the name itself. A name several
   * installed copies claim is resolved against this coordinator's own runtime
   * surface first, since two copies restricted to different surfaces both load
   * — each on its own — and only one of them is the copy this runtime would
   * start; a name that stays unresolvable is refused outright.
   * @param name - Unique extension identifier to toggle.
   * @param enabled - Target enabled state.
   */
  setEnabled: {
    request: z.object({ name: z.string(), enabled: z.boolean() }),
    response: z.object({
      success: z.boolean(),
      outcome: TransitionOutcomeSchema,
      reason: SetEnabledReasonSchema.optional(),
    }),
  },

  /**
   * Request every extension package installed on the host running this
   * coordinator.
   *
   * Subject: `kernel:extension.catalog`
   * Type: RPC (request/response)
   * Purpose: Exposes the coordinator host's own installed-package view —
   * across every discovery tier it reads, including the project-local
   * `node_modules` of the directory it was started from — enriched with the
   * enablement facts only the host holding the durable store can answer.
   * Callers that cannot inspect this host's filesystem (a client configured
   * against a remote bus, or one invoked from a different working directory)
   * have no other way to enumerate installed-but-not-loaded extensions, and
   * `kernel:extension.setEnabled` validates against this same catalog.
   *
   * Returns `{ entries: null }` — not an empty array — when this runtime has
   * no installed-extension catalog at all, because "nothing is installed" and
   * "this host cannot answer" must not read alike to a caller deciding
   * whether to trust the result.
   */
  catalog: {
    request: z.object({}),
    response: z.object({
      entries: z.array(InstalledExtensionCatalogEntrySchema).nullable(),
    }),
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
   * Confirm an accepted enable/disable call and the extension's effective state.
   *
   * Subject: `kernel:extension.enabledChanged`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted whenever the coordinator-internal
   * `applyExtensionTransition` restart primitive accepts an enable/disable
   * request (its outcome is `'applied'`, never `'rejected'`), so observers
   * can learn the extension's effective runtime state without polling. This
   * is **not** a promise that a state transition actually occurred: an
   * idempotent enable-on-`active` or disable-on-`stopped` call is also
   * `'applied'` and also announced here, with `entry.enabled` unchanged.
   * `kernel:extension.setEnabled` does **not** emit this event: that RPC is
   * persist-only and never attempts a live transition (see its own doc
   * above), so a durable preference change whose `outcome` is `'applied'` or
   * `'restart-required'` produces no `enabledChanged` event until whatever
   * coordinator-internal mechanism actually restarts the extension.
   * @param name - Unique extension identifier.
   * @param enabled - The extension's effective enabled state after the call.
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
export const ExtensionNamespace = createBusNamespace('kernel:extension', ExtensionSchemas);

/**
 * Extension subjects for type-safe bus operations.
 *
 * Subjects:
 * - `stateChanged`        — event: emitted when an extension transitions between lifecycle states
 * - `list`                — RPC: retrieve all registered extensions and their current state
 * - `get`                 — RPC: retrieve a single extension's info by name
 * - `setEnabled`          — RPC: persist an operator enable/disable preference
 * - `catalog`             — RPC: list every extension package installed on the coordinator's host
 * - `enabledChanged`      — event: confirms an accepted enable/disable call and the extension's effective state
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
