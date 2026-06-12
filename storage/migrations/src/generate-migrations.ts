/**
 * One-command migration generation orchestrator.
 *
 * Replaces the former multi-step `db:generate` chain (regenerate schema barrels
 * → drizzle-kit generate for SQLite → drizzle-kit generate for each engine →
 * normalize) with a single entrypoint that:
 *
 * 1. Regenerates the schema barrels for every present dialect (the SQLite
 *    baseline plus each non-baseline engine whose package resolves).
 * 2. Generates the SQLite baseline migration chain — always.
 * 3. Generates each non-baseline engine's chain — only when that engine's
 *    package resolves; an absent engine is skipped with a visible info line and
 *    `reason: 'engine-absent'` rather than failing the run.
 * 4. Threads a single `--name` value into every drizzle-kit invocation so the
 *    same migration filename suffix lands in every chain, keeping the chains
 *    correlatable instead of diverging into independently random slugs.
 * 5. Verifies, for each leg that appended a new migration, that the appended
 *    journal entry carries the shared `--name` suffix, failing loudly
 *    otherwise. A leg whose schema is unchanged appends nothing (drizzle-kit
 *    reports no diff), so there is nothing to correlate and the chain is left
 *    byte-untouched.
 *
 * Landed migration files and journal entries are never renamed or renumbered:
 * the orchestrator only ever appends new entries. `fresh: true` reproduces the
 * pre-release-only `db:generate:fresh` escape hatch by deleting each present
 * chain directory before regeneration.
 *
 * Usage: `tsx src/generate-migrations.ts [--name <name>] [--fresh]`
 * @packageDocumentation
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NON_BASELINE_GENERATION_LEGS,
  type StorageDialect,
  type StorageEngineGenerationLeg,
} from '@makaio/storage-drizzle';
import { generateSchema, resolvePresentDialects } from './generate-schema.js';

/** Baseline dialect whose chain is always generated, independent of any engine package. */
const BASELINE_DIALECT: StorageDialect = 'sqlite';

/** Directory name of the SQLite baseline chain, relative to this package root. */
const BASELINE_CHAIN_DIR_NAME = 'drizzle';

/** drizzle-kit config used to generate the SQLite baseline chain, relative to this package root. */
const BASELINE_DRIZZLE_CONFIG = 'drizzle.config.ts';

/**
 * A single command the orchestrator runs as a subprocess.
 *
 * Modeled as data so the run can be recorded (and asserted on) by tests without
 * invoking the real binaries.
 */
export interface GenerateMigrationsCommand {
  /** Executable to run (e.g. `tsx`). */
  readonly file: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
  /** Working directory the command runs in. */
  readonly cwd: string;
}

/**
 * Runs one orchestrator subprocess.
 *
 * The default runner uses `execFileSync` with inherited stdio. Tests inject a
 * recording fake through {@link GenerateMigrationsInternals.runCommand} to assert
 * on the threaded arguments without spawning drizzle-kit.
 * @param command - Command to run.
 */
export type GenerateMigrationsRunner = (command: GenerateMigrationsCommand) => void;

/**
 * Resolves the on-disk root of an engine package, or reports it absent.
 *
 * The default resolver probes `require.resolve('<enginePackageName>/package.json')`
 * and returns the package root directory, treating `MODULE_NOT_FOUND` as the
 * engine being absent. Tests inject a fake through
 * {@link GenerateMigrationsInternals.resolveEnginePackageRoot} to force the
 * absent path deterministically.
 * @param enginePackageName - Package name to resolve (e.g. `@makaio/storage-pg`).
 * @returns Absolute package root path, or `undefined` when the engine is absent.
 */
export type EnginePackageRootResolver = (enginePackageName: string) => string | undefined;

/**
 * Internal seams used only by tests.
 *
 * Not part of the public contract: production callers leave these unset and get
 * the default subprocess runner and `require.resolve`-based presence probe.
 */
export interface GenerateMigrationsInternals {
  /** Override for the subprocess runner. */
  readonly runCommand?: GenerateMigrationsRunner;
  /** Override for engine-package presence resolution. */
  readonly resolveEnginePackageRoot?: EnginePackageRootResolver;
  /** Override for the schema-barrel regeneration step. */
  readonly regenerateBarrels?: (dialects: readonly StorageDialect[]) => Promise<void>;
  /**
   * Override for reading the newest journal tag of a chain directory. Returns
   * `undefined` for a chain with no migration yet.
   */
  readonly readNewestJournalTag?: (chainDir: string) => string | undefined;
}

/**
 * Options for {@link generateMigrations}.
 */
export interface GenerateMigrationsOptions {
  /**
   * Migration name forwarded to every leg's `drizzle-kit generate --name`. When
   * omitted, a single random slug is synthesized and reused across all legs so
   * every chain shares one filename suffix.
   */
  name?: string;
  /**
   * When `true`, deletes each present chain directory before regenerating it —
   * the pre-release-only `db:generate:fresh` semantics. Landed chains are
   * otherwise only appended to.
   */
  fresh?: boolean;
  /**
   * Absolute workspace root used to discover schema packages during barrel
   * regeneration (step 1). Forwarded to {@link generateSchema}; when omitted,
   * `generateSchema` falls back to the repository root resolved from its own
   * module location. Does not relocate the baseline chain directory or the
   * drizzle-kit working directories, which are anchored to this package root.
   */
  workspaceRoot?: string;
  /**
   * Absolute path to the drizzle-kit `bin.cjs`. Defaults to resolving it from
   * the installed `drizzle-kit` package. Invoked through `tsx` to preserve the
   * tsx-wraps-drizzle-kit invariant the package scripts rely on.
   */
  drizzleKitBin?: string;
  /** Optional logger for status output. */
  logger?: Pick<typeof console, 'info' | 'warn'>;
  /** Internal seams for tests; unset in production. */
  __internals?: GenerateMigrationsInternals;
}

/**
 * Outcome of one generation leg.
 */
export interface GenerateMigrationsLegResult {
  /** Dialect this leg generates a chain for. */
  readonly dialect: StorageDialect;
  /** Absolute path of the chain directory this leg targets. */
  readonly chainDir: string;
  /** Whether the leg ran (`false` when its engine package was absent). */
  readonly ran: boolean;
  /** Why the leg did not run, when `ran` is `false`. */
  readonly reason?: 'engine-absent';
}

/**
 * Result of {@link generateMigrations}.
 */
export interface GenerateMigrationsResult {
  /** Migration name threaded into every leg's `drizzle-kit generate --name`. */
  readonly name: string;
  /** One entry per dialect leg, in run order (baseline first). */
  readonly legs: ReadonlyArray<GenerateMigrationsLegResult>;
}

/**
 * Resolve the absolute path of the installed drizzle-kit `bin.cjs`.
 * @returns Absolute path to `drizzle-kit/bin.cjs`.
 */
function resolveDrizzleKitBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('drizzle-kit')), 'bin.cjs');
}

/**
 * Synthesize a migration name reused across every leg when none is supplied.
 *
 * A single slug per run keeps every chain's newest filename suffix identical,
 * replacing the former per-chain random-name divergence.
 * @returns A short, sortable-enough slug.
 */
function synthesizeMigrationName(): string {
  return `m_${Date.now().toString(36)}`;
}

/**
 * Default presence probe: resolve the engine package's `package.json`.
 * @param enginePackageName - Package name to resolve.
 * @returns The engine package root, or `undefined` when `MODULE_NOT_FOUND`.
 */
function defaultResolveEnginePackageRoot(enginePackageName: string): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve(`${enginePackageName}/package.json`));
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Read the newest journal entry's tag from a chain directory.
 *
 * Returns `undefined` when the chain has no journal yet (a freshly cleared or
 * never-generated chain) or its journal has no entries — both signal "no
 * migration present", which the orchestrator uses to detect whether a leg
 * actually appended a new migration.
 * @param chainDir - Absolute path to the chain directory.
 * @returns The `tag` of the last journal entry, or `undefined` when none exists.
 */
function defaultReadNewestJournalTag(chainDir: string): string | undefined {
  const journalPath = path.join(chainDir, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    return undefined;
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.at(-1)?.tag;
}

/**
 * Assert a leg that appended a new migration named it with the shared suffix.
 *
 * drizzle-kit only appends a migration when the schema actually changed; a
 * no-diff run leaves the journal untouched. The naming contract therefore only
 * applies when the newest tag changed across the leg's run: if a new migration
 * landed, its tag must carry the shared `--name` suffix so every chain's newest
 * filename stays correlatable. A no-diff run appends nothing, so there is
 * nothing to correlate and the assertion is satisfied vacuously.
 * @param dialect - Dialect of the chain (for the error message).
 * @param name - Migration name that should suffix a newly appended tag.
 * @param beforeTag - Newest tag before the leg ran, or `undefined` when empty.
 * @param afterTag - Newest tag after the leg ran, or `undefined` when empty.
 * @throws When a new migration was appended but its tag lacks the `_<name>` suffix.
 */
function assertAppendedTagMatchesName(
  dialect: StorageDialect,
  name: string,
  beforeTag: string | undefined,
  afterTag: string | undefined,
): void {
  if (afterTag === beforeTag) {
    // No new migration appended (no schema diff) — nothing to correlate.
    return;
  }
  if (afterTag === undefined || !afterTag.endsWith(`_${name}`)) {
    throw new Error(
      `Cross-chain naming mismatch: the ${dialect} chain's newly generated migration tag '${afterTag ?? '<none>'}' ` +
        `does not end with the shared name suffix '_${name}'. Every leg must receive the same ` +
        `'--name' so chains stay correlatable.`,
    );
  }
}

/**
 * Parameters for one drizzle-kit generation leg.
 */
interface RunGenerationLegParams {
  /** Subprocess runner. */
  readonly runCommand: GenerateMigrationsRunner;
  /** Path to drizzle-kit `bin.cjs`. */
  readonly drizzleKitBin: string;
  /** Working directory for drizzle-kit (the config's package root). */
  readonly cwd: string;
  /** drizzle-kit config path passed to `--config`. */
  readonly configPath: string;
  /** Absolute chain directory (deleted when `fresh`). */
  readonly chainDir: string;
  /** Migration name passed to `--name`. */
  readonly name: string;
  /** Whether to delete the chain directory first. */
  readonly fresh: boolean;
  /** Optional post-generation normalize script. */
  readonly normalizeScriptPath?: string;
}

/**
 * Run one drizzle-kit generation leg: optionally clear the chain dir, generate,
 * then run an optional normalize script.
 * @param params - Leg parameters.
 */
function runGenerationLeg(params: RunGenerationLegParams): void {
  if (params.fresh) {
    fs.rmSync(params.chainDir, { recursive: true, force: true });
  }
  params.runCommand({
    file: 'tsx',
    args: [params.drizzleKitBin, 'generate', '--config', params.configPath, '--name', params.name],
    cwd: params.cwd,
  });
  if (params.normalizeScriptPath) {
    params.runCommand({ file: 'tsx', args: [params.normalizeScriptPath], cwd: params.cwd });
  }
}

/**
 * Generate every present dialect's migration chain in one command.
 *
 * Regenerates the schema barrels for the present dialects, generates the SQLite
 * baseline chain, then generates each non-baseline engine's chain whose package
 * resolves — threading a single `--name` through every leg and asserting that
 * any newly appended migration carries that name suffix.
 * @param options - Generation options.
 * @returns The shared migration name and one result entry per dialect leg.
 * @throws When a leg appends a migration whose tag does not match the shared name.
 */
export async function generateMigrations(options: GenerateMigrationsOptions = {}): Promise<GenerateMigrationsResult> {
  const logger = options.logger ?? console;
  const fresh = options.fresh ?? false;
  const internals = options.__internals ?? {};
  const runCommand = internals.runCommand ?? defaultRunCommand;
  const resolveEnginePackageRoot = internals.resolveEnginePackageRoot ?? defaultResolveEnginePackageRoot;
  const readNewestJournalTag = internals.readNewestJournalTag ?? defaultReadNewestJournalTag;
  const name = options.name ?? synthesizeMigrationName();
  const drizzleKitBin = options.drizzleKitBin ?? resolveDrizzleKitBin();

  // This package's root is two levels up from src/: src -> migrations.
  const packageRoot = path.resolve(import.meta.dirname, '..');

  // 1. Regenerate the schema barrels for every present dialect, discovering
  //    schemas from the requested workspace root so a programmatic caller's
  //    `workspaceRoot` flows into discovery rather than being silently dropped.
  const presentDialects = resolvePresentDialects();
  const regenerateBarrels =
    internals.regenerateBarrels ??
    ((dialects) => generateSchema({ dialects, logger, workspaceRoot: options.workspaceRoot }));
  await regenerateBarrels(presentDialects);

  const legs: GenerateMigrationsLegResult[] = [];

  // 2. SQLite baseline leg — always runs.
  const baselineChainDir = path.join(packageRoot, BASELINE_CHAIN_DIR_NAME);
  logger.info(`[storage-migrations] Generating ${BASELINE_DIALECT} chain (--name ${name})`);
  const baselineBefore = readNewestJournalTag(baselineChainDir);
  runGenerationLeg({
    runCommand,
    drizzleKitBin,
    cwd: packageRoot,
    configPath: BASELINE_DRIZZLE_CONFIG,
    chainDir: baselineChainDir,
    name,
    fresh,
  });
  assertAppendedTagMatchesName(BASELINE_DIALECT, name, baselineBefore, readNewestJournalTag(baselineChainDir));
  legs.push({ dialect: BASELINE_DIALECT, chainDir: baselineChainDir, ran: true });

  // 3. Non-baseline engine legs — each runs only when its package resolves.
  for (const leg of NON_BASELINE_GENERATION_LEGS) {
    const engineRoot = resolveEnginePackageRoot(leg.enginePackageName);
    const chainDir = enginePackageChainDir(engineRoot, leg);
    if (!engineRoot) {
      logger.info(
        `[storage-migrations] Skipping ${leg.dialect} chain — engine package ${leg.enginePackageName} is not installed.`,
      );
      legs.push({ dialect: leg.dialect, chainDir, ran: false, reason: 'engine-absent' });
      continue;
    }
    logger.info(`[storage-migrations] Generating ${leg.dialect} chain (--name ${name})`);
    const legBefore = readNewestJournalTag(chainDir);
    runGenerationLeg({
      runCommand,
      drizzleKitBin,
      cwd: engineRoot,
      configPath: path.join(engineRoot, leg.drizzleConfigSpecifier),
      chainDir,
      name,
      fresh,
      normalizeScriptPath: leg.normalizeScriptSpecifier
        ? path.join(engineRoot, leg.normalizeScriptSpecifier)
        : undefined,
    });
    assertAppendedTagMatchesName(leg.dialect, name, legBefore, readNewestJournalTag(chainDir));
    legs.push({ dialect: leg.dialect, chainDir, ran: true });
  }

  return { name, legs };
}

/**
 * Resolve a non-baseline leg's chain directory.
 *
 * When the engine package is present, the chain lives under its package root;
 * when absent, the path is still reported (relative form, unresolved root) so
 * callers can see which directory would have been generated.
 * @param engineRoot - Resolved engine package root, or `undefined` when absent.
 * @param leg - The generation leg descriptor.
 * @returns Absolute chain directory when resolved, else the bare chain dir name.
 */
function enginePackageChainDir(engineRoot: string | undefined, leg: StorageEngineGenerationLeg): string {
  return engineRoot ? path.join(engineRoot, leg.chainDirName) : leg.chainDirName;
}

/**
 * Default subprocess runner: `execFileSync` with inherited stdio.
 * @param command - Command to run.
 */
function defaultRunCommand(command: GenerateMigrationsCommand): void {
  execFileSync(command.file, [...command.args], { cwd: command.cwd, stdio: 'inherit' });
}

/**
 * Determine whether this file is being executed directly.
 * @returns True when invoked as the entrypoint via tsx/node.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

/**
 * Parsed orchestrator CLI flags.
 */
interface ParsedCliArgs {
  /** Migration name from `--name <v>` / `--name=<v>`, if supplied. */
  readonly name?: string;
  /** Whether `--fresh` was passed. */
  readonly fresh: boolean;
}

/**
 * Parse the orchestrator CLI flags from `process.argv`.
 * @param argv - Raw argument vector (typically `process.argv`).
 * @returns Parsed `name` and `fresh` flags.
 */
function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let name: string | undefined;
  let fresh = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fresh') {
      fresh = true;
    } else if (arg === '--name') {
      if (i + 1 >= argv.length) {
        throw new Error('--name requires a value');
      }
      name = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
    }
  }
  return { name, fresh };
}

if (isMainModule()) {
  const { name, fresh } = parseCliArgs(process.argv);
  void generateMigrations({ name, fresh });
}
