/**
 * Stable cache-key helper for client/account pairs.
 *
 * These keys are used purely as in-memory cache identifiers and are never
 * persisted or embedded in URLs.
 *
 * The implementation must stay collision-free for arbitrary opaque IDs.
 * A delimiter-only scheme such as `${clientId}:${accountId}` would alias
 * pairs like `('a:b', 'c')` and `('a', 'b:c')`.
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Key factory
// ---------------------------------------------------------------------------

export interface ParsedAccountCacheKey {
  clientId: string;
  accountId: string;
}

/**
 * Creates a stable cache key for a client/account pair.
 *
 * Serialises the `(clientId, accountId)` tuple into a collision-free key.
 * @param clientId - Credential-source identifier.
 * @param accountId - Stable account identifier.
 * @returns Stable cache key string for the client/account tuple.
 */
export function createAccountCacheKey(clientId: string, accountId: string): string {
  return JSON.stringify([clientId, accountId]);
}

/**
 * Parses a stable cache key back into its client/account tuple.
 * @param key - Stable cache key string for the client/account tuple.
 * @returns Parsed client/account identifiers.
 */
export function parseAccountCacheKey(key: string): ParsedAccountCacheKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new Error(`Invalid account cache key: ${key}`);
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    parsed[0].length === 0 ||
    parsed[1].length === 0
  ) {
    throw new Error(`Invalid account cache key: ${key}`);
  }

  return {
    clientId: parsed[0],
    accountId: parsed[1],
  };
}
