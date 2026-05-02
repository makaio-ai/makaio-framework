import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CredentialRef } from '@makaio/contracts/config';
import { resolveCredentialRef } from '../resolve-credential-ref.js';

describe('resolveCredentialRef', () => {
  const originalEnv = { ...process.env };
  let tempDir: string | null = null;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('resolves env: references', async () => {
    process.env.MAKAIO_TEST_TOKEN = 'env-secret';
    const result = await resolveCredentialRef('env:MAKAIO_TEST_TOKEN' as CredentialRef);
    expect(result).toBe('env-secret');
  });

  it('returns null for missing env var', async () => {
    const result = await resolveCredentialRef('env:MAKAIO_MISSING_TOKEN' as CredentialRef);
    expect(result).toBeNull();
  });

  it('resolves file: references', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'makaio-cred-'));
    const secretPath = path.join(tempDir, 'secret.txt');
    await writeFile(secretPath, 'file-secret\n', 'utf-8');

    const result = await resolveCredentialRef(`file:${secretPath}` as CredentialRef);
    expect(result).toBe('file-secret');
  });

  it('throws when keychain resolver is not configured', async () => {
    await expect(resolveCredentialRef('keychain:makaio:test' as CredentialRef)).rejects.toThrow(
      'Keychain credential resolution is not configured',
    );
  });
});
