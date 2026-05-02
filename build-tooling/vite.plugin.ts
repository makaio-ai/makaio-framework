/**
 * Vite configuration factory for Makaio extensions.
 *
 * Plugins require:
 * - SCSS compilation and CSS extraction
 * - React JSX support
 * - Dual browser/node builds
 * - TypeScript declarations
 */

import { resolve } from 'node:path';
import { type UserConfig, type PluginOption, mergeConfig, build } from 'vite';
import {
  type BaseConfigOptions,
  type BuildTarget,
  DEFAULT_EXTERNALS,
  CREATE_REQUIRE_BANNER,
  WORKSPACE_PACKAGE_PATTERN,
  isExternal,
  createDtsPlugin,
  resolvePackageRoot,
} from './vite.base.js';

/**
 * Configuration options specific to extensions
 */
export interface PluginConfigOptions extends Omit<BaseConfigOptions, 'plugins'> {
  /**
   * Whether to include React plugin (default: true)
   * Set to false if the plugin doesn't use React
   */
  react?: boolean;

  /**
   * Additional Vite extensions to include (React plugin is added automatically)
   */
  plugins?: PluginOption[];

  /**
   * CSS/SCSS configuration options
   */
  css?: {
    /**
     * Extract CSS to separate file (default: true for browser builds)
     */
    extract?: boolean;

    /**
     * CSS modules configuration
     */
    modules?: {
      /**
       * Scoped class name pattern (default: '[name]__[local]--[hash:base64:5]')
       */
      generateScopedName?: string;
    };
  };
}

/**
 * Creates a Vite configuration for a plugin build targeting a specific platform.
 * @param target - Build target ('browser' or 'node')
 * @param options - Plugin configuration options
 * @returns Vite configuration object
 */
function createTargetConfigForPlugin(target: BuildTarget, options: PluginConfigOptions): UserConfig {
  const {
    packageRoot,
    entry = 'src/index.ts',
    external = [],
    plugins = [],
    react = true,
    css = {},
    overrides = {},
  } = options;

  const allExternals = [...DEFAULT_EXTERNALS, ...external];
  const outDir = resolve(packageRoot, 'dist', target);
  const entryPath = resolve(packageRoot, entry);
  const entryName = entry.replace(/^src\//, '').replace(/\.tsx?$/, '');

  // Build plugin array - React plugin must be loaded dynamically if needed
  const buildPlugins: PluginOption[] = [createDtsPlugin(outDir, packageRoot), ...plugins];

  const config: UserConfig = {
    root: packageRoot,
    plugins: buildPlugins,
    css: {
      modules: {
        generateScopedName: css.modules?.generateScopedName ?? '[name]__[local]--[hash:base64:5]',
      },
      preprocessorOptions: {
        scss: {
          // Suppress deprecation warnings from dependencies
          silenceDeprecations: ['legacy-js-api'],
        },
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      target: target === 'browser' ? 'esnext' : 'node22',
      cssCodeSplit: false,
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${entryName}.js`,
      },
      rollupOptions: {
        external: (id) => {
          if (id === entryPath) return false;
          // Internal package paths (relative or absolute within package)
          if (id.startsWith('.') || (id.startsWith(packageRoot) && !WORKSPACE_PACKAGE_PATTERN.test(id))) {
            return false;
          }
          return isExternal(id, allExternals);
        },
        output: {
          preserveModules: false,
          // CSS extraction - only for browser builds by default
          assetFileNames: target === 'browser' && (css.extract ?? true) ? `${entryName}.[ext]` : undefined,
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
    esbuild: react
      ? {
          jsx: 'automatic',
        }
      : undefined,
  };

  return mergeConfig(config, overrides);
}

/**
 * Creates a Vite configuration for plugin packages.
 *
 * This function returns an array of configurations for both browser and node targets,
 * which Vite will build sequentially.
 * @example
 * ```ts
 * // extensions/chat/vite.config.ts
 * import { createPluginConfig } from '@makaio/build-tooling/plugin';
 *
 * export default createPluginConfig({
 *   packageRoot: import.meta.dirname,
 * });
 * ```
 * @param options - Plugin configuration options
 * @returns Array of Vite configurations for both targets
 */
export function createPluginConfig(options: PluginConfigOptions): UserConfig[] {
  return [createTargetConfigForPlugin('browser', options), createTargetConfigForPlugin('node', options)];
}

/**
 * Creates a single-target plugin configuration.
 *
 * Use this when you need to build only one target or need more control
 * over the build process.
 * @param target - Build target ('browser' or 'node')
 * @param options - Plugin configuration options
 * @returns Vite configuration object
 */
export function createSingleTargetPluginConfig(target: BuildTarget, options: PluginConfigOptions): UserConfig {
  return createTargetConfigForPlugin(target, options);
}

/**
 * Programmatically builds a plugin for both targets.
 * @example
 * ```ts
 * import { buildPlugin } from '@makaio/build-tooling/plugin';
 *
 * await buildPlugin({
 *   packageRoot: import.meta.dirname,
 * });
 * ```
 * @param options - Plugin configuration options
 */
export async function buildPlugin(options: PluginConfigOptions): Promise<void> {
  const configs = createPluginConfig(options);

  for (const config of configs) {
    await build(config);
  }
}

// Re-export useful types and utilities
export { type BuildTarget, type BaseConfigOptions, CREATE_REQUIRE_BANNER, resolvePackageRoot };

// Re-export DEFAULT_EXTERNALS for extension
export { DEFAULT_EXTERNALS };

// Re-export vite build function to ensure consumers use the same vite version
export { build } from 'vite';
