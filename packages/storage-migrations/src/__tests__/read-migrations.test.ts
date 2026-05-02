import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMigrations } from '../read-migrations.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createMigrationDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'makaio-read-migrations-'));
  tempDirs.push(root);
  const migrationsDir = path.join(root, 'drizzle');
  mkdirSync(path.join(migrationsDir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify({
      entries: [{ when: 1, tag: '0000_init', breakpoints: false }],
    }),
  );
  writeFileSync(path.join(migrationsDir, '0000_init.sql'), 'CREATE TABLE test (`id` text PRIMARY KEY NOT NULL);');
  return migrationsDir;
}

describe('readMigrations', () => {
  it('reads filesystem migrations when called with a dual-source object', () => {
    const migrationsDir = createMigrationDir();

    expect(
      readMigrations({
        migrationsDir,
        migrationSourceId: 'host/services/src/test/drizzle',
      }),
    ).toEqual([
      expect.objectContaining({
        tag: '0000_init',
        folderMillis: 1,
        sql: ['CREATE TABLE test (`id` text PRIMARY KEY NOT NULL);'],
      }),
    ]);
  });
});
