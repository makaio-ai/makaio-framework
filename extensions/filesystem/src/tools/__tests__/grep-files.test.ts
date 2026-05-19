import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { grepFilesTool } from '../grep-files.js';
import { useTempDir } from './test-helpers.js';

const createTempDir = useTempDir('grep-files-tool-');

describe('grep_files tool', () => {
  it('finds literal string matches', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\ngoodbye world\nhello again');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'hello', path: dir }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(2);
      expect(result.data.matches[0]!.line).toBe(1);
      expect(result.data.matches[0]!.text).toBe('hello world');
      expect(result.data.matches[1]!.line).toBe(3);
    }
  });

  it('supports regex patterns', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'code.ts'), 'const x = 1;\nlet y = 2;\nvar z = 3;');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: '^(const|let)', path: dir }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(2);
    }
  });

  it('supports case-insensitive matching', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'mixed.txt'), 'Hello\nhello\nHELLO');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'hello', path: dir, case_insensitive: true }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(3);
    }
  });

  it('filters by file glob', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'code.ts'), 'target line');
    await fs.writeFile(path.join(dir, 'data.json'), 'target line');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'target', path: dir, glob: '*.ts' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalMatches).toBe(1);
      expect(result.data.matches[0]!.file).toContain('code.ts');
    }
  });

  it('respects limit and offset', async () => {
    const dir = await createTempDir();
    const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join('\n');
    await fs.writeFile(path.join(dir, 'many.txt'), lines);

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'match', path: dir, limit: 5, offset: 3 }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matches).toHaveLength(5);
      // totalMatches is approximate with early termination: at least offset + limit
      expect(result.data.totalMatches).toBeGreaterThanOrEqual(8);
      expect(result.data.truncated).toBe(true);
    }
  });

  it('returns empty for no matches', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'empty.txt'), 'no matching content here');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'ZZZZZ', path: dir }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matches).toHaveLength(0);
      expect(result.data.totalMatches).toBe(0);
    }
  });

  it('returns error for invalid regex', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'test.txt'), 'content');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: '[invalid', path: dir }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('Unsafe regex');
    }
  });

  it('returns error for unsafe regex patterns', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'test.txt'), 'aaaaaaaaaaaaaaaaaaaaaaaa!');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: '(a+)+$', path: dir }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('Unsafe regex');
    }
  });

  it('rejects absolute file glob filters', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, 'test.txt'), 'content');

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute(
      { pattern: 'content', path: dir, glob: path.join(dir, '*.txt') },
      context,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('Absolute glob patterns');
    }
  });

  it('rejects parent directory traversal in file glob filters', async () => {
    const dir = await createTempDir();

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'content', path: dir, glob: '../*.txt' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('parent directories');
    }
  });

  it('rejects parent directory traversal inside brace file glob filters', async () => {
    const dir = await createTempDir();

    const context = createMakaioContext({ cwd: dir });
    const result = await grepFilesTool.execute({ pattern: 'content', path: dir, glob: '{../*.txt,*.md}' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('parent directories');
    }
  });
});
