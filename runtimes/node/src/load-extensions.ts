import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionSatisfies } from '@makaio/contracts';
import type { MakaioExtension } from '@makaio/contracts';
import type { CliContribution, CliSubcommandEntry } from '@makaio/kernel/cli';
import { descriptorToBasePackage } from './descriptor-to-package.js';
import type { DiscoveredExtension } from './extension-discovery.js';

/**
 * Options for {@link loadExtensions}.
 */
export interface LoadExtensionsOptions {
  /** Current framework version for framework range gating. */
  readonly frameworkVersion: string;
  /**
   * Override for filesystem-based dynamic import — used in tests and dev hosts.
   * @param entryPath - Absolute path to the extension entry module.
   * @returns Module with a default export.
   */
  readonly importModule?: (entryPath: string) => Promise<{ default: unknown }>;
}

/** Options for descriptor-backed CLI contribution loading. */
export type AttachExtensionCliContributionsOptions = Pick<LoadExtensionsOptions, 'importModule' | 'frameworkVersion'>;

/**
 * Result returned by {@link loadExtensions}.
 */
export interface ExtensionLoadResult {
  /** Successfully loaded packages ready for `coordinator.load()`. */
  readonly packages: MakaioExtension[];
  /**
   * Config defaults from descriptors, keyed by extension name.
   *
   * Populated from `descriptor.config.defaults` for each successfully loaded
   * extension. Passed to `coordinator.load()` as the `configDefaults` argument
   * so the coordinator can merge them with stored config at startup.
   */
  readonly configDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Result returned by {@link attachExtensionCliContributions}.
 */
export interface ExtensionCliAttachResult {
  /** Packages augmented or synthesized with executable CLI contributions. */
  readonly packages: MakaioExtension[];
  /**
   * Config defaults from descriptors of CLI-only synthesized packages, keyed
   * by extension name.
   *
   * Populated from `descriptor.config.defaults` for each CLI-only package
   * synthesized during this pass (i.e. packages with no server entrypoint).
   * Passed to `coordinator.load()` alongside server-entry and browser-only
   * defaults so the coordinator merges them at startup.
   */
  readonly configDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Packages emitted by one descriptor, ordered by caller-defined source priority.
 */
export interface DescriptorSourcePackageGroup {
  /** Descriptor name whose executable package surface this group represents. */
  readonly descriptorName: string;
  /** Stable source label for diagnostics, such as `workspace-descriptors`. */
  readonly descriptorSource: string;
  /** Packages produced from this descriptor. */
  readonly packages: ReadonlyArray<MakaioExtension>;
}

/**
 * Load extensions by importing their server entry points.
 *
 * For each discovered extension:
 * 1. Check `makaio.framework` range against the current framework version
 * 2. If `execution` is `'detached'`, synthesize a managed {@link MakaioExtension}
 *    via {@link createDetachedExtensionPackage} and continue.
 * 3. Resolve `entrypoints.server` to an absolute path
 * 4. Dynamic `import()` the module
 * 5. Validate the default export looks like a {@link MakaioExtension} or
 *    {@link MakaioExtension} array
 * 6. Verify the imported package identity is anchored to the descriptor name
 *
 * Extensions that fail any step are skipped with a warning. This function
 * never throws — boot continues even if all extensions fail.
 * @param discovered - Extensions found by a {@link ExtensionDiscovery}.
 * @param options - Framework version and optional import override.
 * @returns Successfully loaded packages and their config defaults.
 */
export async function loadExtensions(
  discovered: ReadonlyArray<DiscoveredExtension>,
  options: LoadExtensionsOptions,
): Promise<ExtensionLoadResult> {
  const { frameworkVersion, importModule = defaultImport } = options;
  const packages: MakaioExtension[] = [];
  const configDefaults = new Map<string, Readonly<Record<string, unknown>>>();

  let createDetachedExtensionPackage:
    | typeof import('./detached-extension-handle.js').createDetachedExtensionPackage
    | undefined;

  for (const ext of discovered) {
    const { descriptor, extensionPath } = ext;
    const label = `[extensions] ${descriptor.name}@${descriptor.version}`;

    if (!isDescriptorFrameworkCompatible(ext, frameworkVersion)) {
      continue;
    }

    // Gate: execution mode — synthesize a managed package for detached extensions
    if (descriptor.execution === 'detached') {
      let detachedPkg: MakaioExtension;
      try {
        createDetachedExtensionPackage ??= (await import('./detached-extension-handle.js'))
          .createDetachedExtensionPackage;
        detachedPkg = createDetachedExtensionPackage(descriptor, extensionPath);
      } catch (err) {
        console.warn(
          `${label}: failed to synthesize detached extension package:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      packages.push(detachedPkg);
      if (descriptor.config?.defaults) {
        configDefaults.set(descriptor.name, descriptor.config.defaults);
      }
      continue;
    }

    // Gate: server entrypoint required
    if (!descriptor.entrypoints.server) {
      console.warn(`${label}: no server entrypoint declared, skipping`);
      continue;
    }

    let mod: { default: unknown };
    if (ext.preloadedModule) {
      mod = ext.preloadedModule;
    } else {
      try {
        const entryPath = resolveConventionEntrypoint('server', descriptor.entrypoints.server, extensionPath);
        if (!entryPath) {
          console.warn(`${label}: server entrypoint could not be resolved within extension directory, skipping`);
          continue;
        }
        mod = await importModule(entryPath);
      } catch (err) {
        console.warn(`${label}: failed to import server entry:`, err instanceof Error ? err.message : err);
        continue;
      }
    }

    const loadedPackages = normalizePackageExport(mod.default, descriptor.name, label);
    if (!loadedPackages) {
      continue;
    }

    packages.push(...loadedPackages);

    if (descriptor.config?.defaults) {
      configDefaults.set(descriptor.name, descriptor.config.defaults);
    }
  }

  return { packages, configDefaults };
}

/**
 * Normalize a server entry default export into executable packages.
 *
 * Single-package exports must still match the descriptor name exactly.
 * Array exports must keep every package under the descriptor's namespace
 * by using the descriptor name exactly or a dot-prefixed child name such
 * as `example-extension.settings`.
 * @param value - Default export from the server entrypoint.
 * @param descriptorName - Descriptor package name.
 * @param label - Log prefix for warnings.
 * @returns Normalized package list, or `undefined` when invalid.
 */
function normalizePackageExport(value: unknown, descriptorName: string, label: string): MakaioExtension[] | undefined {
  if (Array.isArray(value)) {
    const packages: MakaioExtension[] = [];
    const seenNames = new Set<string>();
    for (const item of value) {
      if (!isMakaioExtensionLike(item)) {
        console.warn(`${label}: default export array contains an invalid MakaioExtension, skipping`);
        return undefined;
      }
      if (seenNames.has(item.name)) {
        console.warn(`${label}: default export array contains duplicate package name '${item.name}', skipping`);
        return undefined;
      }
      seenNames.add(item.name);
      packages.push(item);
    }

    const hasDescriptorPackage = packages.some((pkg) => pkg.name === descriptorName);
    if (!hasDescriptorPackage) {
      console.warn(
        `${label}: default export array must include a package named '${descriptorName}' to match descriptor identity, skipping`,
      );
      return undefined;
    }

    if (packages.some((pkg) => pkg.name !== descriptorName && !pkg.name.startsWith(`${descriptorName}.`))) {
      console.warn(
        `${label}: default export array contains package names outside descriptor namespace '${descriptorName}', skipping`,
      );
      return undefined;
    }

    return packages;
  }

  if (!isMakaioExtensionLike(value)) {
    console.warn(`${label}: default export is not a valid MakaioExtension or MakaioExtension[], skipping`);
    return undefined;
  }

  if (value.name !== descriptorName) {
    console.warn(
      `${label}: imported package name '${value.name}' does not match descriptor name '${descriptorName}', skipping`,
    );
    return undefined;
  }

  return [value];
}

/**
 * Attach executable CLI contributions declared in extension descriptors.
 *
 * This bridges descriptor-level `entrypoints.cli` modules into the runtime's
 * `MakaioExtension.cli` surface so extension commands participate in the same
 * `cli.listContributions` and `cli.execute` flow as descriptor-backed packages.
 *
 * Existing packages are augmented in-place by name. Pure CLI-only extensions
 * (no server or browser package) are synthesized here, but descriptors that
 * also declare a server entry are never synthesized if the server package
 * failed to load — that remains a load failure rather than silently changing
 * the extension's runtime shape.
 *
 * Extensions with invalid CLI entrypoints are skipped with a warning.
 * @param discovered - Extensions found by a {@link ExtensionDiscovery}.
 * @param packages - Already loaded/synthesized packages to augment.
 * @param options - Required framework version and optional import override.
 * @returns Updated package list with executable CLI contributions attached.
 */
export async function attachExtensionCliContributions(
  discovered: ReadonlyArray<DiscoveredExtension>,
  packages: ReadonlyArray<MakaioExtension>,
  options: AttachExtensionCliContributionsOptions,
): Promise<ExtensionCliAttachResult> {
  const { importModule = defaultImport, frameworkVersion } = options;
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));
  const configDefaults = new Map<string, Readonly<Record<string, unknown>>>();

  for (const ext of discovered) {
    const cliEntrypoint = resolveEligibleCliEntrypoint(ext, frameworkVersion);
    if (!cliEntrypoint) continue;

    const label = `[extensions] ${ext.descriptor.name}@${ext.descriptor.version}`;
    const existing = packagesByName.get(ext.descriptor.name);
    if (existing?.cli) {
      continue;
    }

    const mod = await importCliModule(ext, cliEntrypoint, label, importModule);
    if (!mod) {
      continue;
    }

    if (!isCliContributionLike(mod.default)) {
      console.warn(`${label}: default export is not a valid CliContribution, skipping`);
      continue;
    }

    if (mod.default.name !== ext.descriptor.name) {
      console.warn(
        `${label}: imported CLI contribution name '${mod.default.name}' does not match descriptor name '${ext.descriptor.name}', skipping`,
      );
      continue;
    }

    if (existing) {
      packagesByName.set(ext.descriptor.name, {
        ...existing,
        cli: mod.default,
      });
      continue;
    }

    if (ext.descriptor.entrypoints?.server || ext.descriptor.entrypoints?.browser) {
      console.warn(
        `${label}: server or browser entry is present but no package was loaded, skipping CLI-only synthesis`,
      );
      continue;
    }

    packagesByName.set(ext.descriptor.name, createCliOnlyExtensionPackage(ext, mod.default));

    if (ext.descriptor.config?.defaults) {
      configDefaults.set(ext.descriptor.name, ext.descriptor.config.defaults);
    }
  }

  return { packages: [...packagesByName.values()], configDefaults };
}

/**
 * Resolve a CLI entrypoint only when the descriptor is eligible for CLI loading.
 * @param ext - Discovered extension descriptor.
 * @param frameworkVersion - Current framework version.
 * @returns CLI entrypoint declaration, or undefined when this descriptor should be skipped.
 */
function resolveEligibleCliEntrypoint(ext: DiscoveredExtension, frameworkVersion: string): true | string | undefined {
  if (!isDescriptorFrameworkCompatible(ext, frameworkVersion)) return undefined;
  if (ext.descriptor.execution === 'detached') return undefined;
  return ext.descriptor.entrypoints?.cli;
}

/**
 * Create a synthesized CLI-only extension package from descriptor metadata.
 * @param ext - Discovered CLI-only extension.
 * @param cli - Executable CLI contribution imported from the descriptor entrypoint.
 * @returns A minimal {@link MakaioExtension} carrying descriptor gates and CLI handlers.
 */
function createCliOnlyExtensionPackage(ext: DiscoveredExtension, cli: CliContribution): MakaioExtension {
  return { ...descriptorToBasePackage(ext.descriptor), cli };
}

/**
 * Check a descriptor's framework compatibility range.
 * @param ext - Discovered extension to evaluate.
 * @param frameworkVersion - Current framework version.
 * @returns `true` when the descriptor can load on this framework version.
 */
export function isDescriptorFrameworkCompatible(ext: DiscoveredExtension, frameworkVersion: string): boolean {
  const { descriptor } = ext;
  const label = `[extensions] ${descriptor.name}@${descriptor.version}`;
  try {
    if (versionSatisfies(frameworkVersion, descriptor.makaio.framework)) {
      return true;
    }
    console.warn(
      `${label}: requires framework ${descriptor.makaio.framework}, ` + `current is ${frameworkVersion}, skipping`,
    );
    return false;
  } catch (err) {
    console.warn(
      `${label}: invalid version metadata (framework=${frameworkVersion}, ` +
        `range=${descriptor.makaio.framework}), skipping:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Import a CLI module for an extension. Returns `undefined` when the import
 * should be skipped.
 *
 * CLI entrypoints are resolved by convention: `src/{stem}.ts` (dev) then
 * `dist/{stem}.mjs` (production), with containment enforcement at each step.
 * @param ext - The discovered extension to import.
 * @param cliEntrypoint - The CLI entrypoint value from the descriptor.
 * @param label - Log prefix for warnings.
 * @param importModule - Filesystem import function.
 * @returns The imported module, or `undefined` when the extension should be skipped.
 */
async function importCliModule(
  ext: DiscoveredExtension,
  cliEntrypoint: true | string,
  label: string,
  importModule: (entryPath: string) => Promise<{ default: unknown }>,
): Promise<{ default: unknown } | undefined> {
  try {
    const entryPath = resolveConventionEntrypoint('cli', cliEntrypoint, ext.extensionPath);
    if (!entryPath) {
      console.warn(`${label}: cli entrypoint has no resolvable candidate within extension directory, skipping`);
      return undefined;
    }
    return await importModule(entryPath);
  } catch (err) {
    console.warn(`${label}: failed to import cli entry:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * Merge descriptor-derived packages by explicit descriptor-source priority.
 *
 * Groups are processed in the order supplied by the caller. Earlier sources
 * win on descriptor-name collision and keep their entire package surface.
 * Later descriptors with different names still contribute package names that
 * have not already been claimed by a higher-priority descriptor.
 * @param groups - Descriptor package groups ordered from highest to lowest priority.
 * @returns Merged packages with at most one package per name.
 */
export function mergePackagesByDescriptorSourcePriority(
  groups: ReadonlyArray<DescriptorSourcePackageGroup>,
): MakaioExtension[] {
  const sourceByDescriptorName = new Map<string, string>();
  const sourceByPackageName = new Map<string, string>();
  const merged: MakaioExtension[] = [];

  for (const group of groups) {
    const existingDescriptorSource = sourceByDescriptorName.get(group.descriptorName);
    if (existingDescriptorSource !== undefined) {
      console.warn(
        `[boot] Descriptor '${group.descriptorName}' from source '${group.descriptorSource}' ` +
          `conflicts with higher-priority descriptor source '${existingDescriptorSource}', skipping`,
      );
      continue;
    }

    sourceByDescriptorName.set(group.descriptorName, group.descriptorSource);

    for (const pkg of group.packages) {
      const existingSource = sourceByPackageName.get(pkg.name);
      if (existingSource !== undefined) {
        console.warn(
          `[boot] Package '${pkg.name}' from descriptor source '${group.descriptorSource}' ` +
            `conflicts with higher-priority descriptor source '${existingSource}', skipping`,
        );
        continue;
      }

      sourceByPackageName.set(pkg.name, group.descriptorSource);
      merged.push(pkg);
    }
  }

  return merged;
}

/**
 * Minimal structural check for a MakaioExtension-like default export.
 * Does not use Zod — just validates the minimum required fields exist.
 * @param value - The default export to check.
 * @returns Whether the value is a valid {@link MakaioExtension} shape.
 */
export function isMakaioExtensionLike(value: unknown): value is MakaioExtension {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['name'] === 'string' && typeof obj['displayName'] === 'string' && typeof obj['version'] === 'string'
  );
}

/**
 * Minimal structural check for a {@link CliContribution}-like default export.
 *
 * An extension CLI contribution is only useful when it exposes executable
 * behavior, so the validator requires at least one of:
 * - an `interactive` handler, or
 * - one or more executable subcommand entries.
 * @param value - The default export to check.
 * @returns Whether the value is a valid executable CLI contribution shape.
 */
export function isCliContributionLike(value: unknown): value is CliContribution {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || typeof obj['description'] !== 'string' || !Array.isArray(obj['subcommands'])) {
    return false;
  }

  if ('interactive' in obj && obj['interactive'] !== undefined && typeof obj['interactive'] !== 'function') {
    return false;
  }

  if (obj['subcommands'].length === 0) {
    return typeof obj['interactive'] === 'function';
  }

  return obj['subcommands'].every(isCliSubcommandEntryLike);
}

/**
 * Minimal structural check for an executable CLI subcommand entry.
 * @param value - The subcommand entry to check.
 * @returns Whether the value looks like a runnable CLI subcommand.
 */
function isCliSubcommandEntryLike(value: unknown): value is CliSubcommandEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  return (
    typeof obj['name'] === 'string' &&
    typeof obj['description'] === 'string' &&
    isExecutableSchemaLike(obj['schema']) &&
    typeof obj['handler'] === 'function'
  );
}

/**
 * Check whether a schema-like object exposes the runtime `safeParse` API.
 * @param value - Candidate schema object.
 * @returns Whether the value looks like a Zod schema.
 */
function isExecutableSchemaLike(value: unknown): value is { readonly safeParse: (input: unknown) => unknown } {
  return (
    typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['safeParse'] === 'function'
  );
}

/**
 * Derive the stem string from a descriptor entrypoint declaration.
 * `true` resolves to the surface name; a string value is already the stem.
 * @param surface - Runtime surface name.
 * @param entrypointValue - Descriptor entrypoint declaration (`true` or a stem string).
 * @returns Resolved stem string.
 */
export function entrypointStem(surface: string, entrypointValue: true | string): string {
  return entrypointValue === true ? surface : entrypointValue;
}

/**
 * Resolve a descriptor entrypoint using the convention: try `src/{stem}.ts`
 * (dev) then `dist/{stem}.mjs` (production). The first candidate that exists
 * and passes the extension-root containment check is returned.
 *
 * `true` means use the surface name as the stem. A string value is a custom
 * stem (e.g. `"cli/index"` → `src/cli/index.ts` or `dist/cli/index.mjs`).
 * @param surface - Runtime surface name (`"server"`, `"browser"`, or `"cli"`).
 * @param entrypointValue - Descriptor entrypoint declaration (`true` or a stem string).
 * @param extensionPath - Absolute extension root path.
 * @returns Absolute resolved path when a valid candidate exists, otherwise `undefined`.
 */
export function resolveConventionEntrypoint(
  surface: string,
  entrypointValue: true | string,
  extensionPath: string,
): string | undefined {
  if (!path.isAbsolute(extensionPath)) return undefined;
  const stem = entrypointStem(surface, entrypointValue);
  const normalizedExtensionRoot = normalizeForContainment(extensionPath);

  const devPath = path.resolve(extensionPath, 'src', `${stem}.ts`);
  if (isExistingPathWithinDirectory(devPath, normalizedExtensionRoot)) {
    return devPath;
  }

  const prodPath = path.resolve(extensionPath, 'dist', `${stem}.mjs`);
  if (isExistingPathWithinDirectory(prodPath, normalizedExtensionRoot)) {
    return prodPath;
  }

  return undefined;
}

/**
 * Check that a resolved path stays within a base directory.
 *
 * Prevents path traversal attacks in descriptor.json entrypoints by rejecting
 * absolute paths, `../` sequences, or symlinks that escape the extension root.
 * @param resolved - The fully resolved absolute path.
 * @param baseDir - The directory the path must stay within.
 * @returns Whether `resolved` is a descendant of `baseDir`.
 */
export function isWithinDirectory(resolved: string, baseDir: string): boolean {
  const normalizedBase = normalizeForContainment(baseDir);
  const normalizedResolved = normalizeForContainment(resolved);
  return isWithinNormalizedDirectory(normalizedResolved, normalizedBase);
}

/**
 * Check whether an existing candidate path resolves inside a normalized base directory.
 * @param candidatePath - Candidate entrypoint path.
 * @param normalizedBaseDir - Normalized extension root.
 * @returns Whether the candidate exists and stays within the extension root.
 */
function isExistingPathWithinDirectory(candidatePath: string, normalizedBaseDir: string): boolean {
  try {
    return isWithinNormalizedDirectory(fs.realpathSync(candidatePath), normalizedBaseDir);
  } catch {
    return false;
  }
}

/**
 * Check whether two normalized paths have a parent-child relationship.
 * @param normalizedResolved - Normalized candidate path.
 * @param normalizedBaseDir - Normalized base directory path.
 * @returns Whether the candidate is a descendant of the base directory.
 */
function isWithinNormalizedDirectory(normalizedResolved: string, normalizedBaseDir: string): boolean {
  return normalizedResolved.startsWith(normalizedBaseDir + path.sep);
}

/**
 * Normalize a path for containment checks.
 *
 * Uses realpath when possible so symlink targets are compared rather than the
 * raw symlink path. Falls back to path.resolve for non-existent test fixtures
 * and callers that validate paths before import-time existence checks.
 * @param targetPath - Path to normalize.
 * @returns Canonical absolute path for containment comparison.
 */
function normalizeForContainment(targetPath: string): string {
  const absolutePath = path.resolve(targetPath);
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Default dynamic import function.
 * @param entryPath - Absolute path to the module.
 * @returns The imported module.
 */
async function defaultImport(entryPath: string): Promise<{ default: unknown }> {
  return (await import(pathToFileURL(entryPath).href)) as { default: unknown };
}
