import type { StoredAccountCredential } from '../interfaces/account-store.js';
import { isRecord } from '@makaio/utils';

/** Serialized credential-only store shape. */
export type CredentialStoreData = Record<string, StoredAccountCredential[]>;

/**
 * Clone a stored account so callers always receive detached data.
 * @param account - Account to clone
 * @returns Caller-owned copy
 */
export function cloneStoredAccountCredential(account: StoredAccountCredential): StoredAccountCredential {
  return structuredClone(account);
}

/**
 * Normalizes raw persisted data to the credential-only live store shape.
 * @param raw - Parsed store payload from disk
 * @returns Credential rows grouped by client id
 */
export function normalizeCredentialStoreData(raw: unknown): CredentialStoreData {
  if (!isRecord(raw)) {
    return {};
  }
  const result: CredentialStoreData = {};
  for (const [clientId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const entries = value
      .map((entry) => normalizeCredentialEntry(entry))
      .filter((entry): entry is StoredAccountCredential => entry !== null)
      .map(cloneStoredAccountCredential);
    if (entries.length > 0) {
      result[clientId] = entries;
    }
  }
  return result;
}

/**
 * Validates one credential-store entry.
 * @param value - Candidate entry from parsed store data
 * @returns Normalized credential row, or null when invalid
 */
export function normalizeCredentialEntry(value: unknown): StoredAccountCredential | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !isRecord(value.credential)
  ) {
    return null;
  }
  const token = value.credential.token;
  const fingerprint = value.credential.fingerprint;
  const metadata = value.credential.metadata;
  if (typeof token !== 'string' || typeof fingerprint !== 'string' || !isRecord(metadata)) {
    return null;
  }
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    credential: {
      token,
      fingerprint,
      metadata: { ...metadata },
    },
  };
}
