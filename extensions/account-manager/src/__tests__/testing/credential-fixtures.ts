import { readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { expect } from 'vitest';
import type { StoredAccountCredential } from '../../interfaces/account-store.js';

/**
 * Builds a minimal credential-store fixture for use in tests.
 * @param overrides - Partial fields to merge over the defaults
 * @returns A complete `StoredAccountCredential`
 */
export function makeCredentialRecord(overrides: Partial<StoredAccountCredential> = {}): StoredAccountCredential {
  return {
    id: 'account-1',
    fingerprint: 'fp-abc123',
    credential: {
      token: 'tok-abc123',
      fingerprint: 'fp-abc123',
      metadata: {},
    },
    ...overrides,
  };
}

/**
 * Asserts that no `.tmp` files matching the store's write pattern are left in
 * the store's parent directory.
 * @param storePath - Absolute path to the store file under test
 */
export async function expectNoTempFiles(storePath: string): Promise<void> {
  const entries = await readdir(dirname(storePath));
  const tmpFiles = entries.filter((e) => e.startsWith(basename(storePath)) && e.endsWith('.tmp'));
  expect(tmpFiles).toEqual([]);
}
