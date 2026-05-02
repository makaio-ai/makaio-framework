import type { ExtensionDiscovery } from './extension-discovery.js';
import {
  buildConfiguredRuntimeOptions,
  type ConfiguredRuntimeOptions,
  type LoadMakaioConfigOptions,
} from './makaio-config.js';

/**
 * Node runtime discovery options.
 *
 * Narrows the generic boot option shape so Node entrypoints can pass the same
 * discovery strategy to both CLI command discovery and runtime boot.
 */
export interface NodeRuntimeOptions extends ConfiguredRuntimeOptions {
  /**
   * Extension discovery strategy selected by runtime config.
   *
   * Corresponds to {@link CoreBootOptions.discovery}. Node entrypoints use the
   * same `makaio.config.*` loader path as the CLI, so runtime extension
   * selection is controlled by explicit config, `MAKAIO_CONFIG_FILE`, or
   * user-home defaults.
   */
  readonly discovery: ExtensionDiscovery;
  /** Host capability tokens for Node.js boot. */
  readonly hostCapabilities: readonly string[];
}

/**
 * Build runtime options for Node.js boot.
 *
 * Runtime extension selection is owned by `makaio.config.*`, including the
 * no-config defaults for installed extension roots. Host capabilities stay out
 * of runtime config and only express the narrow Node.js environment gate used
 * by extension `requires`.
 * @param options - Runtime config lookup options.
 * @returns Runtime options for Node.js boot.
 */
export async function buildNodeRuntimeOptions(options: LoadMakaioConfigOptions): Promise<NodeRuntimeOptions> {
  const configured = await buildConfiguredRuntimeOptions(options);
  return {
    ...configured,
    hostCapabilities: ['node'],
  };
}
