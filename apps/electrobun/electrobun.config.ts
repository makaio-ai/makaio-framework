/**
 * Electrobun application configuration.
 *
 * Source-dev builds the main process from `src/main/index.ts` through
 * Electrobun's own Bun build. Packaged builds use the pre-built `dist/index.js`
 * produced by `build.ts`, which owns embedded migrations, asset stubs, and
 * framework package import rewriting for the distributable bundle.
 *
 * Renderer backend (`bundleCEF`, `defaultRenderer`) and build environment are resolved at build time
 * from the `MAKAIO_VARIANT` and `MAKAIO_RELEASE_TRACK` environment variables via {@link resolveVariantConfig}.
 * Set `MAKAIO_VARIANT=cef` to produce a CEF-bundled distributable; omit or set
 * to `base` for a system-WebView build.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectrobunConfig } from 'electrobun';
import pkg from './package.json' with { type: 'json' };
import {
  buildMigrationSourceId,
  discoverBundledMigrationSources,
} from '../host-shared/src/build/embedded-migrations.ts';
import {
  readPackageVersion,
  resolvePackageSetRoot,
  resolveRuntimeNodePackageJsonPath,
  resolveStorageMigrationsDir,
  resolveWorkspaceRoot,
} from '../host-shared/src/build/workspace-paths.ts';
import { embeddedMigrationsPlugin } from './src/build/embedded-migrations-plugin.js';
import { stubAssetsPlugin } from './src/build/stub-assets-plugin.js';
import { resolveVariantConfig, resolveVariantRendererConfig } from './src/variant-config.js';

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);
const PACKAGE_SET_ROOT = resolvePackageSetRoot(WORKSPACE_ROOT);
const variant = resolveVariantConfig(process.env['MAKAIO_VARIANT'], process.env['MAKAIO_RELEASE_TRACK']);
const isSourceDevBuild =
  process.env['MAKAIO_ELECTROBUN_SOURCE_DEV'] === '1' || process.env['NODE_ENV'] === 'development';

/** Renderer backend config shared across all platform targets. */
const rendererConfig = resolveVariantRendererConfig(variant);

/** macOS code signing + notarization config (requires ELECTROBUN_* env vars). */
const macSigningConfig = {
  codesign: true,
  notarize: true,
  entitlements: {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
    'com.apple.security.network.client': true,
    'com.apple.security.network.server': true,
  },
} as const;

const sourceDevCopyEntries = {
  './resources/makaio-launcher.sh': 'Resources/makaio-launcher.sh',
  './resources/makaio-launcher-linux.sh': 'Resources/makaio-launcher-linux.sh',
  './resources/makaio.cmd': 'Resources/makaio.cmd',
  './resources/install-cli.sh': 'Resources/install-cli.sh',
} as const;

/**
 * Convert an absolute workspace path into the relative source path expected by Electrobun copy entries.
 * @param absolutePath - Absolute source path inside the current workspace.
 * @returns POSIX-style path relative to the Electrobun package root.
 */
function toPackageRelativeCopySource(absolutePath: string): string {
  return path.relative(PACKAGE_ROOT, absolutePath).split(path.sep).join('/');
}

const packageCopyEntries = {
  './dist/cli.mjs': 'Resources/app/dist/cli.mjs',
  './dist/renderer': 'dist/renderer',
  './dist/variant.json': 'Resources/variant.json',
  ...sourceDevCopyEntries,
  [toPackageRelativeCopySource(path.join(PACKAGE_SET_ROOT, 'packages', 'framework', 'lib'))]:
    'node_modules/@makaio/framework/dist',
  [toPackageRelativeCopySource(path.join(PACKAGE_SET_ROOT, 'packages', 'framework', 'package.json'))]:
    'node_modules/@makaio/framework/package.json',
  [toPackageRelativeCopySource(path.join(WORKSPACE_ROOT, 'node_modules', 'zod'))]: 'node_modules/zod',
  [toPackageRelativeCopySource(path.join(WORKSPACE_ROOT, 'node_modules', 'drizzle-orm'))]: 'node_modules/drizzle-orm',
  [toPackageRelativeCopySource(path.join(WORKSPACE_ROOT, 'static', 'model-registry.yaml'))]:
    'Resources/app/dist/static/model-registry.yaml',
} as const;

/**
 * Build Bun options needed only when Electrobun compiles the source entry in dev.
 * @returns Source-dev Bun build options.
 */
function createSourceDevBunConfig() {
  const migrationSources = discoverBundledMigrationSources(WORKSPACE_ROOT);
  const defaultMigrationSourceId = buildMigrationSourceId(WORKSPACE_ROOT, resolveStorageMigrationsDir(PACKAGE_ROOT));
  const frameworkVersion = readPackageVersion(resolveRuntimeNodePackageJsonPath(WORKSPACE_ROOT));

  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      __ELECTROBUN_PROJECT_ROOT__: JSON.stringify(PACKAGE_ROOT),
      __FRAMEWORK_VERSION__: JSON.stringify(frameworkVersion),
      __MAKAIO_HOME_DEFAULT__: 'undefined',
    },
    plugins: [embeddedMigrationsPlugin(migrationSources, defaultMigrationSourceId), stubAssetsPlugin()],
  };
}

const sourceDevBunConfig = isSourceDevBuild ? createSourceDevBunConfig() : {};

const config: ElectrobunConfig = {
  app: {
    name: 'Makaio',
    identifier: 'ai.makaio.app',
    version: pkg.version,
  },
  build: {
    buildFolder: variant.buildFolder,
    artifactFolder: variant.artifactFolder,
    bun: {
      entrypoint: isSourceDevBuild ? './src/main/index.ts' : './dist/index.js',
      external: ['vite', '@makaio/framework'],
      banner: 'var require=import.meta.require;',
      naming: 'index.js',
      ...sourceDevBunConfig,
    },
    copy: isSourceDevBuild ? sourceDevCopyEntries : packageCopyEntries,
    mac: { ...rendererConfig, icons: 'icon.iconset', ...macSigningConfig },
    win: { ...rendererConfig, icon: 'icon.iconset/icon_256x256.png' },
    linux: { ...rendererConfig, icon: 'icon.iconset/icon_256x256.png' },
  },
  release: {
    baseUrl: process.env['MAKAIO_RELEASE_URL'] ?? 'https://api.makaio.dev/api/releases',
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
};

export default config;
