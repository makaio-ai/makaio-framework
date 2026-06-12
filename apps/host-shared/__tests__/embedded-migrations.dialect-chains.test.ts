import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMigrationSourceId,
  discoverBundledMigrationSources,
  loadEmbeddedMigrations,
} from '../src/build/embedded-migrations.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'makaio-dialect-chains-'));
  tempDirs.push(dir);
  return dir;
}

function writeJournalDir(root: string, relDir: string, dialect: string, tag: string, sqlContent: string): string {
  const drizzleDir = path.join(root, relDir);
  mkdirSync(path.join(drizzleDir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(drizzleDir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect,
      entries: [{ idx: 0, version: '7', when: 1, tag, breakpoints: true }],
    }),
  );
  writeFileSync(path.join(drizzleDir, `${tag}.sql`), sqlContent);
  return drizzleDir;
}

describe('desktop embed scan — dialect chain isolation', () => {
  it('discovers only the sqlite drizzle dir and never picks up drizzle-postgres', () => {
    const root = createTempWorkspace();

    // sqlite chain at storage/migrations/drizzle
    writeJournalDir(
      root,
      path.join('storage', 'migrations', 'drizzle'),
      'sqlite',
      '0000_a',
      'CREATE TABLE t (id TEXT);',
    );

    // postgres chain at storage/migrations/drizzle-postgres — must stay invisible
    writeJournalDir(
      root,
      path.join('storage', 'migrations', 'drizzle-postgres'),
      'postgresql',
      '0000_b',
      'CREATE TABLE u (id TEXT);',
    );

    const sources = discoverBundledMigrationSources(root);

    expect(sources).toHaveLength(1);
    expect(sources[0].migrationsDir).toMatch(/storage[/\\]migrations[/\\]drizzle$/);
    expect(sources[0].migrationSourceId).toBe('storage/migrations/drizzle');

    for (const src of sources) {
      expect(src.migrationsDir).not.toContain('drizzle-postgres');
      expect(src.migrationSourceId).not.toContain('drizzle-postgres');
    }
  });

  it('does not discover dirs named drizzle2 or my-drizzle even when they carry a valid journal', () => {
    const root = createTempWorkspace();

    writeJournalDir(root, path.join('storage', 'drizzle2'), 'sqlite', '0000_x', 'CREATE TABLE x (id TEXT);');
    writeJournalDir(root, path.join('storage', 'my-drizzle'), 'sqlite', '0000_y', 'CREATE TABLE y (id TEXT);');

    const sources = discoverBundledMigrationSources(root);

    expect(sources).toHaveLength(0);
  });

  it('round-trips the sqlite chain migration with correct tag, sql, and sha256 hash', () => {
    const root = createTempWorkspace();
    const sqlContent = 'CREATE TABLE conformance_kv (id TEXT PRIMARY KEY, label TEXT, payload TEXT);';

    const drizzleDir = writeJournalDir(
      root,
      path.join('storage', 'migrations', 'drizzle'),
      'sqlite',
      '0000_a',
      sqlContent,
    );

    const sources = discoverBundledMigrationSources(root);
    expect(sources).toHaveLength(1);

    const embedded = loadEmbeddedMigrations(sources);
    const sourceId = buildMigrationSourceId(root, drizzleDir);
    const migrations = embedded.migrationsBySourceId.get(sourceId);

    expect(migrations).toBeDefined();
    expect(migrations).toHaveLength(1);

    const migration = migrations![0];
    expect(migration.tag).toBe('0000_a');

    // sql is split on '--> statement-breakpoint'; no breakpoint in our fixture
    expect(migration.sql).toEqual([sqlContent]);

    // hash = sha256 of the raw file content
    const expectedHash = createHash('sha256').update(sqlContent).digest('hex');
    expect(migration.hash).toBe(expectedHash);
  });

  it('real-tree pin: central storage/migrations package exposes exactly one source with id "drizzle"', () => {
    const realMigrationsRoot = path.resolve(import.meta.dirname, '../../../storage/migrations');

    const sources = discoverBundledMigrationSources(realMigrationsRoot);

    expect(sources).toHaveLength(1);
    expect(sources[0].migrationSourceId).toBe('drizzle');

    // Explicit guard: the postgres out-dir must not be visible to the scan
    for (const src of sources) {
      expect(src.migrationsDir).not.toContain('drizzle-postgres');
      expect(src.migrationSourceId).not.toContain('drizzle-postgres');
    }
  });
});
