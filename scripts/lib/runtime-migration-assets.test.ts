import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectUnexpectedRuntimeMigrationFiles,
  copyRuntimeMigrationChain,
  isMigrationChainDirectory,
  isRuntimeMigrationChainFile,
} from './runtime-migration-assets.js';

const tempDirs: string[] = [];

/**
 * Create a temporary directory tracked for cleanup.
 * @returns Absolute path to the temporary directory.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'makaio-runtime-migrations-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write a fixture file, creating parent directories first.
 * @param root - Fixture root.
 * @param relativePath - Root-relative file path.
 * @param content - File content.
 */
function writeFixture(root: string, relativePath: string, content = ''): void {
  const filePath = join(root, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('copyRuntimeMigrationChain', () => {
  it('copies only SQL files and the journal from a Drizzle source chain', () => {
    const root = makeTempDir();
    const source = join(root, 'source-drizzle');
    const target = join(root, 'dist-drizzle');

    writeFixture(source, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(source, '0001_add_name.sql', 'ALTER TABLE demo ADD COLUMN name text;');
    writeFixture(
      source,
      'meta/_journal.json',
      JSON.stringify({
        entries: [
          { tag: '0000_init', when: 1, breakpoints: false },
          { tag: '0001_add_name', when: 2, breakpoints: false },
        ],
      }),
    );
    writeFixture(source, 'meta/0001_snapshot.json', '{"generator":"state"}');
    writeFixture(source, '0001_add_name.na.md', 'SQLite has no counterpart.');
    writeFixture(source, 'README.md', 'source-only notes');

    const result = copyRuntimeMigrationChain(source, target);

    expect(result.copiedFiles).toEqual(['0000_init.sql', '0001_add_name.sql', 'meta/_journal.json']);
    expect(existsSync(join(target, '0000_init.sql'))).toBe(true);
    expect(existsSync(join(target, '0001_add_name.sql'))).toBe(true);
    expect(existsSync(join(target, 'meta/_journal.json'))).toBe(true);
    expect(existsSync(join(target, 'meta/0001_snapshot.json'))).toBe(false);
    expect(existsSync(join(target, '0001_add_name.na.md'))).toBe(false);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('rejects copying a chain onto itself', () => {
    const root = makeTempDir();
    writeFixture(root, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(root, 'meta/_journal.json', JSON.stringify({ entries: [] }));

    expect(() => copyRuntimeMigrationChain(root, root)).toThrow(/Cannot copy a migration chain onto itself/u);
  });

  it('requires a Drizzle journal and at least one SQL migration', () => {
    const root = makeTempDir();
    const noJournal = join(root, 'no-journal');
    const noSql = join(root, 'no-sql');

    writeFixture(noJournal, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(noSql, 'meta/_journal.json', JSON.stringify({ entries: [] }));

    expect(() => copyRuntimeMigrationChain(noJournal, join(root, 'target-a'))).toThrow(/missing meta\/_journal\.json/u);
    expect(() => copyRuntimeMigrationChain(noSql, join(root, 'target-b'))).toThrow(/contains no \.sql migrations/u);
  });

  it('requires exact parity between journal entries and root SQL files', () => {
    const root = makeTempDir();
    const missingSql = join(root, 'missing-sql');
    const extraSql = join(root, 'extra-sql');

    writeFixture(
      missingSql,
      'meta/_journal.json',
      JSON.stringify({ entries: [{ tag: '0000_missing', when: 1, breakpoints: false }] }),
    );
    writeFixture(missingSql, '0001_other.sql', 'CREATE TABLE demo (id text);');
    writeFixture(extraSql, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(extraSql, '0001_extra.sql', 'ALTER TABLE demo ADD COLUMN name text;');
    writeFixture(
      extraSql,
      'meta/_journal.json',
      JSON.stringify({ entries: [{ tag: '0000_init', when: 1, breakpoints: false }] }),
    );

    expect(() => copyRuntimeMigrationChain(missingSql, join(root, 'target-a'))).toThrow(/references missing SQL/u);
    expect(() => copyRuntimeMigrationChain(extraSql, join(root, 'target-b'))).toThrow(/contains unjournaled SQL/u);
  });
});

describe('collectUnexpectedRuntimeMigrationFiles', () => {
  it('returns source-only files that must not ship in runtime migration chains', () => {
    const root = makeTempDir();
    writeFixture(root, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(root, 'meta/_journal.json', JSON.stringify({ entries: [] }));
    writeFixture(root, 'meta/0000_snapshot.json', '{}');
    writeFixture(root, 'notes/schema.md', 'internal notes');

    expect(collectUnexpectedRuntimeMigrationFiles(root)).toEqual(['meta/0000_snapshot.json', 'notes/schema.md']);
  });
});

describe('isRuntimeMigrationChainFile', () => {
  it('accepts root-level SQL files and the Drizzle journal', () => {
    expect(isRuntimeMigrationChainFile('0000_init.sql')).toBe(true);
    expect(isRuntimeMigrationChainFile('meta/_journal.json')).toBe(true);
  });

  it('rejects source-only files', () => {
    expect(isRuntimeMigrationChainFile('meta/0000_snapshot.json')).toBe(false);
    expect(isRuntimeMigrationChainFile('subdir/0000_init.sql')).toBe(false);
    expect(isRuntimeMigrationChainFile('README.md')).toBe(false);
    expect(isRuntimeMigrationChainFile('0001_add_name.na.md')).toBe(false);
    expect(isRuntimeMigrationChainFile('meta/subdir/_journal.json')).toBe(false);
  });
});

describe('isMigrationChainDirectory', () => {
  it('returns true for directories containing a migration journal', () => {
    const root = makeTempDir();
    writeFixture(root, '0000_init.sql', 'CREATE TABLE demo (id text);');
    writeFixture(root, 'meta/_journal.json', JSON.stringify({ entries: [] }));

    expect(isMigrationChainDirectory(root)).toBe(true);
  });

  it('returns false for directories without a migration journal', () => {
    const root = makeTempDir();
    writeFixture(root, '0000_init.sql', 'CREATE TABLE demo (id text);');

    expect(isMigrationChainDirectory(root)).toBe(false);
  });
});
