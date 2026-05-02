import {
  buildDevHostRuntimeOptions as buildSharedDevHostRuntimeOptions,
  HOST_WORKSPACE_ROOT_ENV,
  resolveDevHostOptions as resolveSharedDevHostOptions,
  type DevHostOptions as SharedDevHostOptions,
  type DevHostOptionsResolveOptions,
} from '@makaio/host-shared';
import type { BootMakaioRuntimeOptions } from '@makaio/runtime-node';

export { HOST_WORKSPACE_ROOT_ENV };
export type { DevHostOptionsResolveOptions } from '@makaio/host-shared';

/**
 * Options resolved from the Electron dev-host environment.
 * Present only when the composition root explicitly opts into a host workspace.
 */
export type DevHostOptions = SharedDevHostOptions;

/**
 * Resolve dev-host options from the environment.
 *
 * Reads `MAKAIO_HOST_WORKSPACE_ROOT`. Returns `undefined` when no host
 * workspace override is configured. Browser entrypoints, browser URLs, and
 * theme assets are descriptor/package concerns rather than host env policy.
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
 * Build dev-mode runtime options for a host composition root (Electron, web app, etc.).
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
): Pick<BootMakaioRuntimeOptions, 'discovery'> {
  return buildSharedDevHostRuntimeOptions(options, makaioHome);
}
