import path from 'node:path';
import {
  normalizeNodeHostCapabilities,
  type ExtensionDiscovery,
  type CoreBootOptions,
  type DiscoveredExtension,
} from '@makaio/runtime-node';

export { normalizeNodeHostCapabilities };

/** Environment variable that opts dev hosts into workspace descriptor discovery. */
export const HOST_WORKSPACE_ROOT_ENV = 'MAKAIO_HOST_WORKSPACE_ROOT';

/**
 * Options resolved from the shared dev-host environment.
 * Present only when the composition root explicitly opts into a host workspace.
 */
export interface DevHostOptions {
  /** Workspace root to scan for extension descriptors. */
  readonly workspaceRoot: string;
}

/** Optional base directory for resolving path-like host env values. */
export interface DevHostOptionsResolveOptions {
  /** Base directory used to resolve relative paths from env files. */
  readonly baseDir?: string;
}

/**
 * Inputs needed to construct host-specific extension discovery.
 */
export interface DevHostDiscoveryFactoryOptions {
  /** Workspace root containing extension descriptors. */
  readonly workspaceRoot: string;
  /** Resolved `.makaio` home directory for installed/global extension scanning. */
  readonly makaioHome: string;
}

/**
 * Shared runtime boot surface assembled from dev-host options.
 * @typeParam TExtensionDiscovery - Host-specific discovery implementation.
 */
export interface DevHostRuntimeOptions<TExtensionDiscovery extends ExtensionDiscovery> {
  readonly discovery: TExtensionDiscovery;
}

/**
 * Lazy descriptor discovery for Node-based dev hosts.
 *
 * Vite evaluates config files during production renderer builds too. Keeping
 * `@makaio/runtime-node` behind `discover()` lets build mode construct plugin
 * options without loading runtime source modules that are only needed by the
 * dev bus server.
 */
class NodeDevHostDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param workspaceRoot - Workspace root containing extension descriptors.
   * @param makaioHome - Resolved `.makaio` home directory for installed/global extension scanning.
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly makaioHome: string,
  ) {}

  /**
   * Load runtime-node discovery only when the dev runtime asks for descriptors.
   * @returns Extension descriptors discovered from the workspace root.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const { FilesystemDescriptorDiscovery } = await import('@makaio/runtime-node');
    const extensions = await new FilesystemDescriptorDiscovery(this.workspaceRoot, {
      extensionsDir: path.join(this.makaioHome, 'extensions'),
      nodeModulesDir: path.join(this.makaioHome, 'node_modules'),
    }).discover();

    if (extensions.length === 0) {
      throw new Error(
        `${HOST_WORKSPACE_ROOT_ENV} points to '${this.workspaceRoot}' but no extension descriptors were discovered.`,
      );
    }

    return extensions;
  }
}

/**
 * Read an optional string from the environment.
 *
 * Trims whitespace and returns `undefined` for unset or blank values.
 * @param env - The process environment to read from.
 * @param name - Environment variable name.
 * @returns Trimmed value, or `undefined` when unset/blank.
 */
export function resolveOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

/**
 * Resolve an optional absolute path environment variable.
 *
 * Shared across host composition roots so path-like env parsing stays
 * consistent in one place.
 * @param env - The process environment to read from.
 * @param name - Environment variable name.
 * @param options - Path resolution options.
 * @returns Absolute path value, or `undefined` when unset.
 * @throws Error when the variable is set to a relative path and no `baseDir` is provided.
 */
export function resolveOptionalPath(
  env: NodeJS.ProcessEnv,
  name: string,
  options: DevHostOptionsResolveOptions,
): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;

  if (path.isAbsolute(value)) {
    return value;
  }

  if (options.baseDir !== undefined) {
    return path.resolve(options.baseDir, value);
  }

  throw new Error(`${name} must be an absolute path, got: ${value}`);
}

/**
 * Assert a resolved host path is reachable through the configured workspace root.
 *
 * Shared across host composition roots so workspace allowlist checks stay in
 * one place.
 * @param workspaceRoot - Host workspace root used by the filesystem allowlist.
 * @param value - Resolved path to validate.
 * @param name - Environment variable name for diagnostics.
 */
export function assertPathInsideWorkspaceRoot(workspaceRoot: string, value: string | undefined, name: string): void {
  if (value === undefined) return;

  const relative = path.relative(workspaceRoot, value);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`${name} must resolve inside ${HOST_WORKSPACE_ROOT_ENV} (${workspaceRoot}), got: ${value}`);
}

/**
 * Resolve shared dev-host options from the environment.
 *
 * Reads `MAKAIO_HOST_WORKSPACE_ROOT`. Returns `undefined` when no host
 * workspace override is configured. Host capability tokens are intentionally
 * not resolved from env; runtime boot capabilities own `requires` gating.
 * @param env - The process environment to read from.
 * @param options - Path resolution options for env-file values.
 * @returns Resolved options, or `undefined` when no host workspace override is configured.
 * @throws Error when any configured path is relative.
 */
export function resolveDevHostOptions(
  env: NodeJS.ProcessEnv,
  options: DevHostOptionsResolveOptions = {},
): DevHostOptions | undefined {
  const workspaceRoot = resolveOptionalPath(env, HOST_WORKSPACE_ROOT_ENV, options);
  if (workspaceRoot === undefined) {
    return undefined;
  }

  return {
    workspaceRoot,
  };
}

/**
 * Build the shared portion of dev-mode runtime options for a host composition root.
 *
 * Pins descriptor discovery to the configured host workspace root. Runtime
 * environment gates such as `hostCapabilities` are owned by the boot boundary,
 * not by dev-host env parsing.
 * @typeParam TExtensionDiscovery - Host-specific discovery implementation.
 * @param options - Resolved dev-host options.
 * @param makaioHome - Resolved `.makaio` home directory for installed/global extension scanning.
 * @param createExtensionDiscovery - Host-specific extension discovery factory.
 * @returns Shared runtime options for dev boot.
 */
export function buildDevHostRuntimeOptionsCore<TExtensionDiscovery extends ExtensionDiscovery>(
  options: Pick<DevHostOptions, 'workspaceRoot'>,
  makaioHome: string,
  createExtensionDiscovery: (options: DevHostDiscoveryFactoryOptions) => TExtensionDiscovery,
): DevHostRuntimeOptions<TExtensionDiscovery> {
  if (!path.isAbsolute(options.workspaceRoot)) {
    throw new Error(`${HOST_WORKSPACE_ROOT_ENV} must be an absolute path, got: ${options.workspaceRoot}`);
  }

  return {
    discovery: createExtensionDiscovery({
      workspaceRoot: options.workspaceRoot,
      makaioHome,
    }),
  };
}

/**
 * Build Node-based dev-mode runtime options for a host composition root.
 *
 * Used by Vite dev bus hosts that boot `@makaio/runtime-node`. Capability
 * tokens are intentionally omitted; the Vite/runtime boot boundary adds
 * Node environment tokens when it calls `bootMakaioRuntime`.
 * @param options - Resolved dev-host options.
 * @param makaioHome - Resolved `.makaio` home directory for installed/global extension scanning.
 * @returns Runtime options for Node-based dev boot.
 */
export function buildDevHostRuntimeOptions(
  options: Pick<DevHostOptions, 'workspaceRoot'>,
  makaioHome: string,
): Pick<CoreBootOptions, 'discovery'> {
  return buildDevHostRuntimeOptionsCore(
    options,
    makaioHome,
    ({ workspaceRoot, makaioHome: resolvedMakaioHome }) =>
      new NodeDevHostDescriptorDiscovery(workspaceRoot, resolvedMakaioHome),
  );
}
