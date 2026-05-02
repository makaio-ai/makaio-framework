import path from 'node:path';
import { FilesystemDescriptorDiscovery } from './extension-discovery.js';
import type { ExtensionDiscovery } from './extension-discovery.js';
import type { CoreBootOptions } from './boot-types.js';

/**
 * Resolved extension strategies derived from {@link CoreBootOptions}.
 *
 * All fields are concrete (never `undefined`) so callers do not need to
 * repeat the `?? new Filesystem*Discovery()` fallback pattern inline.
 */
export interface ResolvedExtensionOptions {
  /** Resolved extension discovery strategy. */
  extensions: ExtensionDiscovery;
}

/**
 * Resolve discovery strategies from boot options.
 *
 * Applies {@link FilesystemDescriptorDiscovery} as the default when no override
 * is provided so the boot function body remains free of repeated fallback guards.
 * @param options - Platform-agnostic boot options containing discovery overrides.
 * @param makaioHome - Resolved `.makaio` home directory used for filesystem discovery defaults.
 * @returns Concrete extension option values ready for use in the boot sequence.
 */
export function resolveExtensionOptions(options: CoreBootOptions, makaioHome: string): ResolvedExtensionOptions {
  return {
    extensions:
      options.discovery ??
      new FilesystemDescriptorDiscovery(undefined, {
        extensionsDir: path.join(makaioHome, 'extensions'),
        nodeModulesDir: path.join(makaioHome, 'node_modules'),
      }),
  };
}
