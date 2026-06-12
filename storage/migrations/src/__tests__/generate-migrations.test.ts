import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { StorageDialect } from '@makaio/storage-drizzle';
import {
  generateMigrations,
  type GenerateMigrationsCommand,
  type GenerateMigrationsInternals,
  type GenerateMigrationsLegResult,
} from '../generate-migrations.js';

/**
 * Records the options the default barrel-regeneration step forwards to
 * `generateSchema`. The module is mocked so the default `regenerateBarrels`
 * closure (the code under test) runs while `generateSchema` itself is replaced
 * by a recorder, never touching the real workspace filesystem.
 */
const generateSchemaCalls: Array<{ dialects?: readonly StorageDialect[]; workspaceRoot?: string }> = [];

vi.mock('../generate-schema.js', () => ({
  generateSchema: vi.fn(async (options: { dialects?: readonly StorageDialect[]; workspaceRoot?: string }) => {
    generateSchemaCalls.push({ dialects: options.dialects, workspaceRoot: options.workspaceRoot });
  }),
  resolvePresentDialects: vi.fn((): StorageDialect[] => ['sqlite']),
}));

/**
 * How the fake drizzle-kit runner reacts to a `generate` command for a chain.
 *
 * - `append-name`: simulate a real diff — append a tag carrying the `--name`.
 * - `append-other`: simulate a diff whose tag does NOT carry the `--name`
 *   (drift), so the naming assertion must reject it.
 * - `no-diff`: simulate "no schema changes" — the journal is left untouched.
 */
type FakeGenerateBehavior = 'append-name' | 'append-other' | 'no-diff';

/** Test seam configuration for {@link makeInternals}. */
interface MakeInternalsParams {
  /** Engine root to report, or `undefined` to force the absent path. */
  readonly engineRoot: string | undefined;
  /**
   * How the fake runner reacts to each chain's `generate` command, keyed by the
   * chain directory's basename (`drizzle` for SQLite, `drizzle-postgres` for PG).
   * Defaults to `append-name` for any unlisted chain.
   */
  readonly behaviorByChain?: Readonly<Partial<Record<string, FakeGenerateBehavior>>>;
}

/** A recording fake of the orchestrator's subprocess + journal seams. */
interface FakeInternals {
  /** Every subprocess command the orchestrator issued, in order. */
  readonly commands: GenerateMigrationsCommand[];
  /** Internal overrides to hand to {@link generateMigrations}. */
  readonly internals: GenerateMigrationsInternals;
}

/**
 * Build a recording fake that models drizzle-kit's append-on-diff behavior.
 *
 * The fake runner records every command and, when it sees a `generate`
 * command, mutates an in-memory journal map to simulate drizzle-kit appending
 * (or not appending) a migration. `readNewestJournalTag` reads that map, so the
 * orchestrator's before/after comparison exercises the real naming assertion
 * without spawning drizzle-kit or touching the filesystem.
 * @param params - Test seam configuration.
 * @returns The recorded commands and the `__internals` override object.
 */
function makeInternals(params: MakeInternalsParams): FakeInternals {
  const commands: GenerateMigrationsCommand[] = [];
  // chainDir -> newest journal tag; absent key means "no migration yet".
  const newestTagByChain = new Map<string, string>();
  let appended = 0;

  const internals: GenerateMigrationsInternals = {
    runCommand: (command) => {
      commands.push(command);
      const generateIdx = command.args.indexOf('generate');
      if (generateIdx === -1) {
        return; // e.g. the normalize script — no journal effect.
      }
      const name = command.args[command.args.indexOf('--name') + 1];
      const chainDir = chainDirForCommand(command, params.engineRoot);
      const behavior = params.behaviorByChain?.[path.basename(chainDir)] ?? 'append-name';
      appended += 1;
      const seq = String(appended).padStart(4, '0');
      if (behavior === 'append-name') {
        newestTagByChain.set(chainDir, `${seq}_${name}`);
      } else if (behavior === 'append-other') {
        newestTagByChain.set(chainDir, `${seq}_unexpected`);
      }
      // 'no-diff': leave the journal untouched.
    },
    resolveEnginePackageRoot: () => params.engineRoot,
    // Barrel regeneration is covered by generate-schema's own tests; stub it
    // out so this test never touches the real workspace filesystem.
    regenerateBarrels: async () => {},
    readNewestJournalTag: (chainDir) => newestTagByChain.get(chainDir),
  };
  return { commands, internals };
}

/**
 * Derive the chain directory a generate command targets from its working dir.
 *
 * The SQLite leg runs from the migrations package root (chain `drizzle`); the
 * PG leg runs from the engine root (chain `drizzle-postgres`), so the chain is
 * identified by whether the command's working directory is the engine root.
 * @param command - The recorded generate command.
 * @param engineRoot - The engine package root, or `undefined` when absent.
 * @returns Absolute chain directory the command produced into.
 */
function chainDirForCommand(command: GenerateMigrationsCommand, engineRoot: string | undefined): string {
  const isPostgres = engineRoot !== undefined && command.cwd === engineRoot;
  return path.join(command.cwd, isPostgres ? 'drizzle-postgres' : 'drizzle');
}

describe('generateMigrations', () => {
  it('threads one shared --name into every leg and runs the PG leg when its engine resolves', async () => {
    const engineRoot = '/fake/engine';
    const { commands, internals } = makeInternals({ engineRoot });

    const result = await generateMigrations({
      name: 'explicit',
      drizzleKitBin: '/fake/bin.cjs',
      logger: { info: vi.fn(), warn: vi.fn() },
      __internals: internals,
    });

    expect(result.name).toBe('explicit');

    // Every drizzle-kit generate invocation carries the same --name value.
    const generateCommands = commands.filter((c) => c.args.includes('generate'));
    expect(generateCommands).toHaveLength(2); // sqlite + postgres
    for (const command of generateCommands) {
      const nameIdx = command.args.indexOf('--name');
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(command.args[nameIdx + 1]).toBe('explicit');
    }

    // Every generate invocation goes through tsx wrapping the drizzle-kit bin.
    for (const command of generateCommands) {
      expect(command.file).toBe('tsx');
      expect(command.args[0]).toBe('/fake/bin.cjs');
    }

    // Baseline (sqlite) leg ran from this package root with the baseline config.
    const sqliteLeg = result.legs.find((l) => l.dialect === 'sqlite') as GenerateMigrationsLegResult;
    expect(sqliteLeg.ran).toBe(true);
    expect(sqliteLeg.chainDir.endsWith(path.join('migrations', 'drizzle'))).toBe(true);

    // Postgres leg ran from the resolved engine root and ran its normalize script.
    const pgLeg = result.legs.find((l) => l.dialect === 'postgres') as GenerateMigrationsLegResult;
    expect(pgLeg.ran).toBe(true);
    expect(pgLeg.reason).toBeUndefined();
    expect(pgLeg.chainDir).toBe(path.join(engineRoot, 'drizzle-postgres'));

    const pgCommands = commands.filter((c) => c.cwd === engineRoot);
    // One generate + one normalize.
    expect(pgCommands).toHaveLength(2);
    expect(pgCommands[1].args).toEqual([path.join(engineRoot, 'scripts', 'normalize-migrations.ts')]);
  });

  it('synthesizes one shared name when none is supplied and forwards it to both legs', async () => {
    const { commands, internals } = makeInternals({ engineRoot: '/fake/engine' });

    const result = await generateMigrations({
      drizzleKitBin: '/fake/bin.cjs',
      logger: { info: vi.fn(), warn: vi.fn() },
      __internals: internals,
    });

    expect(result.name).toMatch(/^m_[0-9a-z]+$/);

    const generateCommands = commands.filter((c) => c.args.includes('generate'));
    const names = generateCommands.map((c) => c.args[c.args.indexOf('--name') + 1]);
    // Both legs received the identical synthesized name.
    expect(generateCommands).toHaveLength(2);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toBe(result.name);
  });

  it('skips the PG leg with reason engine-absent when its package does not resolve', async () => {
    const { commands, internals } = makeInternals({ engineRoot: undefined });

    const result = await generateMigrations({
      name: 'explicit',
      drizzleKitBin: '/fake/bin.cjs',
      logger: { info: vi.fn(), warn: vi.fn() },
      __internals: internals,
    });

    const pgLeg = result.legs.find((l) => l.dialect === 'postgres') as GenerateMigrationsLegResult;
    expect(pgLeg.ran).toBe(false);
    expect(pgLeg.reason).toBe('engine-absent');
    expect(pgLeg.chainDir).toBe('drizzle-postgres');

    // No subprocess ran for the absent engine; only the baseline leg generated.
    const generateCommands = commands.filter((c) => c.args.includes('generate'));
    expect(generateCommands).toHaveLength(1);
    expect(result.legs.find((l) => l.dialect === 'sqlite')?.ran).toBe(true);
  });

  it('leaves a chain untouched and does not throw when the leg reports no schema diff', async () => {
    // Both legs report no diff: drizzle-kit appends nothing, so the naming
    // assertion has nothing to correlate and the run succeeds. This is the
    // common case for `db:generate` when the schema is unchanged.
    const { internals } = makeInternals({
      engineRoot: '/fake/engine',
      behaviorByChain: { drizzle: 'no-diff', 'drizzle-postgres': 'no-diff' },
    });

    const result = await generateMigrations({
      name: 'explicit',
      drizzleKitBin: '/fake/bin.cjs',
      logger: { info: vi.fn(), warn: vi.fn() },
      __internals: internals,
    });

    expect(result.legs.every((l) => l.dialect === 'postgres' || l.ran)).toBe(true);
  });

  it('forwards its workspaceRoot to generateSchema during barrel regeneration', async () => {
    generateSchemaCalls.length = 0;
    // Drive the *default* regenerateBarrels path (no override) so the closure
    // that forwards workspaceRoot to generateSchema is exercised. The runner and
    // journal seams are stubbed so no drizzle-kit subprocess or chain I/O runs.
    const workspaceRoot = path.join(path.sep, 'fake', 'workspace');
    const internals: GenerateMigrationsInternals = {
      runCommand: () => {},
      resolveEnginePackageRoot: () => undefined,
      readNewestJournalTag: () => undefined,
    };

    await generateMigrations({
      name: 'explicit',
      drizzleKitBin: '/fake/bin.cjs',
      logger: { info: vi.fn(), warn: vi.fn() },
      workspaceRoot,
      __internals: internals,
    });

    expect(generateSchemaCalls).toHaveLength(1);
    expect(generateSchemaCalls[0].workspaceRoot).toBe(workspaceRoot);
    expect(generateSchemaCalls[0].dialects).toEqual(['sqlite']);
  });

  it('throws when a leg appends a migration whose tag lacks the shared name suffix', async () => {
    // The baseline leg appends a migration tagged with the wrong name,
    // simulating drift between the requested name and the landed migration.
    const { internals } = makeInternals({
      engineRoot: '/fake/engine',
      behaviorByChain: { drizzle: 'append-other' },
    });

    await expect(
      generateMigrations({
        name: 'explicit',
        drizzleKitBin: '/fake/bin.cjs',
        logger: { info: vi.fn(), warn: vi.fn() },
        __internals: internals,
      }),
    ).rejects.toThrow(/Cross-chain naming mismatch/);
  });
});
