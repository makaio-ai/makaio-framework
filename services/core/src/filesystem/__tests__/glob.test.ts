// services/filesystem/src/__tests__/glob.test.ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { FsSubjects } from '../namespace.js';
import { FileSystemService } from '../filesystem-service.js';

describe('FileSystemService glob handler', () => {
  let service: FileSystemService;
  let testDir: string;
  const testMachineId = 'glob-test-node';

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new FileSystemService(MakaioBus, testMachineId, 'GlobTest');
    await service.init();

    // Create test directory structure
    testDir = await mkdtemp(join(tmpdir(), 'glob-test-'));
    await mkdir(join(testDir, 'src'));
    await writeFile(join(testDir, 'src', 'index.ts'), '// index');
    await writeFile(join(testDir, 'src', 'utils.ts'), '// utils');
    await writeFile(join(testDir, 'README.md'), '# README');
  });

  afterEach(async () => {
    service.destroy();
    await rm(testDir, { recursive: true });
  });

  it('finds files matching pattern', async () => {
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.relativePath).sort()).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(2);
  });

  it('respects limit option', async () => {
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*',
      cwd: testDir,
      limit: 1,
    });

    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // total reflects all matches regardless of limit
    expect(result.total).toBeGreaterThan(1);
  });

  it('supports offset-based pagination', async () => {
    const page1 = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir,
      limit: 1,
      offset: 0,
    });
    const page2 = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir,
      limit: 1,
      offset: 1,
    });

    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.files).toHaveLength(1);
    expect(page2.files).toHaveLength(1);
    expect(page1.truncated).toBe(true);
    expect(page2.truncated).toBe(false);
    // Combined pages cover all files without overlap
    const allPaths = [...page1.files, ...page2.files].map((f) => f.relativePath).sort();
    expect(allPaths).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('returns empty for no matches', async () => {
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.xyz',
      cwd: testDir,
    });

    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('returns file size for matched files', async () => {
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/index.ts',
      cwd: testDir,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].size).toBeGreaterThan(0);
    expect(result.files[0].type).toBe('file');
  });

  it('returns directory entries when pattern matches directory', async () => {
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: 'src',
      cwd: testDir,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].type).toBe('directory');
    expect(result.files[0].relativePath).toBe('src');
  });

  it('respects ignore option', async () => {
    // Create a file in an ignored directory
    await mkdir(join(testDir, 'ignored'));
    await writeFile(join(testDir, 'ignored', 'file.ts'), '// ignored');

    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir,
      ignore: ['ignored/**'],
    });

    expect(result.files.map((f) => f.relativePath)).not.toContain('ignored/file.ts');
    expect(result.files).toHaveLength(2); // Only src/index.ts and src/utils.ts
  });

  it('always ignores node_modules and .git by default', async () => {
    // Create files in node_modules and .git
    await mkdir(join(testDir, 'node_modules'));
    await writeFile(join(testDir, 'node_modules', 'pkg.ts'), '// pkg');
    await mkdir(join(testDir, '.git'));
    await writeFile(join(testDir, '.git', 'config.ts'), '// git config');

    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir,
    });

    const paths = result.files.map((f) => f.relativePath);
    expect(paths).not.toContain('node_modules/pkg.ts');
    expect(paths).not.toContain('.git/config.ts');
    expect(result.files).toHaveLength(2); // Only src/index.ts and src/utils.ts
  });
});

describe('FileSystemService glob handler node routing', () => {
  let service1: FileSystemService;
  let service2: FileSystemService;
  let testDir1: string;
  let testDir2: string;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();

    // Create two separate test directories
    testDir1 = await mkdtemp(join(tmpdir(), 'glob-node1-'));
    testDir2 = await mkdtemp(join(tmpdir(), 'glob-node2-'));

    await writeFile(join(testDir1, 'node1-file.ts'), '// node 1');
    await writeFile(join(testDir2, 'node2-file.ts'), '// node 2');

    // Two filesystem services with different machineIds
    service1 = new FileSystemService(MakaioBus, 'node-1', 'Node 1');
    service2 = new FileSystemService(MakaioBus, 'node-2', 'Node 2');
    await service1.init();
    await service2.init();
  });

  afterEach(async () => {
    service1.destroy();
    service2.destroy();
    await rm(testDir1, { recursive: true });
    await rm(testDir2, { recursive: true });
  });

  it('routes to specific node when machineId provided', async () => {
    // Request specifically to node-2
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir2,
      machineId: 'node-2',
    });

    // Should get node2's file
    expect(result.files.some((f) => f.relativePath === 'node2-file.ts')).toBe(true);
  });

  it('rejects when machineId does not match any handler', async () => {
    // Request to non-existent node - no handler should respond
    await expect(
      MakaioBus.request(FsSubjects.glob, {
        pattern: '**/*.ts',
        cwd: testDir1,
        machineId: 'node-999', // No service has this machineId
      }),
    ).rejects.toThrow();
  });

  it('responds when machineId omitted (single-node assumption)', async () => {
    // Without machineId, behavior is deterministic only in single-node setups
    const result = await MakaioBus.request(FsSubjects.glob, {
      pattern: '**/*.ts',
      cwd: testDir1,
    });

    expect(result.files.length).toBeGreaterThanOrEqual(0);
  });
});
