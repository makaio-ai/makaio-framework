/**
 * Data hook for fetching historical usage entries for a single account.
 *
 * Calls `usage.history` once per unique filter+range combination and caches
 * the response so repeated renders with identical arguments hit the cache.
 * Debounces re-fetches on filter/range changes by 250 ms.
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { UsageEntry } from '@makaio-community/account-manager/schemas';
import { useEffectGuard } from '../hooks/use-effect-guard.js';

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Serialised request key → cached entries. */
const historyCache = new Map<string, UsageEntry[]>();
/** Serialised request key → in-flight request promise. */
const historyRequestCache = new Map<string, Promise<UsageEntry[]>>();
/** Upper bound for cached sliding-range history snapshots. */
const MAX_HISTORY_CACHE_ENTRIES = 100;

/**
 * Clears all cached history entries.
 *
 * Intended for test isolation only. Production code should not call this.
 */
export function clearHistoryCache(): void {
  historyCache.clear();
  historyRequestCache.clear();
}

/** Debounce delay for filter/range changes in milliseconds. */
export const DEBOUNCE_MS = 250;
const EMPTY_HISTORY_ENTRIES: readonly UsageEntry[] = Object.freeze<UsageEntry[]>([]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a filter+range pair to a stable string key for cache lookup.
 * @param filter - Account scope and optional window filter.
 * @param range - Inclusive time range bounds in epoch ms.
 * @returns JSON-stable cache key.
 */
function createHistoryCacheKey(
  filter: { clientId: string; accountId: string; windowId?: string },
  range: { from: number; to: number },
): string {
  return JSON.stringify({
    clientId: filter.clientId,
    accountId: filter.accountId,
    windowId: filter.windowId ?? null,
    from: range.from,
    to: range.to,
  });
}

/**
 * Stores a resolved history snapshot and evicts the oldest cached ranges.
 * Sliding windows continuously generate new keys, so the cache must stay bounded.
 * @param key - Stable request cache key.
 * @param entries - Resolved usage entries for the key.
 */
function cacheHistoryEntries(key: string, entries: UsageEntry[]): void {
  historyCache.delete(key);
  historyCache.set(key, entries);

  while (historyCache.size > MAX_HISTORY_CACHE_ENTRIES) {
    const oldestKey = historyCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    historyCache.delete(oldestKey);
  }
}

/**
 * Shared history loader with in-flight request deduplication per cache key.
 * @param bus - Bus instance used for the history RPC.
 * @param key - Stable request cache key.
 * @param payload - Request payload for `usage.history`.
 * @returns Promise resolving to history entries for the request key.
 */
function loadHistoryEntries(
  bus: NonNullable<ReturnType<typeof useOptionalBus>>,
  key: string,
  payload: {
    clientId: string;
    accountId: string;
    windowId?: string;
    from: number;
    to: number;
  },
): Promise<UsageEntry[]> {
  const cached = historyCache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const inFlight = historyRequestCache.get(key);
  if (inFlight !== undefined) {
    return inFlight;
  }

  const request = bus
    .request(AccountManagerSubjects.usage.history, payload)
    .then((result) => {
      // Only cache if this request has not been superseded by a reload().
      if (historyRequestCache.get(key) === request) {
        cacheHistoryEntries(key, result.entries);
      }
      return result.entries;
    })
    .finally(() => {
      if (historyRequestCache.get(key) === request) {
        historyRequestCache.delete(key);
      }
    });

  historyRequestCache.set(key, request);
  return request;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Shape returned by {@link useAccountHistory}.
 */
export interface UseAccountHistoryResult {
  /** Usage entries in ascending timestamp order. Empty while loading or on error. */
  entries: readonly UsageEntry[];
  /** Whether an RPC is in flight. */
  loading: boolean;
  /** Last fetch error, or `null` when the most recent fetch succeeded. */
  error: Error | null;
  /** Manually discard the cache and re-fetch for the current filter+range. */
  reload: () => void;
}

const NO_HISTORY_RESULT: UseAccountHistoryResult = Object.freeze({
  entries: EMPTY_HISTORY_ENTRIES,
  error: null,
  loading: false,
  reload: noopReload,
});

/**
 * Fetches historical usage entries for one account within a time range.
 *
 * - Debounces fetches by {@link DEBOUNCE_MS} on filter/range changes.
 * - Caches results by serialised key; a cache hit skips the RPC.
 * - Calling `reload()` clears the cache entry and triggers a fresh fetch.
 * - When bus is absent returns a no-op shape.
 *
 * StrictMode-safe: run-id ref discards stale async completions.
 * @param filter - Account scope and optional window filter.
 * @param range - Inclusive time range bounds in epoch ms.
 * @returns Current history state and reload control.
 */
export function useAccountHistory(
  filter: { clientId: string; accountId: string; windowId?: string },
  range: { from: number; to: number },
): UseAccountHistoryResult {
  const bus = useOptionalBus();
  const { clientId, accountId, windowId } = filter;
  const { from, to } = range;

  const cacheKey = createHistoryCacheKey(filter, range);
  const shouldLoadInitially = bus !== null && clientId !== '' && accountId !== '' && !historyCache.has(cacheKey);

  const [entries, setEntries] = useState<UsageEntry[]>(() => historyCache.get(cacheKey) ?? []);
  const [loading, setLoading] = useState<boolean>(shouldLoadInitially);
  const [error, setError] = useState<Error | null>(null);

  // StrictMode-safe run-id guard: discards stale async completions.
  const [, captureGeneration] = useEffectGuard();
  // Debounce timer handle.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doFetch = useCallback(
    async (isCurrent: () => boolean, key: string): Promise<void> => {
      if (!bus) return;

      setLoading(true);
      try {
        const nextEntries = await loadHistoryEntries(bus, key, {
          clientId,
          accountId,
          ...(windowId !== undefined ? { windowId } : {}),
          from,
          to,
        });
        if (!isCurrent()) return;
        setEntries(nextEntries);
        setError(null);
      } catch (err) {
        if (!isCurrent()) return;
        setEntries([]);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    },
    [bus, clientId, accountId, windowId, from, to],
  );

  useEffect(() => {
    if (!bus) return;

    // Bump run-id unconditionally so any prior in-flight fetch is invalidated,
    // even when the new render resolves via the cache.
    const isCurrent = captureGeneration();

    // Short-circuit when selection is not yet available: the service would
    // reject the empty-id key and log a noisy warning. Keep entries empty
    // and loading=false so the UI shows the neutral pre-selection state.
    if (clientId === '' || accountId === '') {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }

    // Cache hit — no fetch needed.
    if (historyCache.has(cacheKey)) {
      const cached = historyCache.get(cacheKey);
      if (cached !== undefined) {
        setEntries(cached);
        setError(null);
        setLoading(false);
      }
      return;
    }

    // Cache miss — clear stale entries and mark loading immediately so the
    // UI doesn't render the previous selection's data during the debounce.
    setEntries([]);
    setError(null);
    setLoading(true);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doFetch(isCurrent, cacheKey);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceRef.current);
      // Invalidate this run so any in-flight async completion is ignored
      // after unmount or when dependencies change.
      captureGeneration();
    };
  }, [bus, cacheKey, clientId, accountId, doFetch, captureGeneration]);

  const reload = useCallback((): void => {
    if (!bus || clientId === '' || accountId === '') {
      return;
    }
    historyCache.delete(cacheKey);
    historyRequestCache.delete(cacheKey);
    const isCurrent = captureGeneration();
    clearTimeout(debounceRef.current);
    void doFetch(isCurrent, cacheKey);
  }, [bus, clientId, accountId, cacheKey, doFetch, captureGeneration]);

  if (!bus) {
    return NO_HISTORY_RESULT;
  }

  return { entries, loading, error, reload };
}

/** No-op function used as the null-bus reload stub. */
function noopReload(): void {
  // Intentionally empty.
}
