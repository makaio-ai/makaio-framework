import path from 'node:path';
import {
  buildDevHostRuntimeOptionsCore,
  HOST_WORKSPACE_ROOT_ENV,
  resolveDevHostOptions as resolveSharedDevHostOptions,
  type DevHostDiscoveryFactoryOptions,
  type DevHostOptions,
  type DevHostOptionsResolveOptions,
} from '@makaio/host-shared';
import type { CoreBootOptions, ExtensionDiscovery, DiscoveredExtension } from '@makaio/runtime-bun';

export { HOST_WORKSPACE_ROOT_ENV };
export type { DevHostOptions, DevHostOptionsResolveOptions } from '@makaio/host-shared';

/**
 * Lazy descriptor discovery for dev hosts.
 *
 * Keeping `@makaio/runtime-bun` behind `discover()` lets build mode construct
 * plugin options without loading runtime source modules that are only needed by
 * the dev bus server.
 */
class DevHostDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param workspaceRoot - Workspace root containing extension descriptors.
   * @param makaioHome - Resolved `.makaio` home directory for installed/global extension scanning.
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly makaioHome: string,
  ) {}

  /**
   * Load runtime-bun discovery only when the dev runtime asks for descriptors.
   * @returns Extension descriptors discovered from the workspace root.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const { FilesystemDescriptorDiscovery } = await import('@makaio/runtime-bun');
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
 * Resolve dev-host options from the environment.
 *
 * Reads `MAKAIO_HOST_WORKSPACE_ROOT`. Returns `undefined` when no host
 * workspace override is configured. Capability env policy is intentionally not
 * parsed here; runtime boot capabilities own `requires` gating.
 * @param env - The process environment to read from.
 * @param options - Path resolution options for env-file values.
 * @returns Resolved options, or `undefined` when no host workspace override is configured.
 * @throws Error when any configured path is relative.
 */
export function resolveDevHostOptions(
  env: NodeJS.ProcessEnv,
  options: DevHostOptionsResolveOptions = {},
): DevHostOptions | undefined {
  return resolveSharedDevHostOptions(env, options);
}

/**
 * Build dev-mode runtime options for a host composition root.
 *
 * Pins descriptor discovery to the configured host workspace root. Runtime
 * environment capability tokens are added at the boot boundary.
 * @param options - Resolved dev-host options.
 * @param makaioHome - Resolved `.makaio` home directory for installed/global extension scanning.
 * @returns Runtime options for dev boot.
 */
export function buildDevHostRuntimeOptions(
  options: Pick<DevHostOptions, 'workspaceRoot'>,
  makaioHome: string,
): Pick<CoreBootOptions, 'discovery'> {
  return buildDevHostRuntimeOptionsCore(
    options,
    makaioHome,
    ({ workspaceRoot, makaioHome: resolvedMakaioHome }: DevHostDiscoveryFactoryOptions) =>
      new DevHostDescriptorDiscovery(workspaceRoot, resolvedMakaioHome),
  );
}
