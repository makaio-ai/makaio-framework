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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMigrationSourceId, discoverBundledMigrationSources } from '@makaio/host-shared/build/embedded-migrations';
import { resolveStorageMigrationsDir } from '@makaio/host-shared/build/workspace-paths';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { embeddedMigrationsPlugin } from './src/build/embedded-migrations-plugin.js';
import { stubAssetsPlugin } from './src/build/stub-assets-plugin.js';
import { resolveVariantConfig } from './src/variant-config.js';

/** Modules that must NOT be bundled — they are supplied by the Electrobun runtime or resolved at runtime from node_modules. */
const EXTERNAL = ['electrobun', 'electrobun/bun', 'vite'];

/**
 * CJS interop banner. Bundled `@yarnpkg/*` packages use `eval('require')`
 * which fails in Bun's ESM output. `import.meta.require` is Bun's native
 * require that works in both main processes and Workers.
 */
const CJS_BANNER = 'var require=import.meta.require;';

/** Absolute path to this Electrobun package root. */
const PACKAGE_ROOT = import.meta.dirname;

/** Absolute path to the framework workspace root. */
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);

/** Build-time migration sources embedded for bundled package migrations. */
const MIGRATION_SOURCES = discoverBundledMigrationSources(WORKSPACE_ROOT);

/** Default core migration source id used by `readMigrations()` callers without an explicit input. */
const DEFAULT_MIGRATION_SOURCE_ID = buildMigrationSourceId(WORKSPACE_ROOT, resolveStorageMigrationsDir(PACKAGE_ROOT));

/**
 * Resolve the runtime-node package metadata path across supported source layouts.
 * @param workspaceRoot - Resolved repository root.
 * @returns Absolute path to `@makaio/runtime-node/package.json`.
 */
function resolveFrameworkPackageJsonPath(workspaceRoot: string): string {
  const candidates = [
    path.join(workspaceRoot, 'framework/runtimes/node/package.json'),
    path.join(workspaceRoot, 'runtimes/node/package.json'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `Failed to locate @makaio/runtime-node package metadata. Checked:\n${candidates
        .map((candidate) => `- ${candidate}`)
        .join('\n')}`,
    );
  }
  return resolved;
}

/** Package metadata used to inject the runtime framework version into bundled hosts. */
const FRAMEWORK_PACKAGE_JSON_PATH = resolveFrameworkPackageJsonPath(WORKSPACE_ROOT);

/**
 * Read and validate the framework version used for extension minVersion checks.
 * @param packageJsonPath - Absolute path to `@makaio/runtime-node/package.json`.
 * @returns Validated package version string.
 * @throws Error when the package metadata cannot be parsed or lacks a non-empty string version.
 */
function readFrameworkPackageVersion(packageJsonPath: string): string {
  let parsedPackageJson: unknown;

  try {
    parsedPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read framework version from ${packageJsonPath}: ${reason}`, { cause: error });
  }

  if (typeof parsedPackageJson !== 'object' || parsedPackageJson === null || !('version' in parsedPackageJson)) {
    throw new Error(`Invalid framework package metadata at ${packageJsonPath}: expected a non-empty string "version".`);
  }

  const version = parsedPackageJson.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`Invalid framework package metadata at ${packageJsonPath}: expected a non-empty string "version".`);
  }

  return version;
}

/** Framework version read from `@makaio/runtime-node` at build time and injected via `define`. */
const FRAMEWORK_VERSION = readFrameworkPackageVersion(FRAMEWORK_PACKAGE_JSON_PATH);

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
      __ELECTROBUN_PROJECT_ROOT__: JSON.stringify(PACKAGE_ROOT),
      __FRAMEWORK_VERSION__: JSON.stringify(FRAMEWORK_VERSION),
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
      __FRAMEWORK_VERSION__: JSON.stringify(FRAMEWORK_VERSION),
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

// Emit variant.json so the packager can copy it into the application bundle.
const variantConfig = resolveVariantConfig(process.env['MAKAIO_VARIANT'], process.env['MAKAIO_RELEASE_TRACK']);
writeFileSync(path.join(DIST_DIR, 'variant.json'), `${JSON.stringify(variantConfig, null, 2)}\n`, 'utf-8');
