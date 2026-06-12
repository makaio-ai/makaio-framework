/**
 * Tests for resolveBundledMigrationsDir.
 *
 * Two groups, both exercising the real implementation end to end:
 * - Source-checkout probe chain (default probes; the real
 *   `@makaio/storage-migrations` is available). Probe-1 (built package layout)
 *   misses because this module is imported directly from src/, not from a
 *   built dist/ tree. Probe-2 (source-checkout getMigrationsFolder) succeeds
 *   for 'sqlite' and, once the schema-twins tooling step has generated and
 *   committed the drizzle-postgres chain, for 'postgres' as well.
 * - Controlled probe environments (injected probes) against real on-disk
 *   fixtures: the published built-package layout and the bundled-host stub
 *   scenario, neither of which exists in a source checkout.
 *
 * The Postgres tests are conditioned on whether `drizzle-postgres/meta/_journal.json`
 * exists in the source tree:
 * - Chain present: asserts resolution succeeds and returns the expected path.
 * - Chain absent: asserts the loud-failure error contract (all required substrings).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMigrationsFolder } from '@makaio/storage-migrations';
import { resolveBundledMigrationsDir } from './resolve-bundled-migrations-dir.js';

const pgChainExists = existsSync(path.join(getMigrationsFolder('postgres'), 'meta', '_journal.json'));

describe('resolveBundledMigrationsDir', () => {
  it('resolves the sqlite chain via probe-2 in a source checkout and the dir contains meta/_journal.json', () => {
    const result = resolveBundledMigrationsDir('sqlite');

    // Probe-2 succeeds in the source checkout: the path must equal getMigrationsFolder('sqlite').
    expect(result).toBe(getMigrationsFolder('sqlite'));

    // The returned path must be a valid drizzle migrations directory.
    expect(existsSync(path.join(result, 'meta', '_journal.json'))).toBe(true);
  });

  it.runIf(pgChainExists)(
    'resolves the postgres chain via probe-2 in a source checkout and the dir contains meta/_journal.json',
    () => {
      const result = resolveBundledMigrationsDir('postgres');

      // Probe-2 succeeds once the drizzle-postgres chain is committed.
      expect(result).toBe(getMigrationsFolder('postgres'));

      // The returned path must be a valid drizzle migrations directory.
      expect(existsSync(path.join(result, 'meta', '_journal.json'))).toBe(true);
    },
  );

  it.runIf(!pgChainExists)("throws for 'postgres' listing every required error contract substring", () => {
    // The drizzle-postgres twin chain does not exist yet — loud-by-design failure
    // until the schema-twins tooling step generates it.
    // This test file lives in the same src/ directory as the module under
    // test, so import.meta.dirname computes the identical built-layout
    // candidate the production probe resolves (../drizzle-postgres).
    const probeOnePath = path.resolve(import.meta.dirname, '..', 'drizzle-postgres');
    const probeTwoPath = getMigrationsFolder('postgres');

    let thrown: unknown;
    try {
      resolveBundledMigrationsDir('postgres');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;

    // (a) literal dialect must appear
    expect(message).toContain('postgres');

    // (b) every probed absolute path must appear (probe-1 is a path ending in drizzle-postgres;
    //     probe-2 is getMigrationsFolder('postgres'), also ending in drizzle-postgres)
    expect(message).toContain(probeOnePath);
    expect(message).toContain(probeTwoPath);
    // Both probes end in 'drizzle-postgres' — the substring appears at least twice
    const occurrences = (message.match(/drizzle-postgres/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    // (c) meta/_journal.json requirement must be named
    expect(message).toContain('meta/_journal.json');

    // (d) explicit override remedy must be present
    expect(message).toContain('centralMigrationsDir');
  });
});

describe('resolveBundledMigrationsDir (controlled probe environments)', () => {
  let fixtureRoot: string;
  let moduleDir: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'makaio-bundled-migrations-'));
    // Mirrors the published layout: this module ships in dist/runtime-node and
    // the migration chains are copied alongside as dist/drizzle[-postgres].
    moduleDir = path.join(fixtureRoot, 'runtime-node');
    mkdirSync(moduleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /**
   * Create `<fixtureRoot>/<chainDirName>/meta/_journal.json` mirroring the
   * minimal layout drizzle-kit generates.
   * @param chainDirName - Chain directory name (`drizzle` or `drizzle-postgres`).
   * @returns Absolute path of the created chain directory.
   */
  function createChainFixture(chainDirName: string): string {
    const chainDir = path.join(fixtureRoot, chainDirName);
    mkdirSync(path.join(chainDir, 'meta'), { recursive: true });
    writeFileSync(path.join(chainDir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }));
    return chainDir;
  }

  it('resolves the sqlite chain via probe-1 from a real built-package layout fixture', () => {
    const chainDir = createChainFixture('drizzle');

    // Probe-1 wins before probe-2 runs: the source checkout's real sqlite
    // chain also exists, so returning the fixture proves probe precedence.
    expect(resolveBundledMigrationsDir('sqlite', { moduleDir })).toBe(chainDir);
  });

  it('resolves the postgres chain via probe-1 from a real built-package layout fixture', () => {
    const chainDir = createChainFixture('drizzle-postgres');

    expect(resolveBundledMigrationsDir('postgres', { moduleDir })).toBe(chainDir);
  });

  it('absorbs a throwing probe-2 (bundled-host stub) and surfaces its message in the aggregate error', () => {
    // Bundled hosts replace `@makaio/storage-migrations` at build time with a
    // generated stub whose getMigrationsFolder() throws (see
    // apps/host-shared/src/build/embedded-migrations.ts). The injected probe
    // reproduces that environment through the resolver's own probe seam, so
    // the module under test and its aggregation logic stay fully real. No
    // chain fixture exists under fixtureRoot, so probe-1 misses
    // deterministically and the catch branch is reached.
    const stubMessage =
      'getMigrationsFolder() is not available in bundled builds. ' +
      'Use readMigrations({ migrationSourceId }) or readMigrations(migrationsDir) instead.';
    const throwingProbe = (): string => {
      throw new Error(stubMessage);
    };

    let thrown: unknown;
    try {
      resolveBundledMigrationsDir('sqlite', { moduleDir, getMigrationsFolder: throwingProbe });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;

    // The stub error message must be surfaced in the aggregate error.
    expect(message).toContain(stubMessage);

    // The probe-1 candidate (../drizzle relative to moduleDir) must also
    // appear, proving the aggregate covers both probes.
    expect(message).toContain(path.resolve(moduleDir, '..', 'drizzle'));
  });
});
