import { InvalidOptionArgumentError } from 'commander';
import {
  createMakaioConfigDiscovery,
  loadMakaioConfig,
  resolveMakaioHome,
  type ExtensionDiscovery,
  type ParsedMakaioConfig,
} from '@makaio/runtime-node';
import type { ServeConfig } from './main.js';
import { discoverDevWorkspacePackages, type DevWorkspacePackages } from './dev-workspace-packages.js';

/** Result of root-level runtime config flag extraction. */
export interface RootConfigParseResult {
  /** Process argv with a root-level `--config` flag removed. */
  readonly argv: string[];
  /** Explicit config file path passed before the command name. */
  readonly configPath?: string;
}

/** Resolved CLI runtime configuration. */
export interface CliRuntimeConfig {
  /** Process argv with a root-level `--config` flag removed. */
  readonly argv: string[];
  /** Discovery strategy selected by explicit config, injected discovery, or default config. */
  readonly discovery: ExtensionDiscovery;
  /** Serve config with runtime config defaults applied when needed. */
  readonly serveConfig?: ServeConfig;
}

/**
 * Extract root-level runtime config flag before Commander parses subcommands.
 *
 * Only flags before the command name are consumed. Extension commands remain
 * free to define their own `--config` option after the command name.
 * @param argv - Raw process argv vector.
 * @returns argv without the root config flag plus the optional config path.
 */
export function extractRootConfigArg(argv: readonly string[]): RootConfigParseResult {
  const result = [...argv];
  for (let index = 2; index < result.length; index += 1) {
    const arg = result[index];
    if (!arg?.startsWith('-')) break;

    if (arg === '--config') {
      const value = result[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new InvalidOptionArgumentError('--config requires a path');
      }
      result.splice(index, 2);
      return { argv: result, configPath: value };
    }

    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value.length === 0) {
        throw new InvalidOptionArgumentError('--config requires a path');
      }
      result.splice(index, 1);
      return { argv: result, configPath: value };
    }
  }

  return { argv: result };
}

/**
 * Resolve CLI runtime config before command registration.
 *
 * In addition to loading `makaio.config.*`, this function probes for a
 * workspace root only for `makaio serve` and — when found — injects the
 * {@link DevPortalMap} and `frameworkPackagePath` into the boot overrides so
 * the package-manager service can install extensions via `portal:` links
 * without hitting npm in dev mode.
 * @param argv - Raw process argv vector.
 * @param discovery - Optional injected discovery strategy.
 * @param serveConfig - Optional injected serve config.
 * @param env - Environment used for `MAKAIO_CONFIG_FILE`.
 * @returns Parsed argv plus effective discovery and serve config.
 */
export async function resolveCliRuntimeConfig(
  argv: readonly string[],
  discovery: ExtensionDiscovery | undefined,
  serveConfig: ServeConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliRuntimeConfig> {
  const parsedRoot = extractRootConfigArg(argv);
  const makaioHome = resolveMakaioHome(env);
  const loadedConfig = await loadMakaioConfig({
    makaioHome,
    configPath: parsedRoot.configPath,
    env,
  });
  const useConfig = loadedConfig.configPath !== undefined || discovery === undefined;

  const configServeConfig =
    loadedConfig.configPath !== undefined || serveConfig === undefined
      ? applyConfigToServeConfig(serveConfig, loadedConfig.config)
      : serveConfig;

  const devWorkspace = shouldApplyDevWorkspacePackages(parsedRoot.argv)
    ? await discoverDevWorkspacePackages()
    : undefined;
  const effectiveServeConfig = devWorkspace
    ? applyDevWorkspacePackages(configServeConfig, devWorkspace)
    : configServeConfig;

  return {
    argv: parsedRoot.argv,
    discovery: useConfig ? createMakaioConfigDiscovery(loadedConfig.config) : discovery,
    serveConfig: effectiveServeConfig,
  };
}

/**
 * Determine whether an invocation needs dev workspace package discovery.
 *
 * Only `serve` consumes the resulting boot overrides. Discovery-free client
 * commands such as `open`, `extension init`, and version output must not scan
 * the whole repository just to parse their local options.
 * @param argv - Process argv after root config flags have been removed.
 * @returns `true` when dev package overrides should be resolved.
 */
export function shouldApplyDevWorkspacePackages(argv: readonly string[]): boolean {
  return argv[2] === 'serve';
}

/**
 * Apply parsed runtime config to CLI serve boot options.
 * @param serveConfig - Existing host-provided serve config.
 * @param config - Parsed runtime config.
 * @returns Serve config with config-derived runtime options merged in.
 */
export function applyConfigToServeConfig(
  serveConfig: ServeConfig | undefined,
  config: ParsedMakaioConfig,
): ServeConfig {
  return {
    ...serveConfig,
    boot: {
      ...serveConfig?.boot,
      discovery: createMakaioConfigDiscovery(config),
      launcherCommand: config.launcherCommand,
      packageConfigDefaults: mergePackageConfigDefaults(
        serveConfig?.boot?.packageConfigDefaults,
        config.packageConfigDefaults,
      ),
    },
  };
}

/**
 * Apply dev-mode workspace package data to CLI serve boot options.
 *
 * Merges `devPortalPackages` and `frameworkPackagePath` into the boot
 * overrides without overwriting any host-provided values already present.
 * Host-provided values always take precedence (they come from the programmatic
 * API or a desktop host that knows better than the workspace scan).
 * @param serveConfig - Existing serve config, possibly already config-derived.
 * @param devWorkspace - Workspace package data from {@link discoverDevWorkspacePackages}.
 * @returns Serve config with dev workspace overrides injected.
 */
export function applyDevWorkspacePackages(
  serveConfig: ServeConfig | undefined,
  devWorkspace: DevWorkspacePackages,
): ServeConfig {
  return {
    ...serveConfig,
    boot: {
      ...serveConfig?.boot,
      // Only inject when the host has not already provided an explicit value.
      devPortalPackages: serveConfig?.boot?.devPortalPackages ?? devWorkspace.devPortalPackages,
      frameworkPackagePath: serveConfig?.boot?.frameworkPackagePath ?? devWorkspace.frameworkPackagePath,
    },
  };
}

/**
 * Merge host-provided package defaults with config-authored defaults.
 * @param left - Existing host-provided defaults.
 * @param right - Config-derived defaults.
 * @returns Merged defaults, or the original defaults when config adds none.
 */
function mergePackageConfigDefaults(
  left: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined,
  right: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined {
  if (right.size === 0) return left;
  return new Map([...(left ?? new Map<string, Readonly<Record<string, unknown>>>()), ...right]);
}
