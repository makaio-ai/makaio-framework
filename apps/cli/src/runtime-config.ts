import { InvalidOptionArgumentError } from 'commander';
import {
  createMakaioConfigDiscovery,
  loadMakaioConfig,
  resolveMakaioHome,
  type ExtensionDiscovery,
  type ParsedMakaioConfig,
} from '@makaio/runtime-node';
import type { ServeConfig } from './main.js';

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

  return {
    argv: parsedRoot.argv,
    discovery: useConfig ? createMakaioConfigDiscovery(loadedConfig.config) : discovery,
    serveConfig:
      loadedConfig.configPath !== undefined || serveConfig === undefined
        ? applyConfigToServeConfig(serveConfig, loadedConfig.config)
        : serveConfig,
  };
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
