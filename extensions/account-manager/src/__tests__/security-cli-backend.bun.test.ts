import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SecurityCliBackend } from '../backends/security-cli-backend.js';

const execFileAsync = promisify(execFile);

/**
 * Integration tests for {@link SecurityCliBackend}.
 *
 * These tests exercise the real macOS `/usr/bin/security` CLI and require
 * Keychain Access. They are skipped on non-macOS platforms.
 *
 * A unique service name is generated per test run so the tests never touch
 * real credentials and can be cleaned up deterministically in `afterAll`.
 */
describe.skipIf(process.platform !== 'darwin')('SecurityCliBackend (macOS integration)', () => {
  const testService = `makaio-test-security-cli-backend-${randomUUID()}`;
  const testAccount = 'test-account';

  let backend: SecurityCliBackend;

  beforeAll(() => {
    backend = new SecurityCliBackend(testService, testAccount);
  });

  afterAll(async () => {
    // Best-effort cleanup: delete the test keychain entry. Ignore errors in
    // case no entry was written (e.g. all write tests were skipped).
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', testService, '-a', testAccount]);
    } catch {
      // Entry may not exist — ignore
    }
  });

  it('read returns null when the keychain entry does not exist', async () => {
    const result = await backend.read();
    expect(result).toBeNull();
  });

  it('write then read round-trips a plain string value correctly', async () => {
    await backend.write('hello-world');
    const result = await backend.read();
    expect(result).toBe('hello-world');
  });

  it('overwrite: a second write replaces the first value', async () => {
    await backend.write('value-A');
    await backend.write('value-B');
    const result = await backend.read();
    expect(result).toBe('value-B');
  });

  it('hex encoding: special characters and unicode round-trip correctly', async () => {
    const complex = JSON.stringify({
      token: 'Bearer abc123',
      emoji: '🔑',
      quotes: `it's a "test"`,
      newline: 'line1\nline2',
    });
    await backend.write(complex);
    const result = await backend.read();
    expect(result).toBe(complex);
  });
});
