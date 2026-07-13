import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY } from '../../types.js';
import { readFileTool } from '../read-file.js';
import { useTempDir } from './test-helpers.js';

const createTempDir = useTempDir('read-file-tool-');
const execFileAsync = promisify(execFile);

describe('read_file tool containment', () => {
  it('reads an in-root file', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const allowedPath = path.join(allowedDir, 'inside.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(allowedPath, 'inside content');
    const context = createMakaioContext({
      cwd: allowedDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [allowedDir], isDenied: () => false } },
    });

    const result = await readFileTool.execute({ path: allowedPath }, context);

    expect(result).toMatchObject({ success: true, data: { content: 'inside content' } });
  });

  it('rejects a file symlink that resolves outside an allowed directory', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const outsidePath = path.join(tempDir, 'outside.txt');
    const escapedPath = path.join(allowedDir, 'outside-link.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(outsidePath, 'outside secret');
    await fs.symlink(outsidePath, escapedPath);
    const context = createMakaioContext({
      cwd: allowedDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [allowedDir], isDenied: () => false } },
    });

    const result = await readFileTool.execute({ path: escapedPath }, context);

    expect(result).toMatchObject({ success: false, error: { code: 'PERMISSION_DENIED' } });
    expect(JSON.stringify(result)).not.toContain('outside secret');
  });

  it('rejects an allowed alias whose canonical target is ignored', async () => {
    const tempDir = await createTempDir();
    const targetPath = path.join(tempDir, 'secret.txt');
    const aliasPath = path.join(tempDir, 'visible-link.txt');
    await fs.writeFile(targetPath, 'ignored secret');
    await fs.symlink(targetPath, aliasPath);
    const canonicalTarget = await fs.realpath(targetPath);
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: {
        [FILE_ACCESS_RULES_KEY]: {
          allowedDirectories: [tempDir],
          isDenied: (candidate: string) => candidate === canonicalTarget,
        },
      },
    });

    const result = await readFileTool.execute({ path: aliasPath }, context);

    expect(result).toMatchObject({ success: false, error: { code: 'PERMISSION_DENIED' } });
    expect(JSON.stringify(result)).not.toContain('ignored secret');
  });

  it('enforces maxFileSize against the same opened file handle used for reading', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'oversized.txt');
    await fs.writeFile(filePath, 'too large');
    const context = createMakaioContext({ cwd: tempDir, constraints: { maxFileSize: 3 } });

    const result = await readFileTool.execute({ path: filePath }, context);

    expect(result).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('too large');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    const tempDir = await createTempDir();
    const fifoPath = path.join(tempDir, 'input.fifo');
    await execFileAsync('mkfifo', [fifoPath]);
    const context = createMakaioContext({ cwd: tempDir });

    const result = await readFileTool.execute({ path: fifoPath }, context);

    expect(result).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });
});
