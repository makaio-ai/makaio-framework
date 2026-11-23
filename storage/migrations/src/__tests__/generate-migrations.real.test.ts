/**
 * Real, unmocked exercise of {@link generateMigrations}.
 *
 * `generate-migrations.test.ts` proves the orchestrator's logic against
 * recording fakes of `runCommand` and `readNewestJournalTag`; this file proves
 * the same orchestrator against a genuine `drizzle-kit generate` subprocess
 * for both the SQLite and Postgres legs, run twice (ordinary, then
 * `--custom`) inside a fully isolated temporary workspace. There is no
 * `vi.mock` and no `__internals` override here — `generate-migrations.test.ts`'s
 * module mock is file-scoped and does not apply to this file.
 *
 * The workspace is a throwaway copy of both real migration chains plus a
 * fixture schema package declaring two new tables; every write lands under
 * the temporary root and is deleted in `afterEach`, even when setup, import,
 * or generation fails.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSchemas, type DiscoveredSchema } from '../discover-schemas.js';

const execFileAsync = promisify(execFile);

/** This package's root, `storage/migrations`. */
const MIGRATIONS_PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');
/** The sibling Postgres engine package's root, `storage/pg`. */
const PG_PACKAGE_ROOT = path.resolve(MIGRATIONS_PACKAGE_ROOT, '../pg');
/** Repository root, resolved from this test file's real location. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** Source for the temporary ESM/TS runner that invokes the real orchestrator. */
const RUNNER_SOURCE = `import fs from 'node:fs';
import { generateMigrations } from './framework/storage/migrations/src/generate-migrations.js';

const [, , resultPath, workspaceRoot, name, customFlag] = process.argv;

generateMigrations({ workspaceRoot, name, custom: customFlag === 'true' })
  .then((result) => {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, result }));
  })
  .catch((error) => {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
    );
    process.exitCode = 1;
  });
`;

/**
 * Resolve an installed package's root directory by name, tolerating packages
 * whose `package.json` is not exported under the `./package.json` subpath
 * (`drizzle-kit`, `drizzle-orm`): falls back to resolving the package's main
 * entry point and walking up to the nearest `package.json` whose `name` field
 * matches.
 * @param name - Package name to resolve (e.g. `drizzle-kit`).
 * @returns Absolute path to the package's root directory.
 * @throws When no matching `package.json` can be found while walking up from
 *   the resolved entry point.
 */
function resolvePackageRoot(name: string): string {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    let dir = path.dirname(require.resolve(name));
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === name) {
          return dir;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`Could not resolve package root for '${name}'`);
      }
      dir = parent;
    }
  }
}

/**
 * Resolve the real, installed `tsx` CLI entry point from its manifest `bin`
 * field (a bare string, since the package name and its single binary match).
 * @param tsxRoot - Absolute root of the installed `tsx` package.
 * @returns Absolute path to the `tsx` CLI script.
 */
function resolveTsxCliPath(tsxRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(tsxRoot, 'package.json'), 'utf-8')) as { bin?: string };
  if (typeof pkg.bin !== 'string') {
    throw new Error(`Expected tsx's package.json 'bin' field to be a string, got ${JSON.stringify(pkg.bin)}`);
  }
  return path.join(tsxRoot, pkg.bin);
}

/**
 * Create a directory symlink, creating the link's parent directory first.
 * @param target - Absolute path the symlink points at.
 * @param linkPath - Absolute path of the symlink to create.
 */
function symlinkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

/** Everything the test needs to drive two real generation runs against one workspace. */
interface WorkspaceHandles {
  /** Absolute temporary workspace root. */
  readonly workspace: string;
  /** Absolute copied SQLite chain directory. */
  readonly sqliteChainDir: string;
  /** Absolute copied Postgres chain directory. */
  readonly pgChainDir: string;
  /** Absolute path of the temporary runner script. */
  readonly runnerPath: string;
  /** Absolute path to the real, installed `tsx` CLI. */
  readonly tsxCliPath: string;
  /** Child-process environment for every runner invocation. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Render the fixture's SQLite schema module: re-exports of every real
 * discovered SQLite schema file, plus two new fixture tables with a foreign
 * key from child to parent.
 * @param realSchemas - Real SQLite schemas discovered before isolation.
 * @returns TypeScript source for `schema.sqlite.ts`.
 */
function renderSqliteFixtureSchema(realSchemas: readonly DiscoveredSchema[]): string {
  const reExports = realSchemas.map((s) => `export * from '${s.schemaPath.replace(/\\/g, '/')}';`).join('\n');
  return `import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

${reExports}

export const realGeneratorParent = sqliteTable('real_generator_parent', {
  id: text('id').primaryKey(),
});

export const realGeneratorChild = sqliteTable('real_generator_child', {
  id: text('id').primaryKey(),
  parentId: text('parent_id')
    .notNull()
    .references(() => realGeneratorParent.id),
});
`;
}

/**
 * Render the fixture's Postgres schema module: re-exports of every real
 * discovered Postgres schema file, plus the same two fixture tables declared
 * with `pgTable`.
 * @param realSchemas - Real Postgres schemas discovered before isolation.
 * @returns TypeScript source for `schema.postgres.ts`.
 */
function renderPostgresFixtureSchema(realSchemas: readonly DiscoveredSchema[]): string {
  const reExports = realSchemas.map((s) => `export * from '${s.schemaPath.replace(/\\/g, '/')}';`).join('\n');
  return `import { pgTable, text } from 'drizzle-orm/pg-core';

${reExports}

export const realGeneratorParent = pgTable('real_generator_parent', {
  id: text('id').primaryKey(),
});

export const realGeneratorChild = pgTable('real_generator_child', {
  id: text('id').primaryKey(),
  parentId: text('parent_id')
    .notNull()
    .references(() => realGeneratorParent.id),
});
`;
}

/**
 * Copy the real generator sources, package manifests, drizzle-kit configs,
 * and the normalize script into the temporary workspace, unmodified.
 * @param T - Absolute temporary workspace root.
 */
function copyGeneratorAssets(T: string): void {
  const tMigrationsRoot = path.join(T, 'framework', 'storage', 'migrations');
  const tPgRoot = path.join(T, 'framework', 'storage', 'pg');

  for (const file of ['generate-migrations.ts', 'generate-schema.ts', 'discover-schemas.ts']) {
    fs.copyFileSync(path.join(MIGRATIONS_PACKAGE_ROOT, 'src', file), path.join(tMigrationsRoot, 'src', file));
  }
  fs.copyFileSync(path.join(MIGRATIONS_PACKAGE_ROOT, 'package.json'), path.join(tMigrationsRoot, 'package.json'));
  fs.copyFileSync(
    path.join(MIGRATIONS_PACKAGE_ROOT, 'drizzle.config.ts'),
    path.join(tMigrationsRoot, 'drizzle.config.ts'),
  );
  fs.copyFileSync(path.join(PG_PACKAGE_ROOT, 'package.json'), path.join(tPgRoot, 'package.json'));
  fs.copyFileSync(path.join(PG_PACKAGE_ROOT, 'drizzle.config.ts'), path.join(tPgRoot, 'drizzle.config.ts'));
  fs.copyFileSync(
    path.join(PG_PACKAGE_ROOT, 'scripts', 'normalize-migrations.ts'),
    path.join(tPgRoot, 'scripts', 'normalize-migrations.ts'),
  );

  fs.cpSync(path.join(MIGRATIONS_PACKAGE_ROOT, 'drizzle'), path.join(tMigrationsRoot, 'drizzle'), { recursive: true });
  fs.cpSync(path.join(PG_PACKAGE_ROOT, 'drizzle-postgres'), path.join(tPgRoot, 'drizzle-postgres'), {
    recursive: true,
  });
}

/**
 * Symlink the real installed packages the copied generator sources need at
 * runtime into the workspace's `node_modules`, plus a `.bin/tsx` symlink to
 * the real `tsx` CLI. `@makaio/storage-pg` is the one exception: it is
 * symlinked exclusively to the workspace's own temporary Postgres package so
 * a real `node_modules` tree is never linked wholesale (which could let
 * resolution fall through to the real, non-temporary Postgres package).
 * @param T - Absolute temporary workspace root.
 * @returns The resolved real `tsx` CLI path, for the runner invocation.
 */
function linkRealPackages(T: string): string {
  const tNodeModules = path.join(T, 'node_modules');
  const tPgRoot = path.join(T, 'framework', 'storage', 'pg');

  const drizzleKitRoot = resolvePackageRoot('drizzle-kit');
  const drizzleOrmRoot = resolvePackageRoot('drizzle-orm');
  const tsxRoot = resolvePackageRoot('tsx');
  const storageDrizzleRoot = resolvePackageRoot('@makaio/storage-drizzle');
  const utilsRoot = resolvePackageRoot('@makaio/utils');
  const tsxCliPath = resolveTsxCliPath(tsxRoot);

  symlinkDir(drizzleKitRoot, path.join(tNodeModules, 'drizzle-kit'));
  symlinkDir(drizzleOrmRoot, path.join(tNodeModules, 'drizzle-orm'));
  symlinkDir(tsxRoot, path.join(tNodeModules, 'tsx'));
  symlinkDir(storageDrizzleRoot, path.join(tNodeModules, '@makaio', 'storage-drizzle'));
  symlinkDir(utilsRoot, path.join(tNodeModules, '@makaio', 'utils'));
  symlinkDir(tPgRoot, path.join(tNodeModules, '@makaio', 'storage-pg'));

  fs.mkdirSync(path.join(tNodeModules, '.bin'), { recursive: true });
  fs.symlinkSync(tsxCliPath, path.join(tNodeModules, '.bin', 'tsx'), 'file');

  return tsxCliPath;
}

/**
 * Discover the real SQLite and Postgres schema file lists (before isolation),
 * then write the temporary fixture package that re-exports them plus two new
 * fixture tables, so the real `discoverSchemas(T)` finds only this package.
 * @param T - Absolute temporary workspace root.
 */
async function writeFixtureSchema(T: string): Promise<void> {
  const tFixtureRoot = path.join(T, 'fixtures', 'schema');
  const realSqliteSchemas = await discoverSchemas(REPO_ROOT, undefined, 'sqlite');
  const realPostgresSchemas = await discoverSchemas(REPO_ROOT, undefined, 'postgres');

  fs.writeFileSync(
    path.join(tFixtureRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'migration-real-schema',
        private: true,
        type: 'module',
        makaio: { drizzleSchema: { sqlite: './schema.sqlite.ts', postgres: './schema.postgres.ts' } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(tFixtureRoot, 'schema.sqlite.ts'), renderSqliteFixtureSchema(realSqliteSchemas));
  fs.writeFileSync(path.join(tFixtureRoot, 'schema.postgres.ts'), renderPostgresFixtureSchema(realPostgresSchemas));
}

/**
 * Build the isolated temporary workspace: directories, copied generator
 * sources and chains, package symlinks, the fixture schema, and the runner
 * script. The caller owns the directory before setup starts.
 * @param T - Temporary workspace root already registered for cleanup.
 * @returns Handles into the built workspace.
 */
async function buildWorkspace(T: string): Promise<WorkspaceHandles> {
  fs.mkdirSync(path.join(T, 'framework', 'storage', 'migrations', 'src'), { recursive: true });
  fs.mkdirSync(path.join(T, 'framework', 'storage', 'pg', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(T, 'fixtures', 'schema'), { recursive: true });
  fs.mkdirSync(path.join(T, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(T, 'tmp'), { recursive: true });

  fs.writeFileSync(
    path.join(T, 'package.json'),
    JSON.stringify(
      { name: 'migration-real-fixture', private: true, type: 'module', workspaces: ['fixtures/*'] },
      null,
      2,
    ),
  );

  copyGeneratorAssets(T);
  const tsxCliPath = linkRealPackages(T);
  await writeFixtureSchema(T);

  const runnerPath = path.join(T, 'run-generator.ts');
  fs.writeFileSync(runnerPath, RUNNER_SOURCE);

  const tBin = path.join(T, 'node_modules', '.bin');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tBin}${path.delimiter}${process.env.PATH ?? ''}`,
    TMPDIR: path.join(T, 'tmp'),
    TMP: path.join(T, 'tmp'),
    TEMP: path.join(T, 'tmp'),
    TSX_DISABLE_CACHE: '1',
  };

  return {
    workspace: T,
    sqliteChainDir: path.join(T, 'framework', 'storage', 'migrations', 'drizzle'),
    pgChainDir: path.join(T, 'framework', 'storage', 'pg', 'drizzle-postgres'),
    runnerPath,
    tsxCliPath,
    env,
  };
}

/** One generation leg's outcome, as reported by the real orchestrator. */
interface RunnerLeg {
  readonly dialect: string;
  readonly chainDir: string;
  readonly ran: boolean;
  readonly reason?: string;
}

/** Result written to disk by the temporary runner script. */
interface RunnerResult {
  readonly ok: boolean;
  readonly result?: { readonly name: string; readonly legs: readonly RunnerLeg[] };
  readonly error?: string;
}

/**
 * Run the temporary runner script as a real, `tsx`-executed child process and
 * return its JSON-encoded result. Reads the result file even when the child
 * exits non-zero, so a thrown orchestrator error still surfaces as a readable
 * `RunnerResult` instead of an opaque process-exit rejection.
 * @param handles - Workspace handles from {@link buildWorkspace}.
 * @param name - Migration name forwarded to `generateMigrations`.
 * @param custom - Whether to forward `custom: true`.
 * @returns The parsed runner result.
 */
async function runGenerator(handles: WorkspaceHandles, name: string, custom: boolean): Promise<RunnerResult> {
  const resultPath = path.join(handles.workspace, `result-${name}.json`);
  try {
    await execFileAsync(
      process.execPath,
      [handles.tsxCliPath, handles.runnerPath, resultPath, handles.workspace, name, String(custom)],
      { cwd: handles.workspace, env: handles.env },
    );
  } catch (error) {
    if (!fs.existsSync(resultPath)) {
      throw error;
    }
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RunnerResult;
}

/** Snapshot of one migration chain's files, for before/after comparisons. */
interface ChainSnapshot {
  /** Journal entry tags in order, at snapshot time. */
  readonly journalTags: readonly string[];
  /** Every `.sql` and `meta/*_snapshot.json` file's content, keyed by absolute path. */
  readonly fileContents: ReadonlyMap<string, Buffer>;
}

/**
 * Capture every `.sql` file, every `meta/*_snapshot.json` file, and the full
 * journal tag list of a migration chain directory.
 * @param chainDir - Absolute chain directory.
 * @returns The chain's current snapshot.
 */
function captureChainSnapshot(chainDir: string): ChainSnapshot {
  const journal = JSON.parse(fs.readFileSync(path.join(chainDir, 'meta', '_journal.json'), 'utf-8')) as {
    entries: Array<{ tag: string }>;
  };
  const fileContents = new Map<string, Buffer>();
  for (const name of fs.readdirSync(chainDir)) {
    if (name.endsWith('.sql')) {
      const filePath = path.join(chainDir, name);
      fileContents.set(filePath, fs.readFileSync(filePath));
    }
  }
  const metaDir = path.join(chainDir, 'meta');
  for (const name of fs.readdirSync(metaDir)) {
    if (name.endsWith('_snapshot.json')) {
      const filePath = path.join(metaDir, name);
      fileContents.set(filePath, fs.readFileSync(filePath));
    }
  }
  return { journalTags: journal.entries.map((e) => e.tag), fileContents };
}

/**
 * Assert every file captured in `before` is still present with byte-identical
 * content — the "unchanged prefix" invariant that must hold across both real
 * generator runs.
 * @param before - Snapshot captured before the run.
 */
function assertPriorFilesUnchanged(before: ChainSnapshot): void {
  for (const [filePath, contents] of before.fileContents) {
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).equals(contents)).toBe(true);
  }
}

/** One chain's result from a single real generation run. */
interface ChainRunResult {
  /** Newest journal tag after the run. */
  readonly tag: string;
  /** Newly appended migration's SQL content. */
  readonly sql: string;
  /** Newly appended migration's parsed snapshot JSON. */
  readonly snapshot: { readonly tables: unknown };
  /** Count of journal entries appended by the run (expected `1`). */
  readonly newJournalEntryCount: number;
  /** Count of new files (`.sql` + snapshot) created by the run (expected `2`). */
  readonly newFileCount: number;
}

/**
 * Diff a chain's before/after snapshots into one run's result: the newest
 * tag (asserted to carry the shared name suffix), its SQL and snapshot
 * content, and the counts of newly appended journal entries and files.
 * @param chainDir - Absolute chain directory.
 * @param before - Snapshot captured before the run.
 * @param name - Migration name the newest tag must end with.
 * @returns The chain's run result.
 * @throws When the newest tag does not end with `_<name>`.
 */
function buildChainRunResult(chainDir: string, before: ChainSnapshot, name: string): ChainRunResult {
  const after = captureChainSnapshot(chainDir);
  const tag = after.journalTags.at(-1);
  if (tag === undefined || !tag.endsWith(`_${name}`)) {
    throw new Error(`Expected the newest tag in ${chainDir} to end with '_${name}', got ${tag ?? '<none>'}`);
  }
  const newFiles = [...after.fileContents.keys()].filter((p) => !before.fileContents.has(p));
  // drizzle-kit's journal tag is `<idx>_<name>` but its snapshot file is named
  // `<idx>_snapshot.json` — the numeric prefix only, without the name suffix.
  const snapshotIdx = tag.split('_')[0];
  return {
    tag,
    sql: fs.readFileSync(path.join(chainDir, `${tag}.sql`), 'utf-8'),
    snapshot: JSON.parse(fs.readFileSync(path.join(chainDir, 'meta', `${snapshotIdx}_snapshot.json`), 'utf-8')) as {
      tables: unknown;
    },
    newJournalEntryCount: after.journalTags.length - before.journalTags.length,
    newFileCount: newFiles.length,
  };
}

/** Both chains' results from a single real generation run. */
interface GenerationRunOutcome {
  readonly sqlite: ChainRunResult;
  readonly postgres: ChainRunResult;
}

/**
 * Assert the runner's reported legs both ran, for the expected chain
 * directories, with no `engine-absent` reason.
 * @param handles - Workspace handles.
 * @param runnerResult - Parsed runner result.
 */
function assertRunnerLegsRan(handles: WorkspaceHandles, runnerResult: RunnerResult): void {
  const legs = runnerResult.result?.legs ?? [];
  const sqliteLeg = legs.find((l) => l.dialect === 'sqlite');
  const postgresLeg = legs.find((l) => l.dialect === 'postgres');
  expect(sqliteLeg?.ran).toBe(true);
  expect(sqliteLeg?.reason).toBeUndefined();
  expect(sqliteLeg && fs.realpathSync(sqliteLeg.chainDir)).toBe(fs.realpathSync(handles.sqliteChainDir));
  expect(postgresLeg?.ran).toBe(true);
  expect(postgresLeg?.reason).toBeUndefined();
  expect(postgresLeg && fs.realpathSync(postgresLeg.chainDir)).toBe(fs.realpathSync(handles.pgChainDir));
}

/**
 * Run one real generation pass (`generateMigrations` through the real `tsx`
 * + `drizzle-kit` subprocess), asserting the runner succeeded, every
 * prior-history file is untouched, and returning both chains' results.
 * @param handles - Workspace handles from {@link buildWorkspace}.
 * @param name - Migration name forwarded to the run.
 * @param custom - Whether to forward `custom: true`.
 * @returns Both chains' run results.
 */
async function exerciseGenerationRun(
  handles: WorkspaceHandles,
  name: string,
  custom: boolean,
): Promise<GenerationRunOutcome> {
  const beforeSqlite = captureChainSnapshot(handles.sqliteChainDir);
  const beforePg = captureChainSnapshot(handles.pgChainDir);

  const runnerResult = await runGenerator(handles, name, custom);
  expect(runnerResult.ok).toBe(true);
  assertRunnerLegsRan(handles, runnerResult);

  assertPriorFilesUnchanged(beforeSqlite);
  assertPriorFilesUnchanged(beforePg);

  return {
    sqlite: buildChainRunResult(handles.sqliteChainDir, beforeSqlite, name),
    postgres: buildChainRunResult(handles.pgChainDir, beforePg, name),
  };
}

/**
 * Assert a `--custom` migration's SQL contains no executable statement: every
 * non-blank line is a Drizzle comment.
 * @param sql - The migration's SQL content.
 */
function assertEmptyCustomMigration(sql: string): void {
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) {
      continue;
    }
    throw new Error(`Expected an empty '--custom' migration, found an executable line: ${line}`);
  }
}

describe('generateMigrations (real, unmocked)', () => {
  let workspace: string | undefined;

  afterEach(() => {
    if (workspace) {
      fs.rmSync(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
  });

  it('generates both real chains, then advances both again under --custom, leaving all prior history byte-identical', async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-migrations-real-'));
    const handles = await buildWorkspace(workspace);

    const ordinary = await exerciseGenerationRun(handles, 'real_schema', false);
    expect(ordinary.sqlite.newJournalEntryCount).toBe(1);
    expect(ordinary.sqlite.newFileCount).toBe(2);
    expect(ordinary.sqlite.sql).toContain('real_generator_parent');
    expect(ordinary.sqlite.sql).toContain('real_generator_child');
    expect(ordinary.postgres.newJournalEntryCount).toBe(1);
    expect(ordinary.postgres.newFileCount).toBe(2);
    expect(ordinary.postgres.sql).toContain('real_generator_parent');
    expect(ordinary.postgres.sql).toContain('real_generator_child');
    expect(ordinary.postgres.sql).not.toContain('"public".');

    const custom = await exerciseGenerationRun(handles, 'real_custom', true);
    expect(custom.sqlite.newJournalEntryCount).toBe(1);
    expect(custom.sqlite.newFileCount).toBe(2);
    assertEmptyCustomMigration(custom.sqlite.sql);
    expect(custom.postgres.newJournalEntryCount).toBe(1);
    expect(custom.postgres.newFileCount).toBe(2);
    assertEmptyCustomMigration(custom.postgres.sql);

    // An unchanged schema under --custom: the new snapshot's tables are
    // identical to the ordinary run's tables.
    expect(custom.sqlite.snapshot.tables).toEqual(ordinary.sqlite.snapshot.tables);
    expect(custom.postgres.snapshot.tables).toEqual(ordinary.postgres.snapshot.tables);
  }, 180_000);
});
