/**
 * Electrobun application configuration.
 *
 * The main-process entry is pre-built by `build.ts` (via `Bun.build()` with
 * workspace-aware plugins for migration embedding and asset stubbing).
 * Electrobun's config-level module resolution does not support Yarn workspace
 * specifiers, so the plugins cannot live here directly.
 *
 * The `dev` script runs `bun build.ts` automatically before `electrobun dev`.
 *
 * Renderer backend (`bundleCEF`, `defaultRenderer`) and build environment are resolved at build time
 * from the `MAKAIO_VARIANT` and `MAKAIO_RELEASE_TRACK` environment variables via {@link resolveVariantConfig}.
 * Set `MAKAIO_VARIANT=cef` to produce a CEF-bundled distributable; omit or set
 * to `base` for a system-WebView build.
 */

import type { ElectrobunConfig } from 'electrobun';
import pkg from './package.json' with { type: 'json' };
import { resolveVariantConfig, resolveVariantRendererConfig } from './src/variant-config.js';

const variant = resolveVariantConfig(process.env['MAKAIO_VARIANT'], process.env['MAKAIO_RELEASE_TRACK']);

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
      entrypoint: './dist/index.js',
      external: ['electrobun', 'vite', '@makaio/framework'],
      banner: 'var require=import.meta.require;',
    },
    copy: {
      './dist/cli.mjs': 'Resources/app/dist/cli.mjs',
      './dist/variant.json': 'Resources/variant.json',
      './resources/makaio-launcher.sh': 'Resources/makaio-launcher.sh',
      './resources/makaio-launcher-linux.sh': 'Resources/makaio-launcher-linux.sh',
      './resources/makaio.cmd': 'Resources/makaio.cmd',
      './resources/install-cli.sh': 'Resources/install-cli.sh',
      '../../packages/framework/lib': 'Resources/app/node_modules/@makaio/framework/dist',
      '../../packages/framework/package.json': 'Resources/app/node_modules/@makaio/framework/package.json',
      '../../../static/model-registry.yaml': 'Resources/app/dist/static/model-registry.yaml',
    },
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
