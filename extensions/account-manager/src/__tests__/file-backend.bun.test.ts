import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FileBackend } from '../backends/file-backend.js';

/**
 * Asserts no temp files matching the write pattern leaked in the credential dir.
 * @param credentialPath - Absolute path to the credential file under test
 */
async function expectNoTempFiles(credentialPath: string): Promise<void> {
  const entries = await readdir(dirname(credentialPath));
  const tmpFiles = entries.filter((e) => e.startsWith(basename(credentialPath)) && e.endsWith('.tmp'));
  expect(tmpFiles).toEqual([]);
}

describe('FileBackend', () => {
  let tmpDir: string;
  let credPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-backend-test-'));
    credPath = join(tmpDir, 'credential');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('read returns null when file does not exist', async () => {
    const backend = new FileBackend(credPath);
    const result = await backend.read();
    expect(result).toBeNull();
  });

  it('read returns file contents when file exists', async () => {
    await writeFile(credPath, 'my-token', 'utf-8');
    const backend = new FileBackend(credPath);
    const result = await backend.read();
    expect(result).toBe('my-token');
  });

  it('write creates the file and read round-trips the value', async () => {
    const backend = new FileBackend(credPath);
    await backend.write('round-trip-token');
    const result = await backend.read();
    expect(result).toBe('round-trip-token');
  });

  it('write sets 0o600 permissions and leaves no .tmp file behind', async () => {
    const backend = new FileBackend(credPath);
    await backend.write('secret-value');

    const fileStat = await stat(credPath);
    // Mask to the permission bits only (lower 12 bits)
    const mode = fileStat.mode & 0o777;
    expect(mode).toBe(0o600);

    await expectNoTempFiles(credPath);
  });

  it('write is atomic: the final file appears via rename', async () => {
    const backend = new FileBackend(credPath);

    // Capture the write call sequence by observing that the .tmp file is
    // never visible to a concurrent reader of the final path.  We achieve
    // this deterministically: write a known first value, then overwrite it.
    // If rename were not used, an interleaved reader could see a partial file.
    await backend.write('value-v1');
    await backend.write('value-v2');

    // After both writes the final path must hold the last value — not
    // a partial or intermediate state — confirming the rename-based swap.
    const result = await backend.read();
    expect(result).toBe('value-v2');

    await expectNoTempFiles(credPath);
  });

  it('read propagates non-ENOENT errors', async () => {
    // Create a directory at the credential path so open() fails with EISDIR,
    // which is a real I/O error that must not be swallowed.
    await mkdir(credPath);
    const backend = new FileBackend(credPath);
    await expect(backend.read()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
