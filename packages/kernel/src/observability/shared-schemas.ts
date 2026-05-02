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
  /** Whether this extension is currently enabled by the user or platform config. */
  enabled: z.boolean(),
  /** Browser entry point declared by the package manifest, if any. */
  browser: BrowserEntrypointSchema.optional(),
});

/** Inferred type for a managed extension info record. */
export type ExtensionInfo = z.infer<typeof ExtensionInfoSchema>;

export { ExtensionWarningEntrySchema, type ExtensionWarningEntry } from '@makaio/contracts/extension';
