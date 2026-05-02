import path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionToken, NodeExtensionContext } from '@makaio/contracts';
import { resolveConfig } from './resolve-config.js';
import type { ExtensionEntry } from './types.js';

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
    | Omit<NodeExtensionContext, 'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'>
    | undefined;
  /** Optional stored-config loader keyed by extension name. */
  readonly loadConfig: ((name: string) => Record<string, unknown> | undefined) | undefined;
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
 * Resolve config for an extension entry from descriptor defaults and stored config.
 *
 * Cannot throw: both the `loadConfig` callback and the Zod parse inside
 * `resolveConfig` are guarded. A failing config loader or invalid stored
 * config yields `undefined`, matching the "no schema" path.
 * @param host - Coordinator surface providing config loading.
 * @param name - Extension name used in validation errors.
 * @param entry - Extension entry whose config is being resolved.
 * @returns Parsed config object, or `undefined` when no schema is declared.
 */
export function resolveExtensionEntryConfig(host: ExtensionContextHost, name: string, entry: ExtensionEntry): unknown {
  let storedConfig: Record<string, unknown> | undefined;
  if (entry.pkg.configSchema) {
    try {
      storedConfig = host.loadConfig?.(name);
    } catch (err) {
      console.error(`[ExtensionCoordinator] loadConfig threw for "${name}":`, err);
    }
  }
  return resolveConfig(name, entry.pkg.configSchema, entry.configDefaults, storedConfig);
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
): NodeExtensionContext {
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
