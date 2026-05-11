/**
 * Base Vite configuration shared between extensions and adapters.
 *
 * Provides common build settings for dual browser/node ESM output with TypeScript
 * declaration generation.
 */

import { resolve, dirname } from 'node:path';
import { type UserConfig, type PluginOption, mergeConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * Build target - either 'browser' or 'node'
 */
export type BuildTarget = 'browser' | 'node';

/**
 * Return type for createDualTargetConfigs - contains configs for both targets
 */
export interface DualTargetConfigs {
  browser: UserConfig;
  node: UserConfig;
}

/**
 * Base configuration options for all package types
 */
export interface BaseConfigOptions {
  /**
   * Absolute path to package root (directory containing package.json)
   */
  packageRoot: string;

  /**
   * Entry point relative to package root (default: 'src/index.ts')
   */
  entry?: string;

  /**
   * Packages to externalize (not bundle). Workspace packages are automatically
   * externalized. Use this for npm packages that should remain external.
   */
  external?: (string | RegExp)[];

  /**
   * Additional Vite extensions to include
   */
  plugins?: PluginOption[];

  /**
   * Override or extend the default config
   */
  overrides?: UserConfig;
}

/**
 * Pattern to match workspace package imports (\@makaio/*)
 */
export const WORKSPACE_PACKAGE_PATTERN = /^@makaio\//;

/**
 * Default externals for all builds - these are typically provided at runtime.
 * NOTE: Workspace packages (\@makaio/*) are NOT externalized because they don't
 * have pre-built dist directories. They're bundled into each package.
 */
export const DEFAULT_EXTERNALS: (string | RegExp)[] = [
  // Common peer dependencies
  'react',
  'react-dom',
  'react-router',
  // Zod is commonly externalized
  'zod',
];

/**
 * Creates the createRequire banner for Node builds that need CJS interop.
 * This enables `require()` for packages that only have CommonJS exports.
 */
export const CREATE_REQUIRE_BANNER =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

/**
 * Checks if a module ID should be externalized based on the external patterns
 * @param id - The module ID to check
 * @param externals - Array of string or RegExp patterns to match against
 * @returns true if the module should be externalized
 */
export function isExternal(id: string, externals: (string | RegExp)[]): boolean {
  return externals.some((pattern) => {
    if (typeof pattern === 'string') {
      return id === pattern || id.startsWith(`${pattern}/`);
    }
    return pattern.test(id);
  });
}

/**
 * Creates a configured vite-plugin-dts instance with standard options.
 * @param outDir - Output directory for declaration files
 * @param packageRoot - Absolute path to the package root
 * @returns Configured dts plugin
 */
export function createDtsPlugin(outDir: string, packageRoot: string): ReturnType<typeof dts> {
  return dts({
    outDirs: outDir,
    // Restrict to only this package's src - prevents traversing into workspace deps
    entryRoot: resolve(packageRoot, 'src'),
    include: [resolve(packageRoot, 'src')],
    exclude: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    insertTypesEntry: true,
    // Don't emit declaration files for external dependencies
    copyDtsFiles: false,
    // Suppress diagnostic errors from workspace dependencies
    afterDiagnostic: () => {
      // Intentionally empty - swallow diagnostics
    },
  });
}

/**
 * Creates a single-target Vite configuration for library builds.
 * @param target - Build target ('browser' or 'node')
 * @param options - Configuration options
 * @returns Vite configuration object
 */
export function createTargetConfig(target: BuildTarget, options: BaseConfigOptions): UserConfig {
  const { packageRoot, entry = 'src/index.ts', external = [], plugins = [], overrides = {} } = options;

  const allExternals = [...DEFAULT_EXTERNALS, ...external];
  const outDir = resolve(packageRoot, 'dist', target);
  const entryPath = resolve(packageRoot, entry);

  // Extract entry name from path for output naming
  const entryName = entry.replace(/^src\//, '').replace(/\.tsx?$/, '');

  const baseConfig: UserConfig = {
    root: packageRoot,
    plugins: [createDtsPlugin(outDir, packageRoot), ...plugins],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      target: target === 'browser' ? 'esnext' : 'node22',
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${entryName}.js`,
      },
      rollupOptions: {
        external: (id) => {
          // Never externalize the entry point or files within this package
          if (id === entryPath || id.startsWith(packageRoot)) {
            return false;
          }
          return isExternal(id, allExternals);
        },
        output: {
          preserveModules: false,
        },
      },
    },
    define: {
      'process.env.BUILD_TARGET': JSON.stringify(target),
    },
    resolve: {
      // Prefer ESM imports
      conditions:
        target === 'browser' ? ['browser', 'import', 'module', 'default'] : ['node', 'import', 'module', 'default'],
    },
  };

  return mergeConfig(baseConfig, overrides);
}

/**
 * Creates a dual-target Vite configuration that builds both browser and node outputs.
 *
 * This is meant to be used in a custom build script that runs Vite twice:
 * once for each target. For single-file vite.config.ts usage, use the
 * createPluginConfig or createAdapterConfig functions instead.
 * @param options - Configuration options
 * @returns Object with browser and node configurations
 */
export function createDualTargetConfigs(options: BaseConfigOptions): DualTargetConfigs {
  return {
    browser: createTargetConfig('browser', options),
    node: createTargetConfig('node', options),
  };
}

/**
 * Resolves the package root from a config file path (import.meta.url)
 * @param importMetaUrl - The import.meta.url of the config file
 * @returns The absolute path to the package root directory
 */
export function resolvePackageRoot(importMetaUrl: string): string {
  return dirname(importMetaUrl.replace('file://', ''));
}
