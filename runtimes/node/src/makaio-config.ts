import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import { ExtensionDescriptorSchema } from '@makaio/contracts';
import { type DiscoveredExtension, type ExtensionDiscovery } from './extension-discovery.js';

/** Environment override for the runtime config file path. */
export const MAKAIO_CONFIG_FILE_ENV = 'MAKAIO_CONFIG_FILE';
/** Environment override for the Makaio runtime data home. */
export const MAKAIO_HOME_ENV = 'MAKAIO_HOME';

const CONFIG_FILE_BASENAMES = ['makaio.config.ts', 'makaio.config.js', 'makaio.config.json'] as const;
const DESCRIPTOR_GLOB_IGNORES = ['**/node_modules/**', '**/dist/**', '**/.git/**'] as const;

/** Filesystem discovery source tiers assignable from runtime config roots. */
export type ConfiguredDiscoverySource = DiscoveredExtension['source'];

/** Absolute filesystem discovery root with the source tier descriptors inherit from it. */
export interface ConfiguredDiscoveryRoot {
  /** Absolute descriptor/package/search root. */
  readonly path: string;
  /** Source tier applied to descriptors read beneath this root. */
  readonly source: ConfiguredDiscoverySource;
}

const MakaioConfigSchema = z
  .object({
    extensions: z
      .object({
        autoDiscover: z.boolean().optional(),
        discoveryPaths: z.array(z.string().min(1)).optional(),
        include: z.array(z.string().min(1)).optional(),
        exclude: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    launcherCommand: z.string().min(1).optional(),
    packageConfigDefaults: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

/** Runtime extension config authoring shape. */
export type MakaioConfig = z.input<typeof MakaioConfigSchema>;

/** Parsed runtime extension config with absolute paths and defaults applied. */
export interface ParsedMakaioConfig {
  /** Extension discovery and filter policy. */
  readonly extensions: {
    /** Whether unmatched discovered extensions are included by default. */
    readonly autoDiscover: boolean;
    /** Absolute descriptor/package/search roots. */
    readonly discoveryPaths: readonly string[];
    /** Absolute descriptor/package/search roots with source provenance. */
    readonly discoveryRoots: readonly ConfiguredDiscoveryRoot[];
    /** Optional descriptor-name glob allow-list. */
    readonly include: readonly string[];
    /** Optional descriptor-name glob deny-list. Exclude wins over include. */
    readonly exclude: readonly string[];
  };
  /** Launcher command visible to runtime services. */
  readonly launcherCommand: string;
  /** Package config defaults keyed by extension/package name. */
  readonly packageConfigDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/** Options for parsing raw runtime config values. */
export interface ParseMakaioConfigOptions {
  /** Directory used to resolve relative discovery paths. */
  readonly baseDir: string;
  /** Makaio data home used for default installed-extension roots. */
  readonly makaioHome: string;
  /** Optional config source label used in validation errors. */
  readonly source?: string;
}

/** Loaded config result. */
export interface LoadedMakaioConfig {
  /** Absolute path to the loaded config file, or `undefined` when defaults were used. */
  readonly configPath?: string;
  /** Parsed runtime config. */
  readonly config: ParsedMakaioConfig;
}

/** Options for resolving/loading runtime config. */
export interface LoadMakaioConfigOptions {
  /** Makaio data home used for default config lookup and installed-extension roots. */
  readonly makaioHome: string;
  /** Explicit config path. Takes precedence over env and default lookup. */
  readonly configPath?: string;
  /** Environment snapshot used for `MAKAIO_CONFIG_FILE`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Runtime options derived from config and suitable for boot composition roots. */
export interface ConfiguredRuntimeOptions {
  readonly launcherCommand: string;
  readonly discovery: ExtensionDiscovery;
  readonly packageConfigDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Typed identity helper for TS/JS config files.
 * @param config - Runtime config object.
 * @returns The same config object.
 */
export function defineMakaioConfig(config: MakaioConfig): MakaioConfig {
  return config;
}

/**
 * Resolve the runtime data home from environment or the user default.
 *
 * This is an operational override, not host composition: it selects where
 * runtime state, config, databases, extension installs, and machine keys live.
 * @param env - Environment snapshot to read.
 * @returns Absolute Makaio data-home path.
 */
export function resolveMakaioHome(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env[MAKAIO_HOME_ENV]?.trim();
  return declared && declared.length > 0 ? path.resolve(declared) : path.join(os.homedir(), '.makaio');
}

/**
 * Parse and normalize raw JSON/JS/TS config values through one schema.
 * @param rawConfig - Raw config object from JSON or a JS/TS default export.
 * @param options - Path/default normalization options.
 * @returns Parsed config with defaults applied.
 */
export function parseMakaioConfig(rawConfig: unknown, options: ParseMakaioConfigOptions): ParsedMakaioConfig {
  const result = MakaioConfigSchema.safeParse(rawConfig ?? {});
  if (!result.success) {
    throw createRuntimeConfigError('Invalid Makaio runtime config', options.source, result.error);
  }

  const parsed = result.data;
  const extensions = parsed.extensions ?? {};
  const discoveryRoots = buildConfiguredDiscoveryRoots(extensions.discoveryPaths, options);

  return {
    extensions: {
      autoDiscover: extensions.autoDiscover ?? true,
      discoveryPaths: discoveryRoots.map((root) => root.path),
      discoveryRoots,
      include: extensions.include ?? [],
      exclude: extensions.exclude ?? [],
    },
    launcherCommand: parsed.launcherCommand ?? 'makaio',
    packageConfigDefaults: new Map(Object.entries(parsed.packageConfigDefaults ?? {})),
  };
}

/**
 * Normalize config discovery paths into source-aware roots.
 * @param discoveryPaths - Optional author-declared discovery paths.
 * @param options - Path/default normalization options.
 * @returns Absolute discovery roots with filesystem source provenance.
 */
function buildConfiguredDiscoveryRoots(
  discoveryPaths: readonly string[] | undefined,
  options: ParseMakaioConfigOptions,
): ConfiguredDiscoveryRoot[] {
  if (discoveryPaths !== undefined) {
    return discoveryPaths.map((entry) => ({
      path: resolveDiscoveryPath(entry, options.baseDir),
      source: 'local',
    }));
  }

  return [
    {
      path: path.join(options.makaioHome, 'extensions'),
      source: 'installed',
    },
    {
      path: path.join(options.makaioHome, 'node_modules'),
      source: 'global-npm',
    },
  ];
}

/**
 * Resolve a discovery path relative to the config file directory.
 * @param entry - Raw discovery path from config.
 * @param baseDir - Directory used to resolve relative paths.
 * @returns Absolute discovery path.
 */
function resolveDiscoveryPath(entry: string, baseDir: string): string {
  return path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
}

/**
 * Resolve the config file path using explicit path, env override, then user-home defaults.
 * @param options - Lookup options.
 * @returns Absolute config path, or `undefined` when no default config exists.
 */
export async function resolveMakaioConfigPath(options: LoadMakaioConfigOptions): Promise<string | undefined> {
  const envPath = options.env?.[MAKAIO_CONFIG_FILE_ENV]?.trim();
  const declaredPath = options.configPath ?? (envPath ? envPath : undefined);
  if (declaredPath !== undefined) {
    const resolved = path.resolve(declaredPath);
    await assertFileExists(resolved, 'runtime config');
    return resolved;
  }

  for (const basename of CONFIG_FILE_BASENAMES) {
    const candidate = path.join(options.makaioHome, basename);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Load runtime config from disk or return default installed-extension config.
 * @param options - Load options.
 * @returns Loaded config and optional source path.
 */
export async function loadMakaioConfig(options: LoadMakaioConfigOptions): Promise<LoadedMakaioConfig> {
  const configPath = await resolveMakaioConfigPath(options);
  if (configPath === undefined) {
    return {
      config: parseMakaioConfig({}, { baseDir: options.makaioHome, makaioHome: options.makaioHome }),
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = await importConfigFile(configPath);
  } catch (error) {
    throw createRuntimeConfigError('Failed to load Makaio runtime config', configPath, error);
  }

  return {
    configPath,
    config: parseMakaioConfig(rawConfig, {
      baseDir: path.dirname(configPath),
      makaioHome: options.makaioHome,
      source: configPath,
    }),
  };
}

/**
 * Build boot-ready runtime options from a config file or config defaults.
 * @param options - Load options.
 * @returns Runtime options derived from config.
 */
export async function buildConfiguredRuntimeOptions(
  options: LoadMakaioConfigOptions,
): Promise<ConfiguredRuntimeOptions> {
  const { config } = await loadMakaioConfig(options);
  return {
    launcherCommand: config.launcherCommand,
    discovery: createMakaioConfigDiscovery(config),
    packageConfigDefaults: config.packageConfigDefaults,
  };
}

/**
 * Create a descriptor discovery strategy from parsed runtime config.
 * @param config - Parsed runtime config.
 * @returns Extension discovery strategy.
 */
export function createMakaioConfigDiscovery(config: ParsedMakaioConfig): ExtensionDiscovery {
  return new ConfiguredDescriptorDiscovery(config);
}

class ConfiguredDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param config - Parsed config whose discovery roots and filters drive this strategy.
   */
  public constructor(private readonly config: ParsedMakaioConfig) {}

  /**
   * Discover descriptor-backed extensions from every configured root.
   * @returns First-match-wins discovered extensions after include/exclude filters.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const discovered = new Map<string, DiscoveredExtension>();
    for (const discoveryRoot of this.config.extensions.discoveryRoots) {
      for (const extension of await discoverFromPath(discoveryRoot)) {
        if (
          !discovered.has(extension.descriptor.name) &&
          shouldIncludeExtension(extension.descriptor.name, this.config)
        ) {
          discovered.set(extension.descriptor.name, extension);
        }
      }
    }
    return [...discovered.values()];
  }
}

/**
 * Discover descriptors from a single configured filesystem path.
 * @param discoveryRoot - Descriptor file, package directory, node_modules root, or recursive search root plus source.
 * @returns Discovered extensions under the path.
 */
async function discoverFromPath(discoveryRoot: ConfiguredDiscoveryRoot): Promise<DiscoveredExtension[]> {
  const discoveryPath = discoveryRoot.path;
  const stat = await fs.stat(discoveryPath).catch(() => undefined);
  if (stat === undefined) return [];
  if (stat.isFile()) {
    if (path.basename(discoveryPath) !== 'descriptor.json') return [];
    const extension = await readDiscoveredExtension(discoveryPath, discoveryRoot.source);
    return extension === undefined ? [] : [extension];
  }

  const descriptorPath = path.join(discoveryPath, 'descriptor.json');
  if (await fileExists(descriptorPath)) {
    const extension = await readDiscoveredExtension(descriptorPath, discoveryRoot.source);
    return extension === undefined ? [] : [extension];
  }

  if (path.basename(discoveryPath) === 'node_modules') {
    return discoverNodeModulesPath(discoveryRoot);
  }

  return discoverDescriptorGlob(toGlobPath(discoveryPath, '**', 'descriptor.json'), discoveryRoot.source);
}

/**
 * Discover descriptors one package level below a node_modules root.
 * @param discoveryRoot - Absolute node_modules directory plus source.
 * @returns Discovered extension descriptors.
 */
async function discoverNodeModulesPath(discoveryRoot: ConfiguredDiscoveryRoot): Promise<DiscoveredExtension[]> {
  const nodeModulesPath = discoveryRoot.path;
  const patterns = [
    toGlobPath(nodeModulesPath, '*/descriptor.json'),
    toGlobPath(nodeModulesPath, '@*/*/descriptor.json'),
  ];
  const matches = (await Promise.all(patterns.map((pattern) => glob(pattern, { windowsPathsNoEscape: true })))).flat();
  return readDiscoveredExtensions(matches, discoveryRoot.source);
}

/**
 * Discover descriptor files matching a recursive glob.
 * @param pattern - Glob pattern for descriptor files.
 * @param source - Source tier applied to descriptors matched by the pattern.
 * @returns Parsed extension descriptors.
 */
async function discoverDescriptorGlob(
  pattern: string,
  source: ConfiguredDiscoverySource,
): Promise<DiscoveredExtension[]> {
  const matches = await glob(pattern, {
    ignore: [...DESCRIPTOR_GLOB_IGNORES],
    windowsPathsNoEscape: true,
  });
  return readDiscoveredExtensions(matches, source);
}

/**
 * Parse descriptor files, skipping invalid descriptors with a warning.
 * @param descriptorPaths - Descriptor file paths.
 * @param source - Source tier applied to every descriptor path.
 * @returns Successfully parsed extension descriptors.
 */
async function readDiscoveredExtensions(
  descriptorPaths: readonly string[],
  source: ConfiguredDiscoverySource,
): Promise<DiscoveredExtension[]> {
  const results: DiscoveredExtension[] = [];
  for (const descriptorPath of descriptorPaths) {
    const extension = await readDiscoveredExtension(descriptorPath, source);
    if (extension !== undefined) {
      results.push(extension);
    }
  }
  return results;
}

/**
 * Read and validate one descriptor file.
 * @param descriptorPath - Descriptor JSON file path.
 * @param source - Source tier applied to the descriptor.
 * @returns A discovered extension, or `undefined` when the descriptor is invalid.
 */
async function readDiscoveredExtension(
  descriptorPath: string,
  source: ConfiguredDiscoverySource,
): Promise<DiscoveredExtension | undefined> {
  try {
    const raw = await fs.readFile(descriptorPath, 'utf-8');
    const descriptor = ExtensionDescriptorSchema.parse(JSON.parse(raw));
    return {
      descriptor,
      extensionPath: path.dirname(descriptorPath),
      source,
    };
  } catch (error) {
    console.warn(
      `[makaio-config] Skipping invalid descriptor at ${descriptorPath}:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Decide whether a descriptor name is selected by runtime config filters.
 * @param name - Extension descriptor name.
 * @param config - Parsed config with include/exclude filters.
 * @returns `true` when the extension should be included.
 */
export function shouldIncludeExtension(name: string, config: ParsedMakaioConfig): boolean {
  const { autoDiscover, include, exclude } = config.extensions;
  if (exclude.some((pattern) => minimatch(name, pattern))) return false;
  if (include.length > 0) return include.some((pattern) => minimatch(name, pattern));
  return autoDiscover;
}

/**
 * Import a JSON, JS, or TS config file.
 * @param configPath - Absolute config file path.
 * @returns Raw config export.
 */
async function importConfigFile(configPath: string): Promise<unknown> {
  if (configPath.endsWith('.json')) {
    return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  }
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  return mod.default ?? mod;
}

/**
 * Wrap a runtime config failure with the source that supplied the invalid value.
 * @param action - Failure phase to report.
 * @param source - Config path or source label, when known.
 * @param cause - Original parse/import error.
 * @returns Source-aware error with the original error attached as cause.
 */
function createRuntimeConfigError(action: string, source: string | undefined, cause: unknown): Error {
  const sourceSuffix = source === undefined ? '' : ` at ${source}`;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${action}${sourceSuffix}: ${causeMessage}`, { cause });
}

/**
 * Check whether a path exists and is a regular file.
 * @param filePath - Candidate file path.
 * @returns `true` when the file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

/**
 * Assert that an explicit config path exists.
 * @param filePath - Candidate file path.
 * @param label - Human-readable file role for error messages.
 */
async function assertFileExists(filePath: string, label: string): Promise<void> {
  if (!(await fileExists(filePath))) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

/**
 * Build a POSIX-style glob path from native path segments.
 * @param segments - Native path segments.
 * @returns Glob path with forward slashes.
 */
function toGlobPath(...segments: readonly string[]): string {
  return path
    .join(...segments)
    .split(path.sep)
    .join('/');
}
