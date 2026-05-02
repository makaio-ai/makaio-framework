import type { AccountUsage } from '../bus/schemas.js';
import { createAccountCacheKey } from '../utils/account-key.js';

/** Per-account usage map keyed by the stable tuple key from {@link usageKey}. */
export type UsageMap = Record<string, AccountUsage>;

/**
 * Build the composite key used to store usage data in {@link UsageMap}.
 * @param clientId - The credential source identifier.
 * @param accountId - The account identifier.
 * @returns Collision-free key for the `(clientId, accountId)` tuple.
 */
export function usageKey(clientId: string, accountId: string): string {
  return createAccountCacheKey(clientId, accountId);
}
