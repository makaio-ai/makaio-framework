import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IMakaioBus } from '@makaio/bus-core';
import type { Toolset } from '@makaio/tools-core';

/**
 * Collected contributions from worker-local extension packages.
 *
 * Contains the subset of extension contributions relevant to isolated worker
 * processes: toolsets for tool execution. Agent steps spawn subagents to the
 * host, so adapter contributions are not harvested for workers.
 */
export interface WorkerContributions {
  /** Toolsets extracted from loaded packages. */
  readonly toolsets: Toolset[];
}

/**
 * Shape of a loaded extension module that may contribute tools.
 *
 * This is a structural subset of `MakaioExtension` -- workers only harvest
 * toolsets, so we inspect just the `tools` surface without depending on the
 * full extension lifecycle surface.
 */
interface ExtensionModuleShape {
  readonly tools?: {
    readonly createToolsets: (ctx: unknown) => Toolset[];
  };
}

/** Runtime context available while extracting worker-local contributions. */
export interface WorkerContributionLoadOptions {
  /** Worker-local bus instance. */
  readonly bus?: IMakaioBus;
  /** Cancellation signal for worker-local contribution setup. */
  readonly signal?: AbortSignal;
}

/**
 * Determine whether a value looks like a Makaio extension module shape.
 *
 * Checks for an object with at least one contribution surface (`tools` or
 * `adapters`) plus the required `name` field that all MakaioExtension manifests
 * carry. An adapters-only package is still recognized as a valid extension (so
 * it is not warned about), but workers harvest only its toolsets.
 * @param value - Candidate value from a dynamic import.
 * @returns `true` when the value structurally matches an extension module.
 */
function isExtensionShape(value: unknown): value is ExtensionModuleShape & { name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['name'] !== 'string') return false;
  return (typeof obj['tools'] === 'object' && obj['tools'] !== null) || Array.isArray(obj['adapters']);
}

/**
 * Resolve the extension shape from a dynamically imported module.
 *
 * Inspects the module's `default` export first, then falls back to a named
 * export matching the package name (with hyphens removed, camelCase variant).
 * @param mod - ESM module namespace from `import()`.
 * @param packageName - Package name from the manifest (for named-export fallback).
 * @returns The extension shape, or `undefined` when no recognizable export is found.
 */
function resolveExtensionExport(
  mod: Record<string, unknown>,
  packageName: string,
): (ExtensionModuleShape & { name: string }) | undefined {
  // 1. Check default export
  if (isExtensionShape(mod['default'])) {
    return mod['default'];
  }

  // 2. Look for a named export that matches the extension shape
  for (const key of Object.keys(mod)) {
    if (key === 'default') continue;
    if (isExtensionShape(mod[key])) {
      return mod[key];
    }
  }

  // 3. Not found -- fall through to caller diagnostic
  void packageName;
  return undefined;
}

/**
 * Minimal context passed to `tools.createToolsets()` in the worker environment.
 *
 * Workers expose their local bus and cancellation signal, but not the host
 * lifecycle/service registry. Extensions whose toolset factories depend on
 * host-only services should not be listed in the worker contribution manifest.
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns Context object passed to extension toolset factories.
 */
function createWorkerToolsetContext(options?: WorkerContributionLoadOptions): Readonly<Record<string, unknown>> {
  return Object.freeze({
    bus: options?.bus,
    identity: Object.freeze({ extensionName: '__worker__' }),
    dataDir: '',
    machineId: '',
    platform: process.platform,
    homedir: '',
    makaioHome: '',
    username: '',
    signal: options?.signal ?? new AbortController().signal,
    tryImport: async () => null,
    getService: () => {
      throw new Error('Worker-local contribution context does not expose host services.');
    },
    hasExtension: () => false,
  });
}

/**
 * Load worker-local contributions from materializer-verified entrypoints.
 *
 * For each package reference in the manifest, the loader:
 * 1. Dynamic-imports each verified absolute entrypoint
 * 2. Resolves the extension export (default or first matching named export)
 * 3. Extracts toolsets via `pkg.tools.createToolsets()` when available
 *
 * All failures are fatal: import errors, unrecognizable exports, and toolset
 * creation failures throw immediately. Contribution load is fail-closed so
 * workers never start execution with a partial contribution set.
 * @param entrypoints - Absolute worker-local entrypoints verified by a materializer.
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns Combined toolsets from all loaded packages.
 * @throws When any declared package fails to import, export, or create toolsets.
 */
export async function loadWorkerContributions(
  entrypoints: readonly string[],
  options?: WorkerContributionLoadOptions,
): Promise<WorkerContributions> {
  const results = await Promise.all(entrypoints.map((entrypoint) => loadSinglePackage(entrypoint, options)));

  const toolsets: Toolset[] = [];

  for (const result of results) {
    toolsets.push(...result.toolsets);
  }

  return { toolsets };
}

/**
 * Load and extract contributions from a single package reference.
 *
 * All failures are fatal: import errors, unrecognizable exports, and
 * toolset creation failures throw immediately. Workers never proceed
 * with partial contributions.
 * @param entrypoint - Verified absolute path to the contribution entrypoint.
 * @param options - Worker-local runtime surfaces exposed during extraction.
 * @returns Extracted contributions from the package.
 * @throws When the package cannot be imported, has no recognizable export, or toolset creation fails.
 */
async function loadSinglePackage(
  entrypoint: string,
  options?: WorkerContributionLoadOptions,
): Promise<{ toolsets: Toolset[] }> {
  if (!path.isAbsolute(entrypoint)) {
    throw new Error(`Worker contribution entrypoint must be an absolute materialized path: ${entrypoint}`);
  }
  const importSpecifier = pathToFileURL(entrypoint).href;
  const mod = (await import(importSpecifier)) as Record<string, unknown>;

  const ext = resolveExtensionExport(mod, entrypoint);
  if (!ext) {
    throw new Error(
      `No recognizable extension export in "${entrypoint}". ` +
        `Expected a default export or named export with a "name" field and "tools" or "adapters" surface.`,
    );
  }

  const packageToolsets: Toolset[] = [];

  if (ext.tools?.createToolsets) {
    const created = ext.tools.createToolsets(createWorkerToolsetContext(options));
    packageToolsets.push(...created);
  }

  return { toolsets: packageToolsets };
}
