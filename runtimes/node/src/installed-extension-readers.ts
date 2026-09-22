/**
 * Readers that enumerate the executable packages an installed extension's
 * server entrypoint exports.
 *
 * Two hosts ask this question with opposite constraints, which is why it is a
 * seam rather than one implementation:
 *
 * - A short-lived command process imports on its own module registry. There is
 *   no cross-call cache to go stale inside a process that exits right after,
 *   so the first import is always current and a worker's isolation overhead
 *   buys nothing.
 * - A long-lived runtime cannot do that: Node caches ESM modules by resolved
 *   URL, so a second read for the same path after an in-place reinstall would
 *   keep returning the pre-update module. It reads through the isolated import
 *   worker instead, which owns a fresh module registry per call.
 *
 * Both answer with the same contract, so everything downstream — the tier
 * scan, the criticality rules, the enablement decisions built on them — is
 * identical regardless of which process is asking.
 *
 * A host that statically imported its extensions at build time needs neither
 * reader: it already holds the module, and
 * {@link readExportedPackagesFromModule} normalizes it through the same
 * contract without loading anything.
 * @packageDocumentation
 */
import { pathToFileURL } from 'node:url';
import type { ExportedPackageListing } from '@makaio/services-package-manager';
import { normalizePackageExport } from './load-extensions.js';

export type { ExportedPackageListing };

/** The one installed package a reader is asked to inspect. */
export interface ExportedPackagesTarget {
  /** Absolute, already-resolved import path for the descriptor's server entrypoint. */
  readonly serverImportPath: string;
  /**
   * Descriptor identity the export is anchored against: one exported package
   * must carry it, every other must be dot-prefixed under it. Never the npm
   * dependency identifier.
   */
  readonly descriptorName: string;
  /** Log prefix identifying the caller and extension for warnings. */
  readonly label: string;
}

/**
 * Enumerate the executable packages one installed extension exports.
 *
 * Resolves to `undefined` — never to an empty listing — when the export could
 * not be read at all: a missing or unreadable entrypoint, a failed import, or
 * an export that violates the runtime's identity contract. Callers rely on
 * that distinction to tell "this descriptor has no exported package" apart
 * from "this descriptor's package could not be inspected", which decides
 * whether an absent `critical` flag means "not critical" or "unknown". A
 * broken extension must never abort the surrounding scan.
 */
export type ExportedPackagesReader = (target: ExportedPackagesTarget) => Promise<ExportedPackageListing | undefined>;

/**
 * Validate that an exported package's `critical` field is either absent or a
 * genuine `boolean`.
 *
 * {@link normalizePackageExport}'s structural check only requires `name`,
 * `displayName`, and `version` to be strings — it never inspects `critical`,
 * so a malformed export (e.g. `critical: 'yes'`) still passes it. Left
 * unchecked, that value would flow into a flag every consumer downstream
 * treats as a trustworthy `boolean`.
 * @param value - Candidate `critical` value read off an exported package.
 * @returns Whether `value` is safe to report as `critical`.
 */
function isValidExportedCriticalFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Narrow an exported package's `surface` declaration to a single concrete
 * runtime surface.
 *
 * Mirrors the coordinator's own gate: a package loads everywhere unless it
 * names exactly one surface. `'any'`, an absent value, and anything the schema
 * would have rejected therefore collapse to `undefined` — "not restricted" —
 * rather than being reported as a restriction this process invented.
 * @param value - Candidate `surface` value read off an exported package.
 * @returns The single surface the package is restricted to, or `undefined`.
 */
export function toRestrictedSurface(value: unknown): 'interactive' | 'headless' | undefined {
  return value === 'interactive' || value === 'headless' ? value : undefined;
}

/**
 * Read an extension's exported packages by importing its server entry on this
 * process's own module registry.
 *
 * Applies {@link normalizePackageExport} — the same identity contract the
 * runtime applies at boot — so a package is only reported when the loader
 * would also accept it. The import executes the module's top-level code; the
 * extension server-module contract requires that top level to contain only
 * declarations, with side effects deferred to `create()`/`init()`, which this
 * never calls.
 *
 * Because the import runs on this process's registry, an extension installed
 * outside this process's module tree only resolves its `@makaio/framework/*`
 * imports while the host's module resolver hook is installed — see
 * `scanInstalledExtensions`'s `frameworkModuleResolver` option, which owns
 * that window.
 * @param target - The installed package to inspect.
 * @returns Its exported packages, or `undefined` when the export is unreadable.
 */
export const readExportedPackagesInProcess: ExportedPackagesReader = async (target) => {
  const { serverImportPath, descriptorName, label } = target;
  let defaultExport: unknown;
  try {
    defaultExport = ((await import(pathToFileURL(serverImportPath).href)) as { readonly default: unknown }).default;
  } catch (error) {
    console.warn(
      `${label}: failed to import server entry while reading its exported packages:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }

  return readExportedPackagesFromModule(defaultExport, descriptorName, label);
};

/**
 * Enumerate the executable packages an *already loaded* server entry module
 * exports.
 *
 * The reader seam exists to decide how a module gets loaded — on this
 * process's registry or inside an isolated worker. A host that statically
 * imported its extensions at build time has already answered that question:
 * the module object it carries is the one the loader itself uses, so there is
 * nothing left to import and no stale module cache to defeat. Both readers
 * funnel their loaded export through this same normalization, so the identity
 * contract and the `critical` sanitization below are applied exactly once,
 * whatever produced the module.
 * @param defaultExport - Default export of the server entry module.
 * @param descriptorName - Descriptor identity the export must be anchored to.
 * @param label - Log prefix identifying the caller and extension for warnings.
 * @returns The exported packages, or `undefined` when the export violates the
 *   runtime's identity contract.
 */
export function readExportedPackagesFromModule(
  defaultExport: unknown,
  descriptorName: string,
  label: string,
): ExportedPackageListing | undefined {
  const normalized = normalizePackageExport(defaultExport, descriptorName, label);
  if (normalized === undefined) return undefined;
  // Widened deliberately: the normalized package type declares `critical` as a
  // boolean and `surface` as a closed union, but nothing has verified either
  // yet — the checks below are what make those types true, so they must see
  // the raw values.
  const packages: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly critical?: unknown;
    readonly surface?: unknown;
  }> = normalized;

  // Strip a non-boolean `critical` rather than let it masquerade as a resolved
  // flag downstream, and record its name so the caller reports that specific
  // package as unresolved instead of legitimately non-critical.
  const invalidCriticalNames = new Set<string>();
  const sanitized = packages.map((pkg) => {
    const surface = toRestrictedSurface(pkg.surface);
    const base = { name: pkg.name, version: pkg.version, ...(surface !== undefined && { surface }) };
    if (isValidExportedCriticalFlag(pkg.critical)) {
      return pkg.critical === undefined ? base : { ...base, critical: pkg.critical };
    }
    invalidCriticalNames.add(pkg.name);
    console.warn(
      `${label}: exported package '${pkg.name}' declares 'critical' as ${typeof pkg.critical}, not a boolean; ` +
        'treating criticality as unresolved',
    );
    return base;
  });
  return { packages: sanitized, invalidCriticalNames };
}

/**
 * Build a reader that imports each server entry inside an isolated worker
 * thread, for a long-lived process that must not serve a module-cached answer.
 * @param frameworkDistPath - Absolute path to the assembled `@makaio/framework`
 *   dist when this host resolves `@makaio/framework/*` through a module
 *   resolver hook. The worker owns a separate loader context, so it mirrors
 *   that hook itself; omit it for hosts that resolve those specifiers
 *   natively.
 * @returns A reader backed by the isolated import worker.
 */
export function createWorkerExportedPackagesReader(frameworkDistPath?: string): ExportedPackagesReader {
  return async (target) => {
    // Imported lazily: the package manager pulls in the Yarn toolchain, which
    // a scan should not load until it actually has an entrypoint to read.
    const { resolveExportedPackages } = await import('@makaio/services-package-manager');
    return resolveExportedPackages(target.serverImportPath, target.descriptorName, target.label, frameworkDistPath);
  };
}
