import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { editFileTool } from '../edit-file.js';
import { useTempDir } from './test-helpers.js';

const createTempDir = useTempDir('edit-file-tool-');

describe('edit_file tool', () => {
  it('replaces a single occurrence', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'test.txt');
    await fs.writeFile(filePath, 'Hello World');

    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute({ path: filePath, old_string: 'Hello', new_string: 'Goodbye' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replacements).toBe(1);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('Goodbye World');
  });

  it('replaces all occurrences with replace_all', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'test.txt');
    await fs.writeFile(filePath, 'foo bar foo baz foo');

    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute(
      { path: filePath, old_string: 'foo', new_string: 'qux', replace_all: true },
      context,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replacements).toBe(3);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('fails if old_string is not found', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'test.txt');
    await fs.writeFile(filePath, 'Hello World');

    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute({ path: filePath, old_string: 'NotFound', new_string: 'X' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('old_string not found');
    }
  });

  it('fails if multiple occurrences and replace_all is false', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'test.txt');
    await fs.writeFile(filePath, 'aaa bbb aaa');

    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute({ path: filePath, old_string: 'aaa', new_string: 'ccc' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('found 2 times');
    }

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('aaa bbb aaa');
  });

  it('returns RESOURCE_NOT_FOUND for missing files', async () => {
    const dir = await createTempDir();
    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute(
      { path: path.join(dir, 'missing.txt'), old_string: 'x', new_string: 'y' },
      context,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('preserves multiline content around the replacement', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'multi.txt');
    await fs.writeFile(filePath, 'line 1\nTARGET\nline 3\n');

    const context = createMakaioContext({ cwd: dir });
    const result = await editFileTool.execute(
      { path: filePath, old_string: 'TARGET', new_string: 'REPLACED' },
      context,
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('line 1\nREPLACED\nline 3\n');
  });
});
