import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TERMS_VERSION = '2026-05-17';

/**
 * Computes a SHA-256 hash of the given content.
 * @param content - The string content to hash.
 * @returns A 64-character lowercase hex digest.
 */
export function computeConsentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Loads the bundled terms document from disk.
 * @returns The terms text, version, and content hash.
 */
export async function loadConsentDocument(): Promise<{
  text: string;
  version: string;
  hash: string;
}> {
  const termsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../legal/terms.md');
  const text = await readFile(termsPath, 'utf8');
  return {
    text,
    version: TERMS_VERSION,
    hash: computeConsentHash(text),
  };
}
