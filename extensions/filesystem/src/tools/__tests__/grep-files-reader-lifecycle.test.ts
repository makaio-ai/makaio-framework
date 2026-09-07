import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { createPathValidator } from '../../utils/index.js';
import { searchFile } from '../grep-files.js';
import { useTempDir } from './test-helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const createTempDir = useTempDir('grep-reader-lifecycle-');

afterEach(() => vi.restoreAllMocks());

describe('grep file reader lifecycle', () => {
  it.each([3, 1])('validates the handle before reading with a match budget of %i', async (budget) => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'mixed.txt');
    await fs.writeFile(filePath, 'Hello\nhello\nHELLO');
    const validate = createPathValidator(createMakaioContext({ cwd: dir }));
    const enteredStat = Promise.withResolvers<fs.FileHandle>();
    const releaseStat = Promise.withResolvers<void>();

    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'createReadStream');
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        enteredStat.resolve(handle);
        await releaseStat.promise;
        return stat();
      });
      return handle;
    });

    const search = searchFile(filePath, /hello/i, budget, validate);
    const handle = await enteredStat.promise;
    try {
      // Starting readline here can consume complete lines before its iterator exists.
      expect(handle.createReadStream).not.toHaveBeenCalled();
    } finally {
      releaseStat.resolve();
      await search;
    }

    const result = await search;
    expect(result).toEqual({
      matches: [
        { file: filePath, line: 1, text: 'Hello' },
        { file: filePath, line: 2, text: 'hello' },
        { file: filePath, line: 3, text: 'HELLO' },
      ].slice(0, budget),
      hasMore: budget < 3,
    });
    expect(handle.fd).toBe(-1);
    expect(vi.mocked(handle.createReadStream).mock.results[0]?.value.destroyed).toBe(true);
  });

  it('closes the opened handle without starting a reader when handle validation rejects', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'mixed.txt');
    await fs.writeFile(filePath, 'Hello\nhello\nHELLO');
    const validate = createPathValidator(createMakaioContext({ cwd: dir }));
    const opened = Promise.withResolvers<fs.FileHandle>();
    const failure = new Error('handle stat failed');

    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      vi.spyOn(handle, 'createReadStream');
      vi.spyOn(handle, 'stat').mockRejectedValueOnce(failure);
      opened.resolve(handle);
      return handle;
    });

    await expect(searchFile(filePath, /hello/i, 3, validate)).rejects.toBe(failure);
    const handle = await opened.promise;
    expect(handle.fd).toBe(-1);
    expect(handle.createReadStream).not.toHaveBeenCalled();
  });
});
