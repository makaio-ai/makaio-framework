import type { RawCredential } from '../interfaces/credential-source.js';
import type { UsagePreparedCredential } from './usage-tracker-types.js';

/**
 * Reads the freshest prepared credential for a usage fetch, but degrades to the
 * stored credential when the injected callback throws or returns null.
 *
 * The callback is an external seam owned by package code. Falling back here
 * keeps transient native-store failures on the same path as a simple
 * unavailable read, so usage fetches still proceed and null usage results can
 * apply the normal cooldown behavior instead of aborting the whole fetch.
 * @param readCredential - Optional callback that reads a fresh native credential.
 * @param clientId - Credential-source identifier.
 * @param accountId - Stable account identifier.
 * @param key - Internal cache key for diagnostics.
 * @param storedCredential - Persisted credential fallback for the account.
 * @returns The freshest available credential outcome for this fetch.
 */
export async function readUsageCredential(
  readCredential: ((clientId: string, accountId: string) => Promise<UsagePreparedCredential | null>) | undefined,
  clientId: string,
  accountId: string,
  key: string,
  storedCredential: RawCredential,
): Promise<UsagePreparedCredential> {
  if (!readCredential) return { status: 'ready', credential: storedCredential, changed: false };

  try {
    return (
      (await readCredential(clientId, accountId)) ?? {
        status: 'ready',
        credential: storedCredential,
        changed: false,
      }
    );
  } catch (err) {
    console.error(`[UsageTracker] readCredential failed for ${key}:`, err instanceof Error ? err.message : err);
    return { status: 'ready', credential: storedCredential, changed: false };
  }
}
