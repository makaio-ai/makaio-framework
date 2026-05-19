import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConsentState } from '../types.js';

const CONSENT_FILENAME = 'consent.json';

const ConsentRecordSchema = z.object({
  acceptedAt: z.string(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  documentVersion: z.string(),
});

/**
 * Checks whether an unknown error has a Node filesystem error code.
 * @param error - Unknown caught error.
 * @param code - Filesystem error code to match.
 * @returns True when the error carries the requested filesystem code.
 */
function hasFsCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

/**
 * Reads the persisted consent record from disk.
 * @param makaioHome - Absolute path to the makaio home directory.
 * @returns The consent record, or null if not found or invalid.
 */
export async function readConsentRecord(makaioHome: string): Promise<ConsentState | null> {
  try {
    const raw = await readFile(join(makaioHome, CONSENT_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const result = ConsentRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (error) {
    if (hasFsCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * Writes a consent record to disk atomically with restricted permissions.
 * @param makaioHome - Absolute path to the makaio home directory.
 * @param record - The consent state to persist.
 */
export async function writeConsentRecord(makaioHome: string, record: ConsentState): Promise<void> {
  await mkdir(makaioHome, { recursive: true, mode: 0o700 });
  const target = join(makaioHome, CONSENT_FILENAME);
  const tmp = join(makaioHome, `.consent-${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}
