/**
 * Build script for the Electrobun main process and CLI bundle.
 *
 * Produces two bundles via `Bun.build()`:
 * - `dist/index.js`  — main-process entry, loaded by the Electrobun runtime.
 * - `dist/cli.mjs`   — CLI entry, exec'd by platform launchers (makaio-launcher.sh).
 *
 * Also writes `dist/variant.json` from the `MAKAIO_VARIANT` and `MAKAIO_RELEASE_TRACK`
 * env vars, enabling the packager to copy variant metadata into the application bundle at build time.
 *
 * The `electrobun` package is externalized so it resolves at runtime from the
 * packaged app's native module directory. A CJS interop banner
 * (`var require=import.meta.require;`) is prepended to both bundles because
 * bundled `@yarnpkg/*` packages use `eval('require')` which fails in Bun's
 * ESM output. `import.meta.require` is Bun's native require and works in
 * both main processes and Workers.
 *
 * Usage: bun run build.ts
 */
import { build } from 'bun';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMigrationSourceId, discoverBundledMigrationSources } from '@makaio/host-shared/build/embedded-migrations';
import {
  readPackageVersion,
  resolveRuntimeNodePackageJsonPath,
  resolveStorageMigrationsDir,
  resolveWorkspaceRoot,
} from '@makaio/host-shared/build/workspace-paths';
import { embeddedMigrationsPlugin } from './src/build/embedded-migrations-plugin.js';
import {
  frameworkExternalPackageNames,
  rewriteFrameworkImportsInText,
} from '@makaio/build-tooling/framework-import-map';
import { stubAssetsPlugin } from './src/build/stub-assets-plugin.js';
import { resolveVariantConfig } from './src/variant-config.js';

/**
 * Modules that must NOT be bundled — they are supplied by the Electrobun
 * runtime or resolved at runtime from node_modules.
 *
 * Framework public surface packages (e.g. `@makaio/bus-core`) are added
 * dynamically by {@link frameworkExternalPackageNames} so they survive as
 * external imports in the bundle. A post-processing step rewrites them to
 * `@makaio/framework/*` subpath specifiers.
 */
const EXTERNAL = ['vite', ...frameworkExternalPackageNames()];

/**
 * CJS interop banner. Bundled `@yarnpkg/*` packages use `eval('require')`
 * which fails in Bun's ESM output. `import.meta.require` is Bun's native
 * require that works in both main processes and Workers.
 */
const CJS_BANNER = 'var require=import.meta.require;';

/** Absolute path to this Electrobun package root. */
const PACKAGE_ROOT = import.meta.dirname;

/** Absolute path to the source workspace root. */
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);

/** Build-time migration sources embedded for bundled package migrations. */
const MIGRATION_SOURCES = discoverBundledMigrationSources(WORKSPACE_ROOT);

/** Default core migration source id used by `readMigrations()` callers without an explicit input. */
const DEFAULT_MIGRATION_SOURCE_ID = buildMigrationSourceId(WORKSPACE_ROOT, resolveStorageMigrationsDir(PACKAGE_ROOT));

/** Package metadata used to inject the runtime version into bundled hosts. */
const RUNTIME_NODE_PACKAGE_JSON_PATH = resolveRuntimeNodePackageJsonPath(WORKSPACE_ROOT);

/** Framework version read from `@makaio/runtime-node` at build time and injected via `define`. */
const FRAMEWORK_VERSION = readPackageVersion(RUNTIME_NODE_PACKAGE_JSON_PATH);

/** Variant config resolved at build time for define injection and artifact metadata. */
const VARIANT_CONFIG = resolveVariantConfig(process.env['MAKAIO_VARIANT'], process.env['MAKAIO_RELEASE_TRACK']);

/** Default MAKAIO_HOME directory name, variant-aware. Stable uses `.makaio`; other tracks use `.makaio-{track}`. */
const MAKAIO_HOME_DEFAULT =
  VARIANT_CONFIG.releaseTrack === 'stable' ? '.makaio' : `.makaio-${VARIANT_CONFIG.releaseTrack}`;

const MAIN_ENTRY_POINT = path.join(PACKAGE_ROOT, 'src/main/index.ts');
const CLI_ENTRY_POINT = path.join(PACKAGE_ROOT, 'src/cli-entry.ts');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

mkdirSync(DIST_DIR, { recursive: true });

// Run both builds in parallel — they share no mutable state.
const [mainResult, cliResult] = await Promise.all([
  // Main-process entry point — loaded by the Electrobun runtime.
  build({
    entrypoints: [MAIN_ENTRY_POINT],
    outdir: DIST_DIR,
    target: 'bun',
    external: EXTERNAL,
    banner: CJS_BANNER,
    naming: 'index.js',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __FRAMEWORK_VERSION__: JSON.stringify(FRAMEWORK_VERSION),
      __MAKAIO_HOME_DEFAULT__: JSON.stringify(MAKAIO_HOME_DEFAULT),
    },
    plugins: [embeddedMigrationsPlugin(MIGRATION_SOURCES, DEFAULT_MIGRATION_SOURCE_ID), stubAssetsPlugin()],
  }),
  // CLI entry point — exec'd by platform launchers (makaio-launcher.sh et al.).
  build({
    entrypoints: [CLI_ENTRY_POINT],
    outdir: DIST_DIR,
    target: 'bun',
    external: EXTERNAL,
    banner: CJS_BANNER,
    naming: 'cli.mjs',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __FRAMEWORK_VERSION__: JSON.stringify(FRAMEWORK_VERSION),
      __MAKAIO_HOME_DEFAULT__: JSON.stringify(MAKAIO_HOME_DEFAULT),
    },
    plugins: [embeddedMigrationsPlugin(MIGRATION_SOURCES, DEFAULT_MIGRATION_SOURCE_ID)],
  }),
]);

for (const [label, result] of [
  ['main', mainResult],
  ['cli', cliResult],
] as const) {
  if (!result.success) {
    console.error(`Build target "${label}" failed:`);
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }
}

// Rewrite externalized workspace specifiers to @makaio/framework/* subpaths.
// Bun.build preserves the original import specifier for external modules, so
// this post-processing step is required to produce the final framework-subpath
// imports that Electrobun's re-bundle and runtime resolution expect.
for (const filename of ['index.js', 'cli.mjs'] as const) {
  const filePath = path.join(DIST_DIR, filename);
  const original = readFileSync(filePath, 'utf-8');
  const rewritten = rewriteFrameworkImportsInText(original);
  if (rewritten !== original) {
    writeFileSync(filePath, rewritten, 'utf-8');
  }
}

// Emit variant.json so the packager can copy it into the application bundle.
writeFileSync(path.join(DIST_DIR, 'variant.json'), `${JSON.stringify(VARIANT_CONFIG, null, 2)}\n`, 'utf-8');
