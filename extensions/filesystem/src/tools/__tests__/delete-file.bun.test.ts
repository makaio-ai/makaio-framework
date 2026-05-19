import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'bun:test';
import { createMakaioContext } from '@makaio/core';
import { deleteFileTool } from '../delete-file.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-file-tool-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe('delete_file tool', () => {
  it('deletes regular files', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'target.txt');
    await fs.writeFile(filePath, 'content');

    const context = createMakaioContext({ cwd: dir });
    const result = await deleteFileTool.execute({ path: filePath }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe(filePath);
    }

    await expect(fs.access(filePath)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('rejects symlinks even when they point to regular files', async () => {
    const dir = await createTempDir();
    const targetPath = path.join(dir, 'target.txt');
    const linkPath = path.join(dir, 'link.txt');

    await fs.writeFile(targetPath, 'content');
    await fs.symlink(targetPath, linkPath);

    const context = createMakaioContext({ cwd: dir });
    const result = await deleteFileTool.execute({ path: linkPath }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('Path is not a regular file');
    }

    const stats = await fs.lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
  });

  it('returns RESOURCE_NOT_FOUND for missing files', async () => {
    const dir = await createTempDir();
    const missingPath = path.join(dir, 'missing.txt');

    const context = createMakaioContext({ cwd: dir });
    const result = await deleteFileTool.execute({ path: missingPath }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
    }

    await expect(fs.access(missingPath)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('returns VALIDATION_FAILED for directory paths and does not delete them', async () => {
    const dir = await createTempDir();
    const subdirPath = path.join(dir, 'subdir');
    await fs.mkdir(subdirPath);

    const context = createMakaioContext({ cwd: dir });
    const result = await deleteFileTool.execute({ path: subdirPath }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('Path is not a regular file');
    }

    const stats = await fs.stat(subdirPath);
    expect(stats.isDirectory()).toBe(true);
  });
});
