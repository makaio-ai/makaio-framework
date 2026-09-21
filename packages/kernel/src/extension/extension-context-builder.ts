import path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionOperatorConfigSource, ExtensionToken } from '@makaio/contracts';
import { type ExtensionConfigResolutionMode, resolveConfig } from './resolve-config.js';
import type { ExtensionEntry, KernelExtensionContext } from './types.js';

/**
 * Coordinator surface required to resolve extension config and create extension contexts.
 *
 * Static Node host fields are passed in via `extensionContextBase`. Coordinator-owned
 * lifecycle fields (`signal` and `hasActiveExtension`) are provided directly so the
 * coordinator can wire them to its own shutdown sequence and entry map.
 */
export interface ExtensionContextHost {
  /** Bus instance exposed to extensions. */
  readonly bus: IMakaioBus;
  /**
   * Node platform/user context supplied by the composition root.
   *
   * Omits coordinator-owned fields (`config`, `signal`, `hasExtension`) that
   * are assembled by `buildExtensionContext` from the host interface.
   */
  readonly extensionContextBase:
    | Omit<KernelExtensionContext, 'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'>
    | undefined;
  /** Optional stored-config loader keyed by extension name. */
  readonly loadConfig: ((name: string) => Record<string, unknown> | undefined) | undefined;
  /**
   * Optional operator-owned configuration layer keyed by extension name.
   *
   * Consulted on every resolution so a stopped-and-restarted extension sees
   * exactly the configuration it started with.
   */
  readonly operatorConfig: ExtensionOperatorConfigSource | undefined;
  /**
   * Abort signal triggered when the coordinator begins graceful shutdown.
   *
   * Forwarded directly into each {@link NodeExtensionContext} so extensions can cancel
   * long-running operations when the runtime stops.
   */
  readonly signal: AbortSignal;
  /**
   * Check whether an extension with the given name has reached `active` state.
   *
   * Forwarded into each {@link NodeExtensionContext} as `hasExtension` so extensions can
   * perform optional integration checks without requiring an `ExtensionToken`.
   * @param name - Extension name to check.
   * @returns `true` when the named extension is active.
   */
  readonly hasActiveExtension: (name: string) => boolean;
  /**
   * Retrieve an active extension service by name.
   * @param name - Extension name.
   * @returns Active service instance, or `undefined` when unavailable.
   */
  getExtensionService<T>(name: string): T | undefined;
}

/**
 * Resolve config for an extension entry from every configuration layer.
 *
 * The single resolution point for the whole extension lifecycle — startup,
 * re-enable, contribution processing, and active-extension iteration all route
 * through it, so every caller composes the same layers in the same order.
 *
 * A `loadConfig` callback that throws is always contained here and reported as
 * absent stored config. Everything else is governed by `mode`:
 *
 * - `'activate'` lets an operator-attributed failure propagate as
 *   {@link ExtensionOperatorConfigError}. Callers in this mode drive a lifecycle
 *   transition and must route it into their existing failure handling, so the
 *   extension's declared criticality decides between failing it alone and
 *   aborting startup.
 * - `'observe'` never throws. Callers in this mode are reading an extension
 *   whose lifecycle they do not drive, and an exception would abandon the read —
 *   for an iteration, skipping every extension after the offending one.
 *
 * The mode is required rather than defaulted because getting it wrong is
 * silent in both directions, and there is no safe default: defaulting to
 * `'activate'` would let a read abort an iteration, and defaulting to
 * `'observe'` would let a broken operator entry start an extension anyway.
 *
 * Whether a resolution is operator-attributed is **not** a stable property of
 * an extension. `entry.configDefaults` is fixed at load time and an
 * `ExtensionOperatorConfigSource` is contractually stable, but stored config is
 * not: the storage tier may answer differently on every call. A record that
 * parses on its own yet conflicts with the operator layer — through a
 * cross-field rule, or an unknown key rejected by a strict schema — makes the
 * very same extension operator-attributed on one call and not on the next.
 * That is exactly why an active extension may still resolve to a failure, and
 * why read-only callers resolve in `'observe'` mode.
 * @param host - Coordinator surface providing config loading.
 * @param name - Extension name used in validation errors.
 * @param entry - Extension entry whose config is being resolved.
 * @param mode - `'activate'` when the caller can fail the extension in response,
 *   `'observe'` when it is only reading.
 * @returns Parsed config object, or `undefined` when no schema is declared.
 * @throws ExtensionOperatorConfigError In `'activate'` mode, when the operator
 *   layer holds an unusable entry for this extension, or is what makes the
 *   configuration it produces fail the extension's config schema.
 */
export function resolveExtensionEntryConfig(
  host: ExtensionContextHost,
  name: string,
  entry: ExtensionEntry,
  mode: ExtensionConfigResolutionMode,
): unknown {
  let storedConfig: Record<string, unknown> | undefined;
  if (entry.pkg.configSchema) {
    try {
      storedConfig = host.loadConfig?.(name);
    } catch (err) {
      console.error(`[ExtensionCoordinator] loadConfig threw for "${name}":`, err);
    }
  }
  return resolveConfig({
    name,
    configSchema: entry.pkg.configSchema,
    configDefaults: entry.configDefaults,
    storedConfig,
    operatorEntry: host.operatorConfig?.get(name),
    mode,
  });
}

/**
 * Build a {@link NodeExtensionContext} for extension create/storage lifecycles.
 * @param host - Coordinator surface providing bus, platform context, and service lookup.
 * @param entry - Extension entry receiving the context.
 * @param config - Optional resolved config.
 * @returns Full extension context.
 * @throws Error when `extensionContextBase` is absent.
 */
export function buildExtensionContext(
  host: ExtensionContextHost,
  entry: ExtensionEntry,
  config?: unknown,
): KernelExtensionContext {
  if (!host.extensionContextBase) {
    throw new Error(
      'ExtensionCoordinator: extensionContextBase is required to start extensions with a create factory. ' +
        'Provide it via the constructor.',
    );
  }
  return {
    ...host.extensionContextBase,
    bus: host.bus,
    identity: entry.identity,
    dataDir: path.join(host.extensionContextBase.makaioHome, entry.identity.extensionName),
    getService: <T>(token: ExtensionToken<T>): T | undefined => host.getExtensionService(token.name),
    signal: host.signal,
    hasExtension: host.hasActiveExtension,
    ...(config !== undefined ? { config } : {}),
  };
}
