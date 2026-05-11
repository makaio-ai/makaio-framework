/**
 * Synchronous discovery of extension browser entries for Vite dev and build
 * configuration.
 *
 * This module is consumed at Vite config evaluation time, which is synchronous,
 * so all filesystem operations use the `*Sync` Node.js APIs.
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { transformSync } from 'esbuild';
import { parseExtensionDescriptor, type ExtensionDescriptor } from '@makaio/contracts';
import * as platformNodeModule from '@makaio/runtime-node';
import * as makaioConfigModule from '@makaio/runtime-node/makaio-config';
import type { ExtensionDevEntry } from './vite-extension-dev-plugin.js';

const {
  defineMakaioConfig,
  MAKAIO_CONFIG_FILE_ENV,
  MAKAIO_HOME_ENV,
  buildExtensionBrowserRollupInputName,
  buildExtensionBrowserRuntimeEntrypoint,
  entrypointStem,
  parseMakaioConfig,
  resolveConventionEntrypoint,
  shouldIncludeExtension,
} = platformNodeModule;

const CONFIG_FILE_BASENAMES = [
  'makaio.config.ts',
  'makaio.config.js',
  'makaio.config.json',
  'makaio.config.all.ts',
] as const;
const SKIPPED_DISCOVERY_DIRS = new Set(['.git', 'dist', 'node_modules']);

type ParsedMakaioConfig = platformNodeModule.ParsedMakaioConfig;

/** Production browser entry derived from an extension descriptor. */
export interface BrowserBuildEntry {
  /**
   * Rollup input key. With Vite's `[name].js` output pattern this becomes the
   * public browser bundle path, e.g. `extensions/makaio-dev/browser/browser.js`.
   */
  readonly inputName: string;
  /** Absolute source path supplied as the Rollup input value. */
  readonly sourceAbsPath: string;
}

/** Descriptor root selected by runtime-equivalent config filtering. */
interface SelectedDescriptorRoot {
  /** Absolute directory containing `descriptor.json`. */
  readonly descriptorRoot: string;
  /** Validated descriptor read from the selected root. */
  readonly descriptor: ExtensionDescriptor;
}

/** Minimal CommonJS module object used by the sync config evaluator. */
interface ConfigModule {
  /** Module exports populated by transpiled config code. */
  exports: unknown;
}

/** Function shape produced by wrapping transpiled config code. */
type ConfigModuleRunner = (
  exports: Record<string, unknown>,
  module: ConfigModule,
  require: NodeRequire,
  __filename: string,
  __dirname: string,
) => void;

/**
 * Read a Makaio runtime config synchronously for Vite config evaluation.
 *
 * The returned value is normalized through the runtime `parseMakaioConfig`
 * schema so discovery paths follow the same rules as boot-time discovery.
 * @param cwd - Workspace root used for config lookup and relative path resolution.
 * @returns Parsed Makaio config.
 */
export function readMakaioConfigSync(cwd = process.cwd()): ParsedMakaioConfig {
  const configPath = resolveMakaioConfigPathSync(cwd);
  const makaioHome = resolveBuildMakaioHome(cwd);

  if (configPath === undefined) {
    return parseMakaioConfig({ extensions: { discoveryPaths: [] } }, { baseDir: cwd, makaioHome });
  }

  const rawConfig = readRawMakaioConfigSync(configPath);
  return parseMakaioConfig(rawConfig, {
    baseDir: path.dirname(configPath),
    makaioHome,
    source: configPath,
  });
}

/**
 * Discover descriptor roots beneath configured discovery paths.
 *
 * Each returned path is the directory containing a `descriptor.json`.
 * @param cwd - Workspace root used to resolve non-normalized relative paths.
 * @param discoveryPaths - Configured discovery paths. Parsed config already
 *   supplies absolute paths, but relative entries are accepted for tests and
 *   direct helper use.
 * @returns Descriptor root directories in deterministic traversal order.
 */
export function discoverDescriptorRootsFromConfig(cwd: string, discoveryPaths: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const discoveryPath of discoveryPaths) {
    const absolutePath = path.isAbsolute(discoveryPath) ? discoveryPath : path.resolve(cwd, discoveryPath);
    if (containsNodeModulesSegment(absolutePath) && !isExplicitDescriptorRoot(absolutePath)) continue;
    for (const descriptorRoot of discoverDescriptorRootsFromPath(absolutePath)) {
      if (!seen.has(descriptorRoot)) {
        seen.add(descriptorRoot);
        roots.push(descriptorRoot);
      }
    }
  }

  return roots;
}

/**
 * Check whether a configured discovery path is a dependency install path.
 * @param filePath - Absolute path to inspect.
 * @returns Whether any path segment is `node_modules`.
 */
function containsNodeModulesSegment(filePath: string): boolean {
  return filePath.includes(`${path.sep}node_modules${path.sep}`) || filePath.endsWith(`${path.sep}node_modules`);
}

/**
 * Check whether a path explicitly targets a descriptor root rather than a
 * directory to scan recursively.
 *
 * Returns `true` when the path is a `descriptor.json` file or a directory that
 * directly contains one. Used to allow explicitly configured descriptor roots
 * under `node_modules` through the blanket exclusion — only recursive scans of
 * dependency trees are suppressed.
 * @param absolutePath - Absolute configured discovery path.
 * @returns Whether the path points at an explicit descriptor root.
 */
function isExplicitDescriptorRoot(absolutePath: string): boolean {
  if (path.basename(absolutePath) === 'descriptor.json') return fs.existsSync(absolutePath);
  return fs.existsSync(path.join(absolutePath, 'descriptor.json'));
}

/** Resolved browser entry from a descriptor root. */
interface ResolvedBrowserEntry {
  /** Validated extension descriptor. */
  readonly descriptor: ExtensionDescriptor;
  /** Resolved browser stem for URL building (surface name or custom stem). */
  readonly browserStem: string;
  /** Absolute resolved browser source path. */
  readonly sourceAbsPath: string;
}

/**
 * Resolve a descriptor's browser entry with containment enforcement.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @param label - Context label for the warning when the entry has no candidate.
 * @returns Resolved browser entry, or `undefined` when no browser entry exists
 *   or no valid candidate is found within the descriptor root.
 */
function resolveDescriptorBrowserEntry(descriptorRoot: string, label: string): ResolvedBrowserEntry | undefined {
  const descriptor = readExtensionDescriptor(descriptorRoot);
  if (descriptor?.entrypoints?.browser === undefined) return undefined;

  const browserEntrypointValue = descriptor.entrypoints.browser;
  const browserStem = entrypointStem('browser', browserEntrypointValue);
  const sourceAbsPath = resolveConventionEntrypoint('browser', browserEntrypointValue, descriptorRoot);
  if (sourceAbsPath === undefined) {
    console.warn(
      `[extensions] ${descriptor.name}: browser entry has no resolvable candidate within extension directory, skipping ${label}`,
    );
    return undefined;
  }

  return { descriptor, browserStem, sourceAbsPath };
}

/**
 * Build a dev-server browser entry from a descriptor root.
 *
 * URL convention: `/extensions/<name>/browser/<source-filename>`.
 * Source path: browser entry resolved relative to the descriptor root.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @returns Constructed dev entry, or `undefined` when no browser entry exists
 *   or the entry escapes the descriptor root.
 */
export function buildBrowserDevEntryForDescriptorRoot(descriptorRoot: string): ExtensionDevEntry | undefined {
  const resolved = resolveDescriptorBrowserEntry(descriptorRoot, 'dev entry');
  if (resolved === undefined) return undefined;

  return {
    urlPath: buildSourceBrowserDevEntrypoint(resolved.descriptor.name, resolved.sourceAbsPath),
    sourceAbsPath: resolved.sourceAbsPath,
  };
}

/**
 * Build a production Rollup browser input from a descriptor root.
 *
 * The input name omits the source extension so Vite's `[name].js` output
 * pattern produces a browser-loadable JavaScript URL.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @returns Browser build entry, or `undefined` when no browser entry exists
 *   or the entry escapes the descriptor root.
 */
export function buildBrowserBuildEntryForDescriptorRoot(descriptorRoot: string): BrowserBuildEntry | undefined {
  const resolved = resolveDescriptorBrowserEntry(descriptorRoot, 'build entry');
  if (resolved === undefined) return undefined;

  return {
    inputName: buildExtensionBrowserRollupInputName(resolved.descriptor.name, resolved.browserStem),
    sourceAbsPath: resolved.sourceAbsPath,
  };
}

/**
 * Build a runtime-compatible dev-server browser entry from a descriptor root.
 *
 * URL convention: `/extensions/<name>/browser/<entry-stem>.js`, matching the
 * runtime bridge and production Vite build output.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @returns Constructed runtime dev entry, or `undefined` when no browser entry
 *   exists or the entry escapes the descriptor root.
 */
export function buildRuntimeBrowserDevEntryForDescriptorRoot(descriptorRoot: string): ExtensionDevEntry | undefined {
  const resolved = resolveDescriptorBrowserEntry(descriptorRoot, 'runtime dev entry');
  if (resolved === undefined) return undefined;

  return {
    urlPath: buildExtensionBrowserRuntimeEntrypoint(resolved.descriptor.name, resolved.browserStem),
    sourceAbsPath: resolved.sourceAbsPath,
  };
}

/**
 * Synchronously discover extension browser entries for dev-mode serving.
 *
 * Discovery follows `makaio.config.*` extension discovery paths and descriptor
 * validation, then maps each descriptor browser entry to a source URL used by
 * helper-level Task 5 tests. Vite app configs use
 * {@link discoverExtensionBrowserRuntimeDevEntries} because browser loaders
 * import runtime-advertised JavaScript URLs.
 * @param cwd - Working directory for config lookup. Defaults to `process.cwd()`.
 * @returns Array of {@link ExtensionDevEntry} objects for the Vite plugin.
 */
export function discoverExtensionBrowserDevEntries(cwd = process.cwd()): ExtensionDevEntry[] {
  return discoverSelectedRoots(cwd).flatMap(
    ({ descriptorRoot }) => buildBrowserDevEntryForDescriptorRoot(descriptorRoot) ?? [],
  );
}

/**
 * Synchronously discover runtime-compatible extension browser entries for
 * dev-mode serving.
 *
 * Vite consumers use this mapping because the browser loader imports the
 * runtime-advertised JavaScript URL even in dev mode.
 * @param cwd - Working directory for config lookup. Defaults to `process.cwd()`.
 * @returns Array of {@link ExtensionDevEntry} objects for the Vite plugin.
 */
export function discoverExtensionBrowserRuntimeDevEntries(cwd = process.cwd()): ExtensionDevEntry[] {
  return discoverSelectedRoots(cwd).flatMap(
    ({ descriptorRoot }) => buildRuntimeBrowserDevEntryForDescriptorRoot(descriptorRoot) ?? [],
  );
}

/**
 * Synchronously discover production browser build entries from descriptors.
 * @param cwd - Working directory for config lookup. Defaults to `process.cwd()`.
 * @returns Browser build entries derived from configured descriptor roots.
 */
export function discoverExtensionBrowserBuildEntries(cwd = process.cwd()): BrowserBuildEntry[] {
  return discoverSelectedRoots(cwd).flatMap(
    ({ descriptorRoot }) => buildBrowserBuildEntryForDescriptorRoot(descriptorRoot) ?? [],
  );
}

/**
 * Build a Rollup input map from descriptor browser entries.
 * @param cwd - Working directory for config lookup. Defaults to `process.cwd()`.
 * @returns Rollup `input` object keyed by stable browser output names.
 */
export function discoverExtensionBrowserBuildInputs(cwd = process.cwd()): Record<string, string> {
  return Object.fromEntries(
    discoverExtensionBrowserBuildEntries(cwd).map((entry) => [entry.inputName, entry.sourceAbsPath]),
  );
}

/**
 * Read config and discover selected descriptor roots in a single pass.
 * @param cwd - Workspace root used for config lookup.
 * @returns Selected descriptor roots in runtime discovery order.
 */
function discoverSelectedRoots(cwd: string): SelectedDescriptorRoot[] {
  const config = readMakaioConfigSync(cwd);
  return discoverSelectedDescriptorRootsFromConfig(cwd, config);
}

/**
 * Resolve the config file used by synchronous Vite-time discovery.
 * @param cwd - Workspace root used for config lookup.
 * @returns Absolute config path, or `undefined` when no config file exists.
 */
function resolveMakaioConfigPathSync(cwd: string): string | undefined {
  const envPath = process.env[MAKAIO_CONFIG_FILE_ENV]?.trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(cwd, envPath);
  }

  for (const basename of CONFIG_FILE_BASENAMES) {
    const candidate = path.join(cwd, basename);
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Select descriptors using the same name/filter semantics as runtime config
 * discovery: configured root order, first descriptor by name wins, and
 * exclude/include/autoDiscover policy decides whether a descriptor contributes.
 * @param cwd - Workspace root used to resolve non-normalized relative paths.
 * @param config - Parsed runtime config.
 * @returns Selected descriptor roots in runtime discovery order.
 */
function discoverSelectedDescriptorRootsFromConfig(cwd: string, config: ParsedMakaioConfig): SelectedDescriptorRoot[] {
  const selected: SelectedDescriptorRoot[] = [];
  const seenNames = new Set<string>();

  for (const descriptorRoot of discoverDescriptorRootsFromConfig(cwd, config.extensions.discoveryPaths)) {
    const descriptor = readExtensionDescriptor(descriptorRoot);
    if (descriptor === undefined || seenNames.has(descriptor.name)) continue;
    if (!shouldIncludeExtension(descriptor.name, config)) continue;

    seenNames.add(descriptor.name);
    selected.push({ descriptorRoot, descriptor });
  }

  return selected;
}

/**
 * Read a raw config object from JSON, JavaScript, or TypeScript.
 * @param configPath - Absolute config file path.
 * @returns Raw config export value.
 */
function readRawMakaioConfigSync(configPath: string): unknown {
  if (configPath.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  return evaluateConfigModuleSync(configPath);
}

/**
 * Evaluate a JS/TS config file synchronously.
 *
 * Config files are expected to export a config object, optionally wrapped in
 * `defineMakaioConfig`. Other imports are resolved normally from this module.
 * @param configPath - Absolute config file path.
 * @returns Default export or module export object.
 */
function evaluateConfigModuleSync(configPath: string): unknown {
  const source = fs.readFileSync(configPath, 'utf-8');
  const loader = configPath.endsWith('.ts') ? 'ts' : 'js';
  const transformed = transformSync(source, {
    loader,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
  });
  const moduleObject: ConfigModule = { exports: {} };
  const exportsObject: Record<string, unknown> = {};
  moduleObject.exports = exportsObject;
  const wrapped = `(function (exports, module, require, __filename, __dirname) {\n${transformed.code}\n})`;
  const runner = new vm.Script(wrapped, { filename: configPath }).runInNewContext({
    console,
    process,
  }) as ConfigModuleRunner;

  runner(exportsObject, moduleObject, createRequireForConfigModule(configPath), configPath, path.dirname(configPath));
  return unwrapDefaultExport(moduleObject.exports);
}

/**
 * Resolve imports used while evaluating one config module.
 *
 * Returns a full `NodeRequire`-shaped function so that config files can use
 * `require.resolve()` and other standard helpers. The `@makaio/runtime-node`
 * specifier is intercepted to supply the already-loaded framework module surface.
 * @param configPath - Absolute config file path.
 * @returns `require` implementation scoped to the config file.
 */
function createRequireForConfigModule(configPath: string): NodeRequire {
  const requireFromConfig = createRequire(configPath);
  const shim = ((specifier: string): unknown => {
    if (specifier === '@makaio/runtime-node') {
      return { ...platformNodeModule, defineMakaioConfig };
    }
    if (specifier === '@makaio/runtime-node/makaio-config') {
      return { ...makaioConfigModule, defineMakaioConfig };
    }
    return requireFromConfig(specifier);
  }) as NodeRequire;
  shim.resolve = requireFromConfig.resolve;
  shim.cache = requireFromConfig.cache;
  shim.extensions = requireFromConfig.extensions;
  shim.main = requireFromConfig.main;
  return shim;
}

/**
 * Return a default export when a transpiled module produced one.
 * @param moduleExports - CommonJS module exports object.
 * @returns Default export value when present, otherwise `moduleExports`.
 */
function unwrapDefaultExport(moduleExports: unknown): unknown {
  if (typeof moduleExports !== 'object' || moduleExports === null) return moduleExports;
  const record = moduleExports as Record<string, unknown>;
  return 'default' in record ? record['default'] : moduleExports;
}

/**
 * Resolve the build-time Makaio home without consulting a user-home default.
 * @param cwd - Workspace root used when `MAKAIO_HOME` is unset.
 * @returns Absolute Makaio home path.
 */
function resolveBuildMakaioHome(cwd: string): string {
  const declared = process.env[MAKAIO_HOME_ENV]?.trim();
  return declared ? path.resolve(cwd, declared) : path.join(cwd, '.makaio');
}

/**
 * Discover descriptor roots beneath one configured path.
 * @param discoveryPath - Absolute configured discovery path.
 * @returns Descriptor root directories.
 */
function discoverDescriptorRootsFromPath(discoveryPath: string): string[] {
  const stat = statSync(discoveryPath);
  if (stat === undefined) return [];

  if (stat.isFile()) {
    return path.basename(discoveryPath) === 'descriptor.json' ? [path.dirname(discoveryPath)] : [];
  }

  const descriptorPath = path.join(discoveryPath, 'descriptor.json');
  if (fs.existsSync(descriptorPath)) return [discoveryPath];

  return discoverDescriptorRootsRecursively(discoveryPath);
}

/**
 * Recursively find descriptor roots in a search directory.
 * @param root - Absolute directory to search.
 * @returns Descriptor root directories.
 */
function discoverDescriptorRootsRecursively(root: string): string[] {
  const roots: string[] = [];
  const entries = readdirSync(root);

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DISCOVERY_DIRS.has(entry.name)) continue;
    const entryPath = path.join(root, entry.name);
    const descriptorPath = path.join(entryPath, 'descriptor.json');
    if (fs.existsSync(descriptorPath)) {
      roots.push(entryPath);
      continue;
    }
    roots.push(...discoverDescriptorRootsRecursively(entryPath));
  }

  return roots;
}

/**
 * Read and validate a descriptor in the supplied descriptor root.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @returns Valid extension descriptor, or `undefined` when invalid.
 */
function readExtensionDescriptor(descriptorRoot: string): ExtensionDescriptor | undefined {
  const descriptorPath = path.join(descriptorRoot, 'descriptor.json');
  try {
    const raw = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as unknown;
    return parseExtensionDescriptor(raw);
  } catch (error) {
    console.warn(
      `[extensions] Skipping invalid descriptor at ${descriptorPath}:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Build the source dev URL for a descriptor browser entry.
 * @param descriptorName - Descriptor name.
 * @param sourceAbsPath - Resolved browser source path.
 * @returns Source dev URL path used by Task 5 helper callers.
 */
function buildSourceBrowserDevEntrypoint(descriptorName: string, sourceAbsPath: string): string {
  return `/extensions/${descriptorName}/browser/${path.basename(sourceAbsPath)}`;
}

/**
 * Read directory entries in deterministic order.
 * @param dirPath - Directory to read.
 * @returns Directory entries sorted by name, or an empty array on read failure.
 */
function readdirSync(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

/**
 * Stat a path without throwing.
 * @param filePath - Path to stat.
 * @returns Filesystem stat, or `undefined` when unavailable.
 */
function statSync(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}
