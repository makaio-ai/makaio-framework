import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_RUNTIME_ASSETS, verifyFrameworkDist } from './framework-dist-verifier.js';

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
 *
 * Defaults to a module with an actual export rather than an empty file or a
 * bare `export {};` marker: the verifier rejects declaration targets that
 * declare no API surface — and counts the surface-free module marker as
 * nothing — so a lesser fixture would assert the wrong thing everywhere a
 * test only cares that a target exists.
 * @param filePath - Absolute file path to write.
 * @param content - Optional file content.
 */
function writeBuiltFile(filePath: string, content = 'export const fixture = 0;\n'): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Writes a package.json whose exports map carries the `./core` declaration +
 * runtime target pair used by the declaration-surface tests.
 * @param root - Temp package root to write into.
 */
function writeCoreExportsFixture(root: string): void {
  writeJson(join(root, 'package.json'), {
    exports: {
      './core': {
        types: './dist/core/index.d.mts',
        default: './dist/core/index.mjs',
      },
    },
  });
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
    writeBuiltFile(join(dir, BUNDLED_RUNTIME_ASSETS[0]));
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
    writeCoreExportsFixture(root);
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

  it('passes a runtime-only dist without declaration files when declarations are not expected', () => {
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
    // Only the runtime target counts as checked; the exempted declaration
    // target does not.
    expect(result.checkedTargets).toBe(1);
    expect(result.scannedModules).toBe(1);
  });

  it('still reports missing runtime targets and escaping declaration targets without expected declarations', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {
        './core': {
          types: '../outside/index.d.mts',
          default: './dist/core/index.mjs',
        },
      },
    });

    const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'export-target-outside-root',
        target: '../outside/index.d.mts',
      }),
      expect.objectContaining({
        exportKey: './core',
        kind: 'missing-export-target',
        target: './dist/core/index.mjs',
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
      // 'pg' pins the check precedence: a Postgres driver import is reported
      // as forbidden engine code in dist, not merely as an undeclared
      // external — drivers ship with their engine packages, never inside the
      // framework distribution.
      'import{z}from"zod";import{drizzle}from"drizzle-orm/libsql";import("hono");await import("pg");',
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
      expect.objectContaining({
        exportKey: 'pg',
        kind: 'postgres-code-in-dist',
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('flags Postgres driver imports in dist even when the manifest declares them', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      dependencies: { 'drizzle-orm': '0.45.2', pg: '^8.21.0' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import pg from"pg";import{drizzle}from"drizzle-orm/node-postgres";import"pg/lib/native";',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    // One issue per forbidden specifier per module: the second `pg/...`
    // import and the quoted-literal scan must not double-report.
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'pg',
        kind: 'postgres-code-in-dist',
        message: expect.stringContaining('imports "pg"'),
        target: 'dist/core/index.mjs',
      }),
      expect.objectContaining({
        exportKey: 'drizzle-orm/node-postgres',
        kind: 'postgres-code-in-dist',
        message: expect.stringContaining('imports "drizzle-orm/node-postgres"'),
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('flags quoted driver literals that defeat import-specifier scans', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      // Minified importRuntimeModule('pg') shape: the specifier never appears
      // in import position, only as an argument to a renamed loading helper.
      'async function e(t){return await import(t)}let r;({default:r}=await e(`pg`));',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'pg',
        kind: 'postgres-code-in-dist',
        message: expect.stringContaining('quoted literal "pg"'),
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('flags engine-exclusive SQL markers embedded in template literals', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'const a=s`SELECT pg_advisory_xact_lock(${k})`;const b=s`@@ websearch_to_tsquery(${l},${q})`;',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'pg_advisory_xact_lock',
        kind: 'postgres-code-in-dist',
        target: 'dist/core/index.mjs',
      }),
      expect.objectContaining({
        exportKey: 'websearch_to_tsquery',
        kind: 'postgres-code-in-dist',
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('accepts drizzle-orm/pg-core imports in dist (twin schema column builders)', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      dependencies: { 'drizzle-orm': '0.45.2' },
    });
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import{bigint,boolean,jsonb}from"drizzle-orm/pg-core";import{sql}from"drizzle-orm";',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('flags engine-package imports in dist even when the manifest declares them', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      dependencies: { '@makaio/storage-pg': '1.0.0' },
    });
    // Engine attachment goes through the registry plus runtime resolution —
    // an import of the engine package (root or subpath) makes the core
    // artifact hard-depend on it, so both forms collapse into one issue.
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'import{storageEngine}from"@makaio/storage-pg";await import("@makaio/storage-pg/columns");',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: '@makaio/storage-pg',
        kind: 'postgres-code-in-dist',
        message: expect.stringContaining('imports "@makaio/storage-pg"'),
        target: 'dist/core/index.mjs',
      }),
    ]);
  });

  it('accepts quoted engine-package literals outside import position (auto-resolve seams)', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
    });
    // The auto-resolve hint table and minified importRuntimeModule
    // registration carry the engine package name as a quoted literal by
    // design — runtime resolution never pulls engine code into the artifact.
    writeBuiltFile(
      join(root, 'dist/core/index.mjs'),
      'const h=[{dialect:`postgres`,packageName:`@makaio/storage-pg`}];' +
        'async function e(t){return await import(t)}let r;({storageEngine:r}=await e(`@makaio/storage-pg`));',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('accepts externals declared as peer or optional dependencies', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: { './core': './dist/core/index.mjs' },
      peerDependencies: { react: '^19.0.0' },
      optionalDependencies: { ws: '^8.21.0' },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'), 'import"react";import"ws";');

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

  it('reports a missing required runtime asset', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    rmSync(join(root, BUNDLED_RUNTIME_ASSETS[0]));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: BUNDLED_RUNTIME_ASSETS[0],
        kind: 'missing-runtime-asset',
        target: BUNDLED_RUNTIME_ASSETS[0],
      }),
    ]);
  });

  it('reports a required runtime asset that is not a regular file', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    rmSync(join(root, BUNDLED_RUNTIME_ASSETS[0]));
    mkdirSync(join(root, BUNDLED_RUNTIME_ASSETS[0]), { recursive: true });

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: BUNDLED_RUNTIME_ASSETS[0],
        kind: 'runtime-asset-not-file',
        target: BUNDLED_RUNTIME_ASSETS[0],
      }),
    ]);
  });

  it('verifies the default bundled migration chain when no override is given', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });

    const result = verifyFrameworkDist(root);

    expect(result.ok).toBe(false);
    // The SQLite chain is the only chain bundled with the framework
    // distribution; engine packages ship their own chains.
    expect(result.issues).toEqual([
      expect.objectContaining({ exportKey: 'dist/drizzle', kind: 'missing-migration-chain' }),
    ]);
  });

  it('passes when the bundled migration chain matches its journal', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeMigrationChain(join(root, 'dist/drizzle'), 3);

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

  it('reports source-only files in bundled migration chains', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeMigrationChain(join(root, 'dist/drizzle'), 1);
    writeBuiltFile(join(root, 'dist/drizzle/meta/0000_snapshot.json'), '{"generator":"state"}');

    const result = verifyFrameworkDist(root, { migrationChains: ['dist/drizzle'] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'dist/drizzle',
        kind: 'migration-chain-extra-file',
        target: 'dist/drizzle/meta/0000_snapshot.json',
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

  it('reports declaration targets with no API surface that would resolve as untyped modules', () => {
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.d.mts'), '');
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'declaration-target-without-surface',
        target: './dist/core/index.d.mts',
      }),
    ]);
  });

  it('reports comments-only declaration targets, which a size check would accept', () => {
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.d.mts'), '//#region src/index.ts\n\n//#endregion\n');
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'declaration-target-without-surface',
        target: './dist/core/index.d.mts',
      }),
    ]);
  });

  it('reports declaration targets holding only the bare module marker export {};', () => {
    // `export {};` makes the file a module but exposes no API — the exact
    // shape a declaration-backend regression emits, and one both a size check
    // and a raw keyword grep would accept.
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.d.mts'), '// bundled by tsgo\nexport {};\n');
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './core',
        kind: 'declaration-target-without-surface',
        target: './dist/core/index.d.mts',
      }),
    ]);
  });

  it('accepts empty runtime targets — only declaration targets must declare a surface', () => {
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.d.mts'));
    writeBuiltFile(join(root, 'dist/core/index.mjs'), '');

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('exempts surface-free declaration targets from a runtime-only dist', () => {
    const root = makeTempDir();
    writeCoreExportsFixture(root);
    writeBuiltFile(join(root, 'dist/core/index.d.mts'), '');
    writeBuiltFile(join(root, 'dist/core/index.mjs'));

    const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('reports workspace imports that survived into a self-contained declaration bundle', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {}, dependencies: { zod: '^4.0.0' } });
    writeBuiltFile(
      join(root, 'dist/bus/index.d.mts'),
      [
        'import { z } from "zod";',
        'import { BusNamespace } from "@makaio/core";',
        'export { BusNamespace, z };',
        '',
      ].join('\n'),
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: '@makaio/core',
        kind: 'unbundled-declaration-import',
        target: 'dist/bus/index.d.mts',
      }),
    ]);
  });

  it('reports workspace imports wrapped across multiple lines in a declaration bundle', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(
      join(root, 'dist/bus/index.d.mts'),
      ['import {', '  BusNamespace,', '  ScopedBus,', '} from "@makaio/core";', 'export { BusNamespace };', ''].join(
        '\n',
      ),
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: '@makaio/core',
        kind: 'unbundled-declaration-import',
        target: 'dist/bus/index.d.mts',
      }),
    ]);
  });

  it('reports workspace references left as inline import() type queries', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(
      join(root, 'dist/bus/index.d.mts'),
      'export type SubjectRef = import("@makaio/core").SubjectDefinition;\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: '@makaio/core',
        kind: 'unbundled-declaration-import',
        target: 'dist/bus/index.d.mts',
      }),
    ]);
  });

  it('accepts workspace specifiers in a declaration bundle outside import position', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {}, dependencies: { zod: '^4.0.0' } });
    writeBuiltFile(
      join(root, 'dist/bus/index.d.mts'),
      [
        'import { z } from "zod";',
        '/**',
        ' * Use `localSubject()` from `@makaio/core` to create these.',
        ' * @example',
        " * import { localSubject } from '@makaio/core';",
        ' * type Doc = import("@makaio/core").SubjectDefinition;',
        ' */',
        'declare const marker: z.ZodType;',
        "declare module '@makaio/contracts' {",
        '  interface Registry {',
        '    marker: typeof marker;',
        '  }',
        '}',
        'export { marker };',
        '',
      ].join('\n'),
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('allows self-imports of the published package that the exports map exposes', () => {
    // Chunk declarations legitimately reference sibling subpaths through the
    // package's own name — consumers resolve those through the exports map.
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      name: '@makaio/framework',
      exports: {
        './core': './dist/core/index.mjs',
        './contracts': './dist/contracts/index.mjs',
      },
    });
    writeBuiltFile(join(root, 'dist/core/index.mjs'));
    writeBuiltFile(join(root, 'dist/contracts/index.mjs'));
    writeBuiltFile(
      join(root, 'dist/chunk-abc.d.mts'),
      'import { Namespace } from "@makaio/framework/core";\nexport type Ref = import("@makaio/framework/contracts").Marker;\nexport { Namespace };\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('reports declaration imports of externals the manifest does not declare', () => {
    // The runtime bundle may inline a package's code while its types stay
    // external — the type-only edge never reaches the runtime import scan,
    // so this scan is the only check standing between an unresolvable type
    // import and a shipped distribution.
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(
      join(root, 'dist/ui-views/index.d.mts'),
      'export type Layout = import("react-grid-layout").Layout;\nimport { EventEmitter } from "node:events";\nexport { EventEmitter };\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    // The node: builtin needs no declaration; only the bare external is flagged.
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'react-grid-layout',
        kind: 'undeclared-dist-dependency',
        target: 'dist/ui-views/index.d.mts',
      }),
    ]);
  });

  it('reports import-equals declaration references to undeclared externals', () => {
    // `import Foo = require("…")` is legal declaration output (typically
    // `.d.cts`) and resolves its specifier like any import statement.
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(
      join(root, 'dist/legacy/index.d.cts'),
      'import Layout = require("react-grid-layout");\nexport { Layout };\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'react-grid-layout',
        kind: 'undeclared-dist-dependency',
        target: 'dist/legacy/index.d.cts',
      }),
    ]);
  });

  it('reports reference-types directives naming undeclared externals', () => {
    // TypeScript resolves `/// <reference types="…" />` while loading the
    // declaration, exactly like an import — but the directive is a line
    // comment, so it must be collected before comment stripping.
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(
      join(root, 'dist/client/index.d.mts'),
      '/// <reference types="vite/client" />\nexport const fixture = 0;\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: 'vite',
        kind: 'undeclared-dist-dependency',
        target: 'dist/client/index.d.mts',
      }),
    ]);
  });

  it('accepts declaration imports of externals declared as peer dependencies', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), {
      exports: {},
      peerDependencies: { 'react-grid-layout': '^1.4.4' },
    });
    writeBuiltFile(
      join(root, 'dist/ui-views/index.d.mts'),
      'export type Layout = import("react-grid-layout").Layout;\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });

  it('reports declaration self-imports of subpaths the exports map does not expose', () => {
    // The bundler rewrites cross-entry type imports to the entry's umbrella
    // subpath whether or not that subpath is public; a type-only edge never
    // reaches the runtime self-import scan, so the declaration scan must
    // validate the rewrite target against the exports map itself.
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { name: '@makaio/framework', exports: {} });
    writeBuiltFile(
      join(root, 'dist/adapter-subsystem/index.d.mts'),
      'import { AvailableAdapter } from "@makaio/framework/services/settings";\nexport { AvailableAdapter };\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: './services/settings',
        kind: 'unexported-dist-specifier',
        target: 'dist/adapter-subsystem/index.d.mts',
      }),
    ]);
  });

  it('reports workspace imports in any shipped declaration file, not only curated bundles', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { name: '@makaio/framework', exports: {} });
    writeBuiltFile(
      join(root, 'dist/adapters/claude/index.d.mts'),
      'export { ClaudeClient } from "@makaio/client-claude-code";\n',
    );

    const result = verifyFrameworkDist(root, { migrationChains: [] });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        exportKey: '@makaio/client-claude-code',
        kind: 'unbundled-declaration-import',
        target: 'dist/adapters/claude/index.d.mts',
      }),
    ]);
  });

  it('skips the self-contained declaration bundle scan for a runtime-only dist', () => {
    const root = makeTempDir();
    writeJson(join(root, 'package.json'), { exports: {} });
    writeBuiltFile(join(root, 'dist/bus/index.d.mts'), 'export { BusNamespace } from "@makaio/core";\n');

    const result = verifyFrameworkDist(root, { expectDeclarations: false, migrationChains: [] });

    expect(result.ok, result.issues.map((issue) => issue.message).join('\n')).toBe(true);
  });
});
