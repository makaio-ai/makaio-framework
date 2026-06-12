import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyFrameworkDist } from './framework-dist-verifier.js';

/**
 * Writes a JSON file.
 * @param filePath - Absolute file path to write.
 * @param value - JSON-serializable value.
 */
function writeJson(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/**
 * Writes a built file fixture.
 * @param filePath - Absolute file path to write.
 * @param content - Optional file content.
 */
function writeBuiltFile(filePath: string, content = ''): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Builds the journal tag used for the fixture migration at the given index.
 * @param index - Zero-based migration index.
 * @returns Tag matching the fixture's `.sql` file name without extension.
 */
function migrationTag(index: number): string {
  return `000${index}_migration`;
}

/**
 * Writes a bundled migration chain fixture with a journal whose tagged
 * entries match the given number of `.sql` migration files.
 * @param chainDir - Absolute path of the chain directory.
 * @param sqlFileCount - Number of `.sql` migration files to create.
 * @param journalEntryCount - Number of journal entries; defaults to the file count.
 */
function writeMigrationChain(chainDir: string, sqlFileCount: number, journalEntryCount = sqlFileCount): void {
  for (let index = 0; index < sqlFileCount; index += 1) {
    writeBuiltFile(join(chainDir, `${migrationTag(index)}.sql`));
  }
  writeJson(join(chainDir, 'meta', '_journal.json'), {
    entries: Array.from({ length: journalEntryCount }, (_, index) => ({ idx: index, tag: migrationTag(index) })),
  });
}

describe('verifyFrameworkDist', () => {
  const tempDirs: string[] = [];

  /**
   * Creates a tracked temp directory.
   * @returns Absolute path to the new temp directory.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'framework-dist-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when every export target exists', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './package.json': './package.json',
        './core': {
          types: './dist/core/index.d.mts',
          default: './dist/core/index.mjs',
        },
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.d.mts'));
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
    expect(result.checkedTargets).toBe(3);
    expect(result.scannedModules).toBe(1);
  });

  it('reports missing built export targets', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './core': {
          types: './dist/core/index.d.mts',
          default: './dist/core/index.mjs',
        },
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'missing-export-target',
        target: './dist/core/index.d.mts',
      }),
    ]);
  });

  it('rethrows non-missing stat failures while checking export targets', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './core': './dist/core/index.mjs/child.mjs',
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    expect(() => verifyFrameworkDist(root, { migrationChains: [] })).toThrow();
  });

  it('reports local export targets outside the framework root', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './escape': '../outside.mjs',
      },
    });

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './escape',
        kind: 'export-target-outside-root',
        target: '../outside.mjs',
      }),
    ]);
  });

  it('reports export targets that resolve to directories', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './core': './dist/core',
      },
    });
    mkdirSync(join(root, 'dist/core'), { recursive: true });

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'export-target-not-file',
        target: './dist/core',
      }),
    ]);
  });

  it('reports dist self-imports that the exports map does not expose', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './core': './dist/core/index.mjs',
      },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import{epochMs}from"@makaio/framework/storage/columns";import("@makaio/framework/core");',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './storage/columns',
        kind: 'unexported-dist-specifier',
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('accepts dist self-imports covered by the exports map, including the root specifier', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        '.': './dist/index.mjs',
        './core': './dist/core/index.mjs',
      },
    });
    writeBuiltFile(join(root, 'dist/index.mjs'), 'export{}');
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import"@makaio/framework";import{x}from"@makaio/framework/core";',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
    expect(result.scannedModules).toBe(2);
  });

  it('reports bare external imports the manifest does not declare', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      dependencies: { zod: '^4.0.0' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import{z}from"zod";import{drizzle}from"drizzle-orm/libsql";import("hono");',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'drizzle-orm',
        kind: 'undeclared-dist-dependency',
        target: 'dist/core/index.mjs',
      }),
      expect.objectContaining({
        exportKey: 'hono',
        kind: 'undeclared-dist-dependency',
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('accepts externals declared as peer or optional dependencies and consumer-provided packages', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      peerDependencies: { react: '^19.0.0' },
      optionalDependencies: { ws: '^8.21.0' },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'), 'import"react";import"ws";await import("pg");');

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('skips runtime builtins and minification noise when checking bare externals', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import"node:fs";import"bun:sqlite";import{join}from"path";const b=Buffer.from("false");const t=Array.from("$x");',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('verifies the default bundled migration chains when no override is given', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });

    const result = verifyFrameworkDist(root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ exportKey: 'dist/drizzle', kind: 'missing-migration-chain' }),
      expect.objectContaining({ exportKey: 'dist/drizzle-postgres', kind: 'missing-migration-chain' }),
    ]);
  });

  it('passes when bundled migration chains match their journals', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeMigrationChain(join(root, 'dist/drizzle'), 3);
    writeMigrationChain(join(root, 'dist/drizzle-postgres'), 2);

    const result = verifyFrameworkDist(root);

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('reports migration chains whose journal disagrees with the .sql files', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeMigrationChain(join(root, 'dist/drizzle'), 3, 2);

    const result = verifyFrameworkDist(root, { migrationChains: ['dist/drizzle'] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'dist/drizzle',
        kind: 'migration-journal-mismatch',
        target: 'dist/drizzle/meta/_journal.json',
      }),
    ]);
  });

  it('reports journal tags whose .sql migration file is missing despite matching counts', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    const chainDir = join(root, 'dist/drizzle');
    writeMigrationChain(chainDir, 2);
    // Same entry/file counts, but the second entry's tag points at a file
    // that was renamed away — exactly the drift a pure count check hides.
    writeJson(join(chainDir, 'meta', '_journal.json'), {
      entries: [
        { idx: 0, tag: migrationTag(0) },
        { idx: 1, tag: '0001_renamed' },
      ],
    });

    const result = verifyFrameworkDist(root, { migrationChains: ['dist/drizzle'] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'dist/drizzle',
        kind: 'migration-journal-mismatch',
        message: expect.stringContaining('0001_renamed'),
        target: 'dist/drizzle/0001_renamed.sql',
      }),
    ]);
  });

  it('reports journal entries that carry no tag', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    const chainDir = join(root, 'dist/drizzle');
    writeMigrationChain(chainDir, 1);
    writeJson(join(chainDir, 'meta', '_journal.json'), {
      entries: [{ idx: 0 }],
    });

    const result = verifyFrameworkDist(root, { migrationChains: ['dist/drizzle'] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'dist/drizzle',
        kind: 'migration-journal-mismatch',
        message: expect.stringContaining('has no "tag"'),
        target: 'dist/drizzle/meta/_journal.json',
      }),
    ]);
  });
});
