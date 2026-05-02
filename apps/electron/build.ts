/**
 * Build script for the Electron main process.
 *
 * Bundles the framework-default main entry to dist/main.mjs via esbuild, then
 * copies the preload script. Native modules are externalized so they resolve
 * at runtime from the packaged app's node_modules (via electron-builder's
 * files + asarUnpack).
 *
 * Usage: node --import tsx build.ts
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildMigrationSourceId, discoverBundledMigrationSources } from '@makaio/host-shared/build/embedded-migrations';
import { resolveStorageMigrationsDir } from '@makaio/host-shared/build/workspace-paths';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { embeddedMigrationsPlugin } from './src/build/embedded-migrations-plugin.js';
import { stubAssetsPlugin } from './src/build/stub-assets-plugin.js';

/** Modules that must NOT be bundled — they contain native .node addons or
 *  platform-specific dynamic requires that esbuild cannot process. */
const EXTERNAL = [
  'electron',
  'libsql',
  'better-sqlite3',
  'cpu-features',
  'node-pty',
  'vite',
  'bun:sqlite',
  'drizzle-orm/bun-sqlite',
];

/**
 * ESM compatibility banner. The output is ESM (`format: 'esm'`) but many
 * bundled dependencies use CJS conventions:
 *
 * - `require()` — needs a CJS-compat shim via `createRequire`
 * - `__dirname` / `__filename` — unavailable in ESM, shimmed via `import.meta`
 */
const ESM_BANNER = [
  "import { createRequire as _makaioCreateRequire } from 'module';",
  'var require = _makaioCreateRequire(import.meta.url);',
  'var __filename = import.meta.filename;',
  'var __dirname = import.meta.dirname;',
].join(' ');

/** Absolute path to this Electron package root. */
const PACKAGE_ROOT = import.meta.dirname;

/** Absolute path to the framework workspace root. */
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);

/** Build-time migration sources embedded for bundled package migrations. */
const MIGRATION_SOURCES = discoverBundledMigrationSources(WORKSPACE_ROOT);

/** Default core migration source id used by `readMigrations()` callers without an explicit input. */
const DEFAULT_MIGRATION_SOURCE_ID = buildMigrationSourceId(WORKSPACE_ROOT, resolveStorageMigrationsDir(PACKAGE_ROOT));

const MAIN_ENTRY_POINT = path.join(PACKAGE_ROOT, 'src/main/main-entry.ts');
const CLI_ENTRY_POINT = path.join(PACKAGE_ROOT, 'src/cli-entry.ts');

mkdirSync(path.join(PACKAGE_ROOT, 'dist'), { recursive: true });

// Main-process entry point — the Electron main process.
await build({
  entryPoints: [MAIN_ENTRY_POINT],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(PACKAGE_ROOT, 'dist/main.mjs'),
  external: EXTERNAL,
  banner: { js: ESM_BANNER },
  plugins: [embeddedMigrationsPlugin(MIGRATION_SOURCES, DEFAULT_MIGRATION_SOURCE_ID), stubAssetsPlugin()],
});

// CLI entry point — invoked by platform launchers via ELECTRON_RUN_AS_NODE=1.
await build({
  entryPoints: [CLI_ENTRY_POINT],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(PACKAGE_ROOT, 'dist/cli.mjs'),
  external: EXTERNAL,
  banner: { js: ESM_BANNER },
  plugins: [embeddedMigrationsPlugin(MIGRATION_SOURCES, DEFAULT_MIGRATION_SOURCE_ID)],
});

copyFileSync(path.join(PACKAGE_ROOT, 'src/main/preload.cjs'), path.join(PACKAGE_ROOT, 'dist/preload.cjs'));
