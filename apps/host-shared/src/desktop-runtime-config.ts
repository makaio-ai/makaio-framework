/**
 * Desktop runtime config helpers.
 *
 * Desktop hosts use these helpers to overlay the selected `makaio.config.*`
 * runtime config onto host-owned boot metadata. Descriptor discovery and
 * package defaults stay config-owned; desktop chrome stays in the host
 * composition root.
 * @packageDocumentation
 */
import {
  createMakaioConfigDiscovery,
  loadMakaioConfig,
  type CoreBootOptions,
  type LoadMakaioConfigOptions,
  type ParsedMakaioConfig,
} from '@makaio/runtime-node';

type DesktopRuntimeConfigOverlay = Partial<
  Pick<CoreBootOptions, 'discovery' | 'launcherCommand' | 'packageConfigDefaults'>
>;

/** Options for applying the selected desktop runtime config file. */
export type DesktopRuntimeConfigSelectionOptions = Pick<LoadMakaioConfigOptions, 'makaioHome' | 'env'>;

/**
 * Apply a loaded runtime config to desktop boot options.
 *
 * The config owns runtime extension discovery and runtime defaults. Existing
 * host metadata, such as framework version and host capabilities, remains on
 * the input options.
 * @param runtimeOptions - Desktop runtime options assembled from host metadata.
 * @param config - Loaded runtime config, or `undefined` when no config file was selected.
 * @returns Runtime options with config-owned discovery/defaults overlaid.
 */
export function applyDesktopRuntimeConfig<TOptions extends Partial<CoreBootOptions>>(
  runtimeOptions: TOptions,
  config: ParsedMakaioConfig | undefined,
): TOptions & DesktopRuntimeConfigOverlay {
  if (config === undefined) {
    return runtimeOptions;
  }

  return {
    ...runtimeOptions,
    discovery: createMakaioConfigDiscovery(config),
    launcherCommand: config.launcherCommand,
    packageConfigDefaults: config.packageConfigDefaults,
  };
}

/**
 * Load the selected runtime config file and apply it to desktop boot options.
 *
 * Absence of a selected config file preserves the host-selected descriptor
 * discovery path so existing dev/config-backed host metadata remains
 * authoritative until a user or launcher opts into `makaio.config.*`.
 * @param runtimeOptions - Desktop runtime options assembled from host metadata.
 * @param options - Runtime config lookup options.
 * @returns Runtime options with config-owned discovery/defaults when a config file exists.
 */
export async function applySelectedDesktopRuntimeConfig<TOptions extends Partial<CoreBootOptions>>(
  runtimeOptions: TOptions,
  options: DesktopRuntimeConfigSelectionOptions,
): Promise<TOptions & DesktopRuntimeConfigOverlay> {
  const loadedRuntimeConfig = await loadMakaioConfig(options);
  return applyDesktopRuntimeConfig(
    runtimeOptions,
    loadedRuntimeConfig.configPath === undefined ? undefined : loadedRuntimeConfig.config,
  );
}

/**
 * Resolve the launcher command from runtime options.
 *
 * Runtime config owns launcher policy. This helper only preserves the command
 * already carried by the selected runtime options.
 * @param runtimeOptions - Runtime options selected by desktop host metadata or runtime config.
 * @returns Launcher command for boot, or undefined when no layer supplies one.
 */
export function resolveDesktopLauncherCommand(
  runtimeOptions: Partial<CoreBootOptions>,
): CoreBootOptions['launcherCommand'] {
  return runtimeOptions.launcherCommand;
}
