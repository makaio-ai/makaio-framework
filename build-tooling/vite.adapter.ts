/**
 * Vite configuration factory for Makaio AI adapters.
 *
 * Adapters require:
 * - Dual browser/node builds
 * - TypeScript declarations
 * - Optional createRequire banner for CJS dependencies
 * - No SCSS (adapters don't have UI)
 */

import { resolve } from 'node:path';
import { type UserConfig, mergeConfig, build } from 'vite';
import {
  type BaseConfigOptions,
  type BuildTarget,
  DEFAULT_EXTERNALS,
  CREATE_REQUIRE_BANNER,
  isExternal,
  createDtsPlugin,
  resolvePackageRoot,
} from './vite.base.js';

/**
 * Configuration options specific to adapters
 */
export interface AdapterConfigOptions extends BaseConfigOptions {
  /**
   * Whether the adapter has CJS dependencies that need createRequire.
   * When true, adds the createRequire banner to the node build.
   * (default: false)
   */
  needsCreateRequire?: boolean;

  /**
   * Additional banner code to prepend to the output.
   * The createRequire banner is added automatically if needsCreateRequire is true.
   */
  banner?: string;
}

/**
 * Creates a Vite configuration for an adapter build targeting a specific platform.
 * @param target - Build target ('browser' or 'node')
 * @param options - Adapter configuration options
 * @returns Vite configuration object
 */
function createTargetConfigForAdapter(target: BuildTarget, options: AdapterConfigOptions): UserConfig {
  const {
    packageRoot,
    entry = 'src/index.ts',
    external = [],
    plugins = [],
    needsCreateRequire = false,
    banner: customBanner,
    overrides = {},
  } = options;

  const allExternals = [...DEFAULT_EXTERNALS, ...external];
  const outDir = resolve(packageRoot, 'dist', target);
  const entryPath = resolve(packageRoot, entry);
  const entryName = entry.replace(/^src\//, '').replace(/\.tsx?$/, '');

  // Build banner for output; node builds may prepend createRequire for CJS deps.
  const bannerParts: string[] = [];
  if (target === 'node' && needsCreateRequire) {
    bannerParts.push(CREATE_REQUIRE_BANNER);
  }
  if (customBanner) {
    bannerParts.push(customBanner);
  }
  const banner = bannerParts.length > 0 ? bannerParts.join('\n') : undefined;

  // For node builds, use SSR mode to properly handle Node.js built-ins
  const ssrConfig = target === 'node' ? { ssr: { target: 'node' as const } } : {};

  const config: UserConfig = {
    root: packageRoot,
    plugins: [createDtsPlugin(outDir, packageRoot), ...plugins],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      target: target === 'browser' ? 'esnext' : 'node22',
      // Enable SSR mode for node builds to properly resolve Node.js built-ins
      ssr: target === 'node',
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${entryName}.js`,
      },
      rollupOptions: {
        external: (id) => {
          if (id === entryPath) return false;
          // Internal package paths (relative or absolute within package)
          if (id.startsWith('.') || id.startsWith(packageRoot)) {
            return false;
          }
          return isExternal(id, allExternals);
        },
        output: {
          preserveModules: false,
          banner,
        },
      },
    },
    define: {
      'process.env.BUILD_TARGET': JSON.stringify(target),
    },
    resolve: {
      conditions:
        target === 'browser' ? ['browser', 'import', 'module', 'default'] : ['node', 'import', 'module', 'default'],
    },
    ...ssrConfig,
  };

  return mergeConfig(config, overrides);
}

/**
 * Creates a Vite configuration for adapter packages.
 *
 * This function returns an array of configurations for both browser and node targets,
 * which Vite will build sequentially.
 * @example
 * ```ts
 * // adapters/implementations/openai-node/vite.config.ts
 * import { createAdapterConfig } from '@makaio/build-tooling/adapter';
 *
 * export default createAdapterConfig({
 *   packageRoot: import.meta.dirname,
 *   external: ['openai'],
 * });
 * ```
 * @example
 * ```ts
 * // For adapters with CJS dependencies
 * import { createAdapterConfig } from '@makaio/build-tooling/adapter';
 *
 * export default createAdapterConfig({
 *   packageRoot: import.meta.dirname,
 *   external: [/^@anthropic-ai\//],
 *   needsCreateRequire: true,
 * });
 * ```
 * @param options - Adapter configuration options
 * @returns Array of Vite configurations for both targets
 */
export function createAdapterConfig(options: AdapterConfigOptions): UserConfig[] {
  return [createTargetConfigForAdapter('browser', options), createTargetConfigForAdapter('node', options)];
}

/**
 * Creates a single-target adapter configuration.
 *
 * Use this when you need to build only one target or need more control
 * over the build process.
 * @param target - Build target ('browser' or 'node')
 * @param options - Adapter configuration options
 * @returns Vite configuration object
 */
export function createSingleTargetAdapterConfig(target: BuildTarget, options: AdapterConfigOptions): UserConfig {
  return createTargetConfigForAdapter(target, options);
}

/**
 * Programmatically builds an adapter for both targets.
 * @example
 * ```ts
 * import { buildAdapter } from '@makaio/build-tooling/adapter';
 *
 * await buildAdapter({
 *   packageRoot: import.meta.dirname,
 *   external: ['openai'],
 * });
 * ```
 * @param options - Adapter configuration options
 */
export async function buildAdapter(options: AdapterConfigOptions): Promise<void> {
  const configs = createAdapterConfig(options);

  for (const config of configs) {
    await build(config);
  }
}

// Re-export useful types and utilities
export { type BuildTarget, type BaseConfigOptions, CREATE_REQUIRE_BANNER, DEFAULT_EXTERNALS, resolvePackageRoot };

// Re-export build from vite for use in build scripts
export { build } from 'vite';
