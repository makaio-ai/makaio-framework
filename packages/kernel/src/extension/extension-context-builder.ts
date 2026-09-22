import path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { EXTENSION_DATA_DIR_SEGMENT, encodeExtensionNameAsPathSegment } from '@makaio/contracts';
import type { ExtensionOperatorConfigSource, ExtensionToken } from '@makaio/contracts';
import {
  type ExtensionConfigResolution,
  type ExtensionConfigResolutionMode,
  resolveConfigOutcome,
} from './resolve-config.js';
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
  return resolveExtensionEntryConfigOutcome(host, name, entry, mode).config;
}

/**
 * Resolve config for an extension entry and report how the result was reached.
 *
 * The same resolution as {@link resolveExtensionEntryConfig} — same layers,
 * same containment of a throwing `loadConfig`, same mode semantics — returning
 * the full {@link ExtensionConfigResolution} instead of only its config. A
 * caller that reports configuration to a human needs the distinction: after a
 * rejected merge, the config object is the schema's defaults with every layer
 * discarded, which is not what the extension is configured with.
 * @param host - Coordinator surface providing config loading.
 * @param name - Extension name used in validation errors.
 * @param entry - Extension entry whose config is being resolved.
 * @param mode - `'activate'` when the caller can fail the extension in response,
 *   `'observe'` when it is only reading.
 * @returns The resolution for this entry.
 * @throws ExtensionOperatorConfigError In `'activate'` mode, when the operator
 *   layer holds an unusable entry for this extension, or is what makes the
 *   configuration it produces fail the extension's config schema.
 */
export function resolveExtensionEntryConfigOutcome(
  host: ExtensionContextHost,
  name: string,
  entry: ExtensionEntry,
  mode: ExtensionConfigResolutionMode,
): ExtensionConfigResolution {
  let storedConfig: Record<string, unknown> | undefined;
  if (entry.pkg.configSchema) {
    try {
      storedConfig = host.loadConfig?.(name);
    } catch (err) {
      console.error(`[ExtensionCoordinator] loadConfig threw for "${name}":`, err);
    }
  }
  return resolveConfigOutcome({
    name,
    configSchema: entry.pkg.configSchema,
    configDefaults: entry.configDefaults,
    storedConfig,
    operatorEntry: host.operatorConfig?.get(name),
    mode,
  });
}

/**
 * Check whether an extension's name can be encoded as a filesystem path segment.
 *
 * This is the single source of truth for the eager "addressable data
 * directory" pre-flight check shared by every seam that can move an extension
 * entry toward `active` state without necessarily calling
 * {@link buildExtensionContext} first: `startExtensionEntry`'s pre-flight check
 * during boot, and `enableExtension`'s pre-flight check during
 * `kernel:extension.setEnabled(true)`. Both call sites go through this one
 * predicate and message, so the boot path and the re-enable path cannot drift
 * apart. {@link buildExtensionContext} keeps its own equivalent check (it also
 * needs the encoded segment value, not just a pass/fail) as a defense-in-depth
 * throw for callers that reach it directly, such as `forEachActiveExtension`
 * and `forExtension`.
 * @param extensionName - Extension name to validate.
 * @returns An error message describing why the name is unaddressable, or
 *   `undefined` when the name encodes to a valid path segment.
 */
export function checkExtensionNameAddressable(extensionName: string): string | undefined {
  if (encodeExtensionNameAsPathSegment(extensionName) !== undefined) return undefined;
  return (
    `Extension "${extensionName}" cannot be encoded as a filesystem path segment ` +
    `and therefore has no addressable data directory. ` +
    `Valid extension names must be non-empty, must not be '.' or '..', must be well-formed ` +
    `Unicode, must not be a reserved Windows device basename (CON, NUL, COM1, etc.), ` +
    `and must encode within the filesystem component length limit.`
  );
}

/**
 * Build a {@link NodeExtensionContext} for extension create/storage lifecycles.
 *
 * The `dataDir` is resolved to `<makaioHome>/data/<encoded>` where `<encoded>`
 * is the percent-encoded form of the extension name produced by
 * {@link encodeExtensionNameAsPathSegment}. Encoding keeps each extension in a
 * single directory component that is safe on every supported filesystem and
 * cannot collide with reserved top-level names under the Makaio home.
 *
 * An unencodable name (empty, a dot segment, non-well-formed Unicode, or an
 * encoded form too long for a filesystem component) is a hard error: the
 * manifest schema makes these names unreachable in practice, but if one
 * somehow arrives the extension cannot be given a unique, safe `dataDir` and
 * must not start. Call sites isolate the failure per-extension (the entry
 * transitions to `failed`; only critical extensions escalate to boot abort).
 * @param host - Coordinator surface providing bus, platform context, and service lookup.
 * @param entry - Extension entry receiving the context.
 * @param config - Optional resolved config.
 * @returns Full extension context.
 * @throws Error when `extensionContextBase` is absent.
 * @throws Error when the extension name cannot be encoded as a filesystem path segment.
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
  const { extensionName } = entry.identity;
  const segment = encodeExtensionNameAsPathSegment(extensionName);
  if (segment === undefined) {
    // startExtensionEntry and enableExtension both validate name addressability
    // eagerly (via checkExtensionNameAddressable) before any lifecycle
    // transition, so this throw is the safety net for callers that skip both
    // start paths (e.g. direct coordinator construction in tests). It is NOT
    // the primary enforcement point — do not remove either eager check on the
    // assumption that this throw covers all call sites; forEachActiveExtension
    // and forExtension call buildExtensionContext outside per-extension
    // isolation and an unencodable name there would propagate to the caller
    // rather than failing the entry.
    throw new Error(
      `ExtensionCoordinator: extension "${extensionName}" cannot be encoded as a filesystem path segment ` +
        `and therefore has no addressable data directory. ` +
        `Valid extension names must be non-empty, must not be '.' or '..', must be well-formed Unicode, ` +
        `must not be a reserved Windows device basename (CON, NUL, COM1, etc.), and must encode ` +
        `within the filesystem component length limit.`,
    );
  }
  return {
    ...host.extensionContextBase,
    bus: host.bus,
    identity: entry.identity,
    dataDir: path.join(host.extensionContextBase.makaioHome, EXTENSION_DATA_DIR_SEGMENT, segment),
    getService: <T>(token: ExtensionToken<T>): T | undefined => host.getExtensionService(token.name),
    signal: host.signal,
    hasExtension: host.hasActiveExtension,
    ...(config !== undefined ? { config } : {}),
  };
}
