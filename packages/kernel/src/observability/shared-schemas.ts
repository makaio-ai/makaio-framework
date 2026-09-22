/**
 * Shared observability schemas for services and extensions.
 *
 * Pure Zod schemas — no bus registration, no side effects.
 * The `kernel:extension.*` namespace derives its info
 * shapes from the base schemas defined here.
 */
import { z } from 'zod';
import { BrowserEntrypointSchema } from '@makaio/contracts';

/**
 * Lifecycle states shared across all managed components (services and extensions).
 *
 * State machine:
 * - `discovered`   — component is registered but not yet started
 * - `initializing` — component startup is in progress
 * - `active`       — component is running normally
 * - `failed`       — component encountered a fatal error during startup or operation
 * - `skipped`      — component was intentionally bypassed (e.g. feature-gated)
 * - `stopped`      — component has been cleanly shut down
 *
 * Note: `importing` is intentionally absent — it is an internal coordinator
 * detail, not an externally observable state.
 */
export const ComponentStateSchema = z.enum(['discovered', 'initializing', 'active', 'failed', 'skipped', 'stopped']);

/** Inferred union of all valid component lifecycle states. */
export type ComponentState = z.infer<typeof ComponentStateSchema>;

/**
 * Shared identity fields present on every managed component.
 *
 * Both service info and extension info extend this schema so all
 * observability consumers have a uniform identity contract.
 */
export const ComponentIdentitySchema = z.object({
  /** Unique machine-readable identifier for the component. */
  name: z.string(),
  /** Human-readable label used in UI and logs. */
  displayName: z.string(),
});

/**
 * Full info shape shared by {@link ServiceInfoSchema} and
 * {@link ExtensionInfoSchema} responses.
 *
 * Consumers that only need identity + state can accept this base type.
 */
export const ComponentInfoSchema = ComponentIdentitySchema.extend({
  /** Current lifecycle state of the component. */
  state: ComponentStateSchema,
  /** Human-readable error message, present only when `state` is `'failed'`. */
  error: z.string().optional(),
});

/** Inferred type for a generic managed component info record. */
export type ComponentInfo = z.infer<typeof ComponentInfoSchema>;

/**
 * Info shape for a managed service.
 *
 * Extends {@link ComponentInfoSchema} with a `critical` flag that signals
 * whether a service failure should abort the boot sequence.
 */
export const ServiceInfoSchema = ComponentInfoSchema.extend({
  /**
   * When `true`, a `'failed'` state for this service causes the entire
   * application to abort startup.
   */
  critical: z.boolean(),
});

/** Inferred type for a platform service info record. */
export type ServiceInfo = z.infer<typeof ServiceInfoSchema>;

/**
 * Info shape for a managed extension.
 *
 * Extends {@link ComponentInfoSchema} with extension-specific fields for
 * surface affinity and enable/disable state.
 */
export const ExtensionInfoSchema = ComponentInfoSchema.extend({
  /**
   * Runtime surface affinity for this extension.
   *
   * - `'interactive'` — only loaded in interactive (UI) runtimes
   * - `'headless'`    — only loaded in headless (server) runtimes
   * - `'any'`         — loaded in all runtimes
   *
   * `undefined` is equivalent to `'any'`.
   */
  surface: z.enum(['interactive', 'headless', 'any']).optional(),
  /**
   * Whether this extension's runtime entry is currently enabled.
   *
   * Set once at boot (from the durable preference, with the `critical`
   * override applied) and only ever changed afterwards by a real state
   * transition — the coordinator-internal `applyExtensionTransition`
   * primitive. `kernel:extension.setEnabled` never changes it: that RPC is
   * persist-only, so this flag can read stale relative to the durable
   * preference after a `setEnabled` call whose `outcome` was
   * `'restart-required'` — the preference file already reflects the request,
   * this flag reflects the process's actual runtime state until the next
   * restart catches up.
   */
  enabled: z.boolean(),
  /**
   * Whether this extension's enablement is operator-managed.
   *
   * `true` for a descriptor-based extension package: its enable/disable
   * preference is read from and written to the durable enablement store
   * (`loadEnabled` / `persistEnabled` / `kernel:extension.setEnabled`).
   * `false` for a framework package — the coordinator loads it
   * unconditionally, `kernel:extension.setEnabled` refuses to toggle it, and
   * `persistedEnabled` below is always `undefined` for it, because there is
   * no durable preference to report.
   *
   * A caller building an enable/disable control (onboarding, the CLI's
   * `extensions` command, a settings surface) reads this field to decide
   * whether to offer the control at all, rather than discovering the
   * refusal only after attempting the RPC.
   */
  extensionManaged: z.boolean(),
  /**
   * The durable enablement preference, read live from the coordinator's
   * `loadEnabled` callback at snapshot time (`kernel:extension.list` /
   * `kernel:extension.get`) — not a copy of `enabled` and not subject to the
   * `critical` override below.
   *
   * Contrast with `enabled`: `enabled` is the *runtime* state and can lag
   * this preference until the next restart, because `setEnabled` is
   * persist-only (see `enabled`'s own doc). This field is the preference
   * itself as currently recorded, so a hand-disabled `critical` extension —
   * which the coordinator force-starts regardless of the store — reports
   * `enabled: true` alongside `persistedEnabled: false`. A caller such as
   * onboarding that seeds *new* choices from an existing snapshot must read
   * this field, not `enabled`, or it will silently discard a durable disable
   * whose runtime effect has not caught up yet.
   *
   * `undefined` when the coordinator was built without a `loadEnabled`
   * reader at all (for example an isolated, headless runtime with no durable
   * enablement store), or when `extensionManaged` is `false` — neither case
   * has a durable preference to report, which is a different answer from
   * either `true` or `false`.
   */
  persistedEnabled: z.boolean().optional(),
  /**
   * When `true`, the runtime cannot function without this extension: a disable
   * request is refused, and a disabled entry in the enablement store is
   * overridden at boot. Surfaces that offer an enable/disable control read this
   * flag so they can refuse the same requests the runtime refuses.
   */
  critical: z.boolean(),
  /** Browser entry point declared by the package manifest, if any. */
  browser: BrowserEntrypointSchema.optional(),
});

/** Inferred type for a managed extension info record. */
export type ExtensionInfo = z.infer<typeof ExtensionInfoSchema>;

export { ExtensionWarningEntrySchema, type ExtensionWarningEntry } from '@makaio/contracts/extension';
