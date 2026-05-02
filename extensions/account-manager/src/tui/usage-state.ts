/** Per-account usage-resolution markers keyed by the stable `usageKey(clientId, accountId)` string. */
export type UsageAwaitingResolutionMap = Record<string, true>;

/**
 * Remove one key from a string-keyed record, returning the same reference when the key is absent.
 * @param map - The source record.
 * @param key - Key to remove.
 * @returns Record without the requested key, or the original reference if the key was absent.
 */
export function removeKey<V>(map: Record<string, V>, key: string): Record<string, V> {
  if (!(key in map)) return map;
  const { [key]: _, ...rest } = map;
  return rest;
}

/**
 * Remove one account key from the usage-resolution marker map.
 * @param pendingByAccount - Current usage-resolution marker map.
 * @param key - Account key to remove.
 * @returns Marker map without the requested key.
 */
export function removeUsageResolutionKey(
  pendingByAccount: UsageAwaitingResolutionMap,
  key: string,
): UsageAwaitingResolutionMap {
  return removeKey(pendingByAccount, key);
}
