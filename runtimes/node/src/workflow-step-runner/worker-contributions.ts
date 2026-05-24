import type { AdapterContribution } from '@makaio/contracts';
import type { Toolset } from '@makaio/tools-core';
import type { WorkerContributionManifest, WorkerContributionPackageRef } from './types.js';

/**
 * Collected contributions from worker-local extension packages.
 *
 * Contains the subset of extension contributions relevant to isolated worker
 * processes: toolsets for tool execution and adapter definitions for model
 * routing.
 */
export interface WorkerContributions {
  /** Toolsets extracted from loaded packages. */
  readonly toolsets: Toolset[];
  /** Adapter contributions extracted from loaded packages. */
  readonly adapters: AdapterContribution[];
}

/**
 * Shape of a loaded extension module that may contribute tools and adapters.
 *
 * This is a structural subset of `MakaioExtension` -- we only inspect the
 * fields relevant to worker-local contributions without depending on the full
 * extension lifecycle surface.
 */
interface ExtensionModuleShape {
  readonly tools?: {
    readonly createToolsets: (ctx: unknown) => Toolset[];
  };
  readonly adapters?: readonly AdapterContribution[];
}

/**
 * Determine whether a value looks like a Makaio extension module shape.
 *
 * Checks for an object with at least one contribution surface (`tools` or
 * `adapters`) plus the required `name` field that all MakaioExtension manifests
 * carry.
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
 * Workers do not have access to the full extension lifecycle (bus, services,
 * signal, etc.). This stub satisfies the `NodeExtensionContext` parameter
 * signature at the type level while providing safe no-op values. Extensions
 * whose toolset factories depend on runtime services should not be listed in
 * the worker contribution manifest.
 */
const WORKER_TOOLSET_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({
  bus: undefined,
  identity: Object.freeze({ extensionName: '__worker__' }),
  dataDir: '',
  machineId: '',
  platform: process.platform,
  homedir: '',
  makaioHome: '',
  username: '',
  signal: new AbortController().signal,
  tryImport: async () => null,
  getService: () => undefined,
  hasExtension: () => false,
});

/**
 * Load worker-local contributions from the packages declared in a manifest.
 *
 * For each package reference in the manifest, the loader:
 * 1. Dynamic-imports the `importPath`
 * 2. Resolves the extension export (default or first matching named export)
 * 3. Extracts toolsets via `pkg.tools.createToolsets()` when available
 * 4. Collects adapter contributions from `pkg.adapters` when available
 *
 * Packages that fail to import or whose exports are unrecognizable emit a
 * diagnostic warning and are skipped -- the loader does not throw for
 * individual package failures.
 * @param manifest - Serializable manifest declaring which packages to load.
 * @returns Combined toolsets and adapter contributions from all loaded packages.
 */
export async function loadWorkerContributions(manifest: WorkerContributionManifest): Promise<WorkerContributions> {
  const results = await Promise.all(manifest.packages.map(loadSinglePackage));

  const toolsets: Toolset[] = [];
  const adapters: AdapterContribution[] = [];

  for (const result of results) {
    if (result) {
      toolsets.push(...result.toolsets);
      adapters.push(...result.adapters);
    }
  }

  return { toolsets, adapters };
}

/**
 * Load and extract contributions from a single package reference.
 * @param pkgRef - Package reference with name and import path.
 * @returns Extracted contributions, or `undefined` when the package cannot be loaded.
 */
async function loadSinglePackage(
  pkgRef: WorkerContributionPackageRef,
): Promise<{ toolsets: Toolset[]; adapters: AdapterContribution[] } | undefined> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkgRef.importPath)) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker-contributions] Failed to import "${pkgRef.name}" from "${pkgRef.importPath}": ${message}`);
    return undefined;
  }

  const ext = resolveExtensionExport(mod, pkgRef.name);
  if (!ext) {
    console.warn(`[worker-contributions] No recognizable extension export in "${pkgRef.name}" (${pkgRef.importPath})`);
    return undefined;
  }

  const packageToolsets: Toolset[] = [];
  const packageAdapters: AdapterContribution[] = [];

  // Extract toolsets
  if (ext.tools?.createToolsets) {
    try {
      const created = ext.tools.createToolsets(WORKER_TOOLSET_CONTEXT);
      packageToolsets.push(...created);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[worker-contributions] createToolsets() failed for "${pkgRef.name}": ${message}`);
    }
  }

  // Extract adapters
  if (ext.adapters) {
    packageAdapters.push(...ext.adapters);
  }

  return { toolsets: packageToolsets, adapters: packageAdapters };
}
