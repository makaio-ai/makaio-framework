import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { globFilesTool } from '../glob-files.js';
import { useTempDir } from './test-helpers.js';

const createTempDir = useTempDir('glob-files-tool-');

describe('glob_files tool', () => {
  it('matches files by extension', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'a.ts'), '');
    await fs.writeFile(path.join(dir, 'b.ts'), '');
    await fs.writeFile(path.join(dir, 'c.json'), '');

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '*.ts' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(2);
      expect(result.data.paths.every((p) => p.endsWith('.ts'))).toBe(true);
    }
  });

  it('searches recursively with **', async () => {
    const dir = await createTempDir();
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'top.ts'), '');
    await fs.writeFile(path.join(dir, 'sub', 'deep.ts'), '');

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '**/*.ts' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(2);
    }
  });

  it('respects limit and offset', async () => {
    const dir = await createTempDir();
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(dir, `file${String(i).padStart(2, '0')}.txt`), '');
    }

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '*.txt', limit: 3, offset: 2 }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toHaveLength(3);
      expect(result.data.totalMatches).toBe(10);
      expect(result.data.truncated).toBe(true);
    }
  });

  it('returns empty for no matches', async () => {
    const dir = await createTempDir();

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '*.xyz' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toHaveLength(0);
      expect(result.data.totalMatches).toBe(0);
      expect(result.data.truncated).toBe(false);
    }
  });

  it('rejects absolute patterns', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'outside.txt'), '');

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: path.join(dir, '*.txt') }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('Absolute glob patterns');
    }
  });

  it('rejects parent directory traversal in patterns', async () => {
    const dir = await createTempDir();

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '../*.txt' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('parent directories');
    }
  });

  it('rejects parent directory traversal inside brace patterns', async () => {
    const dir = await createTempDir();

    const context = createMakaioContext({ cwd: dir });
    const result = await globFilesTool.execute({ pattern: '{../*.txt,*.md}' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('parent directories');
    }
  });
});
