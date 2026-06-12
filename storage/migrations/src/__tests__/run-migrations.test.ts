/**
 * Unit tests for getMigrationsFolder.
 *
 * Validates that the zero-arg (sqlite default) and explicit-dialect overloads
 * resolve to the correct absolute paths and that the sqlite chain contains a
 * valid drizzle journal.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerStorageEngine } from '@makaio/storage-drizzle';
import { storageEngine as postgresStorageEngine } from '@makaio/storage-pg';
import { getMigrationsFolder } from '../run-migrations.js';

// getMigrationsFolder resolves chain directory names through the engine
// registry; register the Postgres engine so the 'postgres' paths under test
// are served by the real engine (same-reference re-registration is a no-op).
registerStorageEngine(postgresStorageEngine);

describe('getMigrationsFolder', () => {
  it('zero-arg call returns the same path as getMigrationsFolder("sqlite")', () => {
    expect(getMigrationsFolder()).toBe(getMigrationsFolder('sqlite'));
  });

  it('getMigrationsFolder("sqlite") ends with the drizzle path segment', () => {
    const result = getMigrationsFolder('sqlite');
    expect(result.endsWith(`${path.sep}drizzle`)).toBe(true);
  });

  it('getMigrationsFolder("postgres") ends with the drizzle-postgres path segment', () => {
    const result = getMigrationsFolder('postgres');
    expect(result.endsWith(`${path.sep}drizzle-postgres`)).toBe(true);
  });

  it('getMigrationsFolder("sqlite") is an absolute path', () => {
    expect(path.isAbsolute(getMigrationsFolder('sqlite'))).toBe(true);
  });

  it('getMigrationsFolder("postgres") is an absolute path', () => {
    expect(path.isAbsolute(getMigrationsFolder('postgres'))).toBe(true);
  });

  it('the sqlite drizzle folder contains meta/_journal.json (real migration chain exists)', () => {
    const sqliteFolder = getMigrationsFolder('sqlite');
    expect(existsSync(path.join(sqliteFolder, 'meta', '_journal.json'))).toBe(true);
  });
});
