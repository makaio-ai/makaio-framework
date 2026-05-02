import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMigrationSourceId,
  discoverBundledMigrationSources,
  loadEmbeddedMigrations,
  renderEmbeddedMigrationsModule,
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

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMigrationDir(workspaceRoot: string, relativeDir: string, when: number, tag: string, sql: string): string {
  const drizzleDir = path.join(workspaceRoot, relativeDir, 'drizzle');
  mkdirSync(path.join(drizzleDir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(drizzleDir, 'meta', '_journal.json'),
    JSON.stringify({
      entries: [{ when, tag, breakpoints: false }],
    }),
  );
  writeFileSync(path.join(drizzleDir, `${tag}.sql`), sql);
  return drizzleDir;
}

describe('embedded build migrations', () => {
  it('renders a bundled migration reader that resolves the requested migration directory', async () => {
    const workspaceRoot = createTempDir('makaio-embedded-migrations-');
    const servicesRoot = path.join('services');
    const contextRulesDir = writeMigrationDir(
      workspaceRoot,
      path.join(servicesRoot, 'context-rules', 'storage'),
      1,
      '0000_context_rules',
      'CREATE TABLE `context_rules` (`id` text PRIMARY KEY NOT NULL);',
    );
    const trustedDevicesDir = writeMigrationDir(
      workspaceRoot,
      'framework/packages/storage-migrations',
      2,
      '0000_trusted_devices',
      'CREATE TABLE `trusted_devices` (`id` text PRIMARY KEY NOT NULL);',
    );

    const source = renderEmbeddedMigrationsModule(
      loadEmbeddedMigrations([
        {
          migrationSourceId: buildMigrationSourceId(workspaceRoot, contextRulesDir),
          migrationsDir: contextRulesDir,
        },
        {
          migrationSourceId: buildMigrationSourceId(workspaceRoot, trustedDevicesDir),
          migrationsDir: trustedDevicesDir,
        },
      ]),
      buildMigrationSourceId(workspaceRoot, trustedDevicesDir),
    );
    const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

    expect(mod.readMigrations()).toEqual([
      expect.objectContaining({
        tag: '0000_trusted_devices',
        folderMillis: 2,
        sql: ['CREATE TABLE `trusted_devices` (`id` text PRIMARY KEY NOT NULL);'],
      }),
    ]);
    expect(
      mod.readMigrations({
        migrationSourceId: buildMigrationSourceId(workspaceRoot, contextRulesDir),
        migrationsDir: path.join(workspaceRoot, 'app.asar', 'dist', 'drizzle'),
      }),
    ).toEqual([
      expect.objectContaining({
        tag: '0000_context_rules',
        folderMillis: 1,
        sql: ['CREATE TABLE `context_rules` (`id` text PRIMARY KEY NOT NULL);'],
      }),
    ]);
    expect(mod.readMigrations(trustedDevicesDir)).toEqual([
      expect.objectContaining({
        tag: '0000_trusted_devices',
        folderMillis: 2,
        sql: ['CREATE TABLE `trusted_devices` (`id` text PRIMARY KEY NOT NULL);'],
      }),
    ]);
    expect(mod.readMigrations(path.join(trustedDevicesDir, '..', path.basename(trustedDevicesDir)))).toEqual([
      expect.objectContaining({
        tag: '0000_trusted_devices',
        folderMillis: 2,
      }),
    ]);
    expect(mod.readMigrations(buildMigrationSourceId(workspaceRoot, trustedDevicesDir))).toEqual([
      expect.objectContaining({
        tag: '0000_trusted_devices',
        folderMillis: 2,
      }),
    ]);
    expect(() => mod.readMigrations(path.join(workspaceRoot, 'missing', 'drizzle'))).toThrow(/no embedded migrations/i);
  });

  it('discovers bundled migration directories while ignoring build output trees', () => {
    const workspaceRoot = createTempDir('makaio-embedded-migrations-discovery-');
    const servicesRoot = path.join('services');
    const keptDir = writeMigrationDir(
      workspaceRoot,
      path.join(servicesRoot, 'project', 'storage'),
      3,
      '0000_project',
      'CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL);',
    );
    writeMigrationDir(
      workspaceRoot,
      'framework/apps/electron/release/mac-arm64/Makaio.app/Contents/Resources/app.asar.unpacked/fake',
      4,
      '0000_release_artifact',
      'CREATE TABLE `fake_release` (`id` text PRIMARY KEY NOT NULL);',
    );

    expect(discoverBundledMigrationSources(workspaceRoot)).toEqual([
      {
        migrationSourceId: buildMigrationSourceId(workspaceRoot, keptDir),
        migrationsDir: keptDir,
      },
    ]);
  });

  it('fails with contextual errors when the journal shape is invalid', () => {
    const workspaceRoot = createTempDir('makaio-embedded-migrations-invalid-journal-');
    const drizzleDir = path.join(workspaceRoot, 'framework/packages/storage-migrations', 'drizzle');
    mkdirSync(path.join(drizzleDir, 'meta'), { recursive: true });
    writeFileSync(path.join(drizzleDir, 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '', when: 1 }] }));

    expect(() =>
      loadEmbeddedMigrations([
        {
          migrationSourceId: buildMigrationSourceId(workspaceRoot, drizzleDir),
          migrationsDir: drizzleDir,
        },
      ]),
    ).toThrow(/invalid journal entry 0/i);
  });

  it('fails with contextual errors when a journal entry is missing its sql file', () => {
    const workspaceRoot = createTempDir('makaio-embedded-migrations-missing-sql-');
    const drizzleDir = path.join(workspaceRoot, 'framework/packages/storage-migrations', 'drizzle');
    mkdirSync(path.join(drizzleDir, 'meta'), { recursive: true });
    writeFileSync(
      path.join(drizzleDir, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ when: 1, tag: '0000_missing', breakpoints: false }] }),
    );

    expect(() =>
      loadEmbeddedMigrations([
        {
          migrationSourceId: buildMigrationSourceId(workspaceRoot, drizzleDir),
          migrationsDir: drizzleDir,
        },
      ]),
    ).toThrow(/missing sql file/i);
  });

  it('skips unreadable directories during bundled migration discovery', () => {
    if (process.platform === 'win32') {
      return;
    }

    const workspaceRoot = createTempDir('makaio-embedded-migrations-unreadable-');
    const servicesRoot = path.join('services');
    const keptDir = writeMigrationDir(
      workspaceRoot,
      path.join(servicesRoot, 'project', 'storage'),
      3,
      '0000_project',
      'CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL);',
    );
    const blockedDir = writeMigrationDir(
      workspaceRoot,
      path.join('framework', 'blocked'),
      4,
      '0000_blocked',
      'CREATE TABLE `blocked` (`id` text PRIMARY KEY NOT NULL);',
    );
    chmodSync(blockedDir, 0o000);

    try {
      expect(discoverBundledMigrationSources(workspaceRoot)).toEqual([
        {
          migrationSourceId: buildMigrationSourceId(workspaceRoot, keptDir),
          migrationsDir: keptDir,
        },
      ]);
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });

  it('rejects migration directories outside the workspace root even when path.relative returns an absolute path', () => {
    const workspaceRoot = createTempDir('makaio-embedded-migrations-cross-drive-');

    const originalRelative = path.relative;
    const originalIsAbsolute = path.isAbsolute;
    const relativeSpy = vi.spyOn(path, 'relative').mockImplementation((from: string, to: string) => {
      if (String(from) === path.resolve(workspaceRoot) && String(to) === path.resolve('/tmp/outside-drizzle')) {
        return 'D:\\outside\\drizzle';
      }
      return originalRelative(from, to);
    });
    const isAbsoluteSpy = vi.spyOn(path, 'isAbsolute').mockImplementation((candidate: string) => {
      if (candidate === 'D:\\outside\\drizzle') {
        return true;
      }
      return originalIsAbsolute(candidate);
    });

    try {
      expect(() => buildMigrationSourceId(workspaceRoot, '/tmp/outside-drizzle')).toThrow(/outside workspace root/i);
    } finally {
      relativeSpy.mockRestore();
      isAbsoluteSpy.mockRestore();
    }
  });
});
