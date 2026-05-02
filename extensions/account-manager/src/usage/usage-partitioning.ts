import { createAccountCacheKey, parseAccountCacheKey, type ParsedAccountCacheKey } from '../utils/account-key.js';

export type ParsedUsageCacheKey = ParsedAccountCacheKey;

/**
 * Builds the in-memory cache key used by {@link UsageTracker}.
 * @param clientId - Credential-source identifier
 * @param accountId - Stable account identifier
 * @returns Collision-free cache key for the client/account tuple
 */
export function createUsageCacheKey(clientId: string, accountId: string): string {
  if (clientId.length === 0 || accountId.length === 0) {
    throw new Error('clientId and accountId must be non-empty strings');
  }
  return createAccountCacheKey(clientId, accountId);
}

/**
 * Splits a cache key back into its client/account identifiers.
 * @param key - Collision-free cache key for the client/account tuple
 * @returns Parsed client/account identifiers
 */
export function parseUsageCacheKey(key: string): ParsedUsageCacheKey {
  try {
    return parseAccountCacheKey(key);
  } catch {
    throw new Error(`Invalid usage cache key: ${key}`);
  }
}
