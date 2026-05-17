/**
 * Unit tests for {@link createNodeClientBinaryStrategyDependencies}.
 *
 * Tests cover each method of the returned {@link StrategyDependencies} object
 * using real temp files and a mocked global `fetch`. The exec, extractArchive,
 * and computeChecksum operations use real child processes and file I/O to
 * exercise the full code path without needing filesystem-level mocks.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeClientBinaryStrategyDependencies } from '../client-binary-strategy-dependencies.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temporary directory for each test.
 * @returns Absolute path of the created temp directory.
 */
async function makeTmpDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'makaio-test-'));
}

/**
 * Build a minimal mock {@link Response} for use with the `fetch` mock.
 * @param body - Response body string.
 * @param status - HTTP status code (defaults to 200).
 * @param headers - Optional response headers.
 * @returns A Response-compatible object.
 */
function mockResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  return new Response(body, { status, headers: h });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createNodeClientBinaryStrategyDependencies', () => {
  const deps = createNodeClientBinaryStrategyDependencies();

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // fetchText
  // -------------------------------------------------------------------------

  describe('fetchText', () => {
    it('returns the response body as a string on 2xx', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('hello world')),
      );

      const result = await deps.fetchText('https://example.com/text');

      expect(result).toBe('hello world');
    });

    it('throws on a non-2xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('not found', 404)),
      );

      await expect(deps.fetchText('https://example.com/missing')).rejects.toThrow('HTTP 404');
    });

    it('times out a stalled response', async () => {
      const timeoutDeps = createNodeClientBinaryStrategyDependencies({ fetchTimeoutMs: 5 });
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')), {
              once: true,
            });
          });
        }),
      );

      await expect(timeoutDeps.fetchText('https://example.com/hung')).rejects.toThrow('Timed out fetching');
    });
  });

  // -------------------------------------------------------------------------
  // fetchJson
  // -------------------------------------------------------------------------

  describe('fetchJson', () => {
    it('parses and returns the JSON body on 2xx', async () => {
      const payload = { version: '1.2.3' };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse(JSON.stringify(payload))),
      );

      const result = await deps.fetchJson('https://example.com/data.json');

      expect(result).toEqual(payload);
    });

    it('throws on a non-2xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('{}', 500)),
      );

      await expect(deps.fetchJson('https://example.com/data.json')).rejects.toThrow('HTTP 500');
    });
  });

  // -------------------------------------------------------------------------
  // downloadFile
  // -------------------------------------------------------------------------

  describe('downloadFile', () => {
    it('writes the response body to destPath and returns the path', async () => {
      const content = 'binary-content';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse(content)),
      );

      const destPath = path.join(tmpDir, 'downloaded.bin');
      const result = await deps.downloadFile('https://example.com/file.bin', destPath);

      expect(result).toBe(destPath);
      const written = await fsPromises.readFile(destPath, 'utf-8');
      expect(written).toBe(content);
    });

    it('creates the parent directory if it does not exist', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('data')),
      );

      const destPath = path.join(tmpDir, 'subdir', 'nested', 'file.bin');
      await deps.downloadFile('https://example.com/file.bin', destPath);

      expect(fs.existsSync(destPath)).toBe(true);
    });

    it('reports byte progress with Content-Length', async () => {
      const content = 'abcde';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse(content, 200, { 'content-length': String(content.length) })),
      );

      const destPath = path.join(tmpDir, 'progress.bin');
      const progressCalls: Array<[number, number | null]> = [];

      await deps.downloadFile('https://example.com/file.bin', destPath, (downloaded, total) => {
        progressCalls.push([downloaded, total]);
      });

      // At least one progress call should have a non-null total equal to the content length.
      const withTotal = progressCalls.filter(([, t]) => t !== null);
      expect(withTotal.length).toBeGreaterThan(0);
      expect(withTotal[withTotal.length - 1]![1]).toBe(content.length);
    });

    it('reports null total when Content-Length is absent', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('hello')),
      );

      const destPath = path.join(tmpDir, 'no-length.bin');
      const totals: Array<number | null> = [];

      await deps.downloadFile('https://example.com/file.bin', destPath, (_d, total) => {
        totals.push(total);
      });

      expect(totals.every((t) => t === null)).toBe(true);
    });

    it('throws on a non-2xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mockResponse('forbidden', 403)),
      );

      await expect(deps.downloadFile('https://example.com/secret', path.join(tmpDir, 'out'))).rejects.toThrow(
        'HTTP 403',
      );
    });
  });

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------

  describe('exec', () => {
    it('returns trimmed stdout for a successful command', async () => {
      const result = await deps.exec('echo', ['hello']);

      expect(result).toBe('hello');
    });

    it('includes stderr in the thrown error for failed commands', async () => {
      await expect(deps.exec('node', ['-e', 'process.stderr.write("oops"); process.exit(1)'])).rejects.toThrow(/oops/);
    });

    it('passes the cwd option to the spawned process', async () => {
      // pwd prints the real current working directory; resolve symlinks in
      // tmpDir so the comparison works on macOS where /var → /private/var.
      const realTmpDir = await fsPromises.realpath(tmpDir);
      const result = await deps.exec('pwd', [], { cwd: tmpDir });

      expect(result).toBe(realTmpDir);
    });

    it('times out a hung subprocess', async () => {
      const timeoutDeps = createNodeClientBinaryStrategyDependencies({ execTimeoutMs: 10 });

      await expect(timeoutDeps.exec('node', ['-e', 'setTimeout(() => undefined, 1000)'])).rejects.toThrow(
        'Command failed',
      );
    });

    it('passes merged environment variables to execFile', async () => {
      vi.stubEnv('MAKAIO_TEST_PARENT_ENV', 'parent');

      await expect(
        deps.exec(
          process.execPath,
          [
            '-e',
            'console.log(JSON.stringify({ injected: process.env.MAKAIO_TEST_EXEC_ENV, inherited: process.env.MAKAIO_TEST_PARENT_ENV }))',
          ],
          {
            env: { MAKAIO_TEST_EXEC_ENV: 'ok' },
          },
        ),
      ).resolves.toBe(JSON.stringify({ injected: 'ok', inherited: 'parent' }));
    });
  });

  // -------------------------------------------------------------------------
  // extractArchive
  // -------------------------------------------------------------------------

  describe('extractArchive', () => {
    it('extracts a tar.gz archive into destDir', async () => {
      // Create a minimal tar.gz containing a single file
      const srcFile = path.join(tmpDir, 'hello.txt');
      await fsPromises.writeFile(srcFile, 'hello from tar');

      const archivePath = path.join(tmpDir, 'test.tar.gz');
      await deps.exec('tar', ['-czf', archivePath, '-C', tmpDir, 'hello.txt']);

      const destDir = path.join(tmpDir, 'extracted-tar');
      await deps.extractArchive(archivePath, destDir, 'tar.gz');

      const content = await fsPromises.readFile(path.join(destDir, 'hello.txt'), 'utf-8');
      expect(content).toBe('hello from tar');
    });

    it('extracts a zip archive into destDir', async () => {
      const srcFile = path.join(tmpDir, 'hello.txt');
      await fsPromises.writeFile(srcFile, 'hello from zip');

      const archivePath = path.join(tmpDir, 'test.zip');
      // Use unzip-compatible zip creation via python3 zipfile module (available on macOS/Linux)
      await deps.exec('python3', [
        '-c',
        `import zipfile, os; z = zipfile.ZipFile('${archivePath}', 'w'); z.write('${srcFile}', 'hello.txt'); z.close()`,
      ]);

      const destDir = path.join(tmpDir, 'extracted-zip');
      await deps.extractArchive(archivePath, destDir, 'zip');

      const content = await fsPromises.readFile(path.join(destDir, 'hello.txt'), 'utf-8');
      expect(content).toBe('hello from zip');
    });

    it('creates destDir when it does not exist', async () => {
      const srcFile = path.join(tmpDir, 'data.txt');
      await fsPromises.writeFile(srcFile, 'data');

      const archivePath = path.join(tmpDir, 'data.tar.gz');
      await deps.exec('tar', ['-czf', archivePath, '-C', tmpDir, 'data.txt']);

      const destDir = path.join(tmpDir, 'new-dir', 'nested');
      await deps.extractArchive(archivePath, destDir, 'tar.gz');

      expect(fs.existsSync(destDir)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // computeChecksum
  // -------------------------------------------------------------------------

  describe('computeChecksum', () => {
    it('returns the sha256 hex digest of the file contents', async () => {
      const filePath = path.join(tmpDir, 'data.txt');
      await fsPromises.writeFile(filePath, 'hello');

      const result = await deps.computeChecksum(filePath);

      // Known sha256 of "hello": 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('uses the specified algorithm when provided', async () => {
      const filePath = path.join(tmpDir, 'data.txt');
      await fsPromises.writeFile(filePath, 'hello');

      const result = await deps.computeChecksum(filePath, 'md5');

      // Known md5 of "hello": 5d41402abc4b2a76b9719d911017c592
      expect(result).toBe('5d41402abc4b2a76b9719d911017c592');
    });
  });

  // -------------------------------------------------------------------------
  // deleteFile
  // -------------------------------------------------------------------------

  describe('deleteFile', () => {
    it('removes an existing file', async () => {
      const filePath = path.join(tmpDir, 'delete-me.txt');
      await fsPromises.writeFile(filePath, 'contents');

      await deps.deleteFile(filePath);

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('resolves without error when the file does not exist', async () => {
      const nonExistent = path.join(tmpDir, 'ghost-file.txt');

      await expect(deps.deleteFile(nonExistent)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // removeDirectory
  // -------------------------------------------------------------------------

  describe('removeDirectory', () => {
    it('removes an existing directory and all its contents', async () => {
      const dir = path.join(tmpDir, 'to-remove');
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, 'file.txt'), 'contents');

      await deps.removeDirectory(dir);

      expect(fs.existsSync(dir)).toBe(false);
    });

    it('resolves without error when the directory does not exist', async () => {
      const nonExistent = path.join(tmpDir, 'ghost');

      await expect(deps.removeDirectory(nonExistent)).resolves.toBeUndefined();
    });
  });
});
