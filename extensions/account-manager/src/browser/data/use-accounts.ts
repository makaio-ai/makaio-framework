/**
 * Data hook that aggregates all accounts and credential sources.
 *
 * Lists sources via `accounts.getSources`, then fetches all accounts per
 * source via `accounts.list`. Refetches automatically on
 * `credentials.switched`, `credentials.refreshed`, and `credentials.detected`
 * events.
 * @packageDocumentation
 */

import { useCallback, useEffect, useState } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { Account, SourceInfo } from '@makaio/extension-account-manager/schemas';
import { useEffectGuard } from '../hooks/use-effect-guard.js';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Shape returned by {@link useAccounts}.
 */
export interface UseAccountsResult {
  /**
   * All known accounts grouped by their credential source `clientId`.
   * Empty while loading or on error.
   */
  accountsByClient: ReadonlyMap<string, Account[]>;
  /** Registered credential sources with availability information. */
  sources: readonly SourceInfo[];
  /** Whether a fetch is in progress. */
  loading: boolean;
  /** Last fetch error, or `null` when the most recent fetch succeeded. */
  error: Error | null;
  /** Manually trigger a re-fetch of sources and all accounts. */
  refresh: () => void;
}

/**
 * Aggregates all credential sources and their associated accounts.
 *
 * - Fetches sources via `accounts.getSources` then lists each source's
 *   accounts in parallel via `accounts.list`.
 * - Refetches on `credentials.switched`, `credentials.refreshed`, and
 *   `credentials.detected` bus events.
 * - Returns a no-op shape when no BusProvider ancestor is present.
 *
 * StrictMode-safe: run-id ref discards results from stale invocations.
 * @returns Aggregated accounts, sources, loading state, and refresh control.
 */
export function useAccounts(): UseAccountsResult {
  const bus = useOptionalBus();

  const [accountsByClient, setAccountsByClient] = useState<Map<string, Account[]>>(() => new Map());
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(() => bus !== null);
  const [error, setError] = useState<Error | null>(null);

  // StrictMode-safe run-id guard: discards stale async completions.
  const [, captureGeneration] = useEffectGuard();

  /**
   * Shared fetch body: resolves all sources then all accounts per source.
   *
   * Extracted to hook scope so both the effect-driven fetch and the manual
   * `refresh` call the same implementation. The `isCurrentRunFn` predicate
   * lets each callsite bind its own run-id snapshot for StrictMode safety.
   * @param resolvedBus - The bus instance guaranteed non-null by the caller.
   * @param isCurrentRunFn - Returns `true` while the initiating run is still active.
   */
  const performFetch = useCallback(async (resolvedBus: IMakaioBus, isCurrentRunFn: () => boolean): Promise<void> => {
    setLoading(true);
    try {
      const { sources: fetchedSources } = await resolvedBus.request(AccountManagerSubjects.accounts.getSources, {});
      if (!isCurrentRunFn()) return;

      const accountResults = await Promise.allSettled(
        fetchedSources.map(async (source) => {
          const result = await resolvedBus.request(AccountManagerSubjects.accounts.list, {
            clientId: source.clientId,
          });
          return { clientId: source.clientId, accounts: result.accounts };
        }),
      );
      if (!isCurrentRunFn()) return;

      const byClient = new Map<string, Account[]>();
      const rejected: string[] = [];
      for (const result of accountResults) {
        if (result.status === 'fulfilled') {
          byClient.set(result.value.clientId, result.value.accounts);
        } else {
          rejected.push(String(result.reason));
        }
      }

      // Partial failure is surfaced via `error` — consumers render a "data
      // may be incomplete" banner when error is non-null while sources are
      // present. Missing clientIds in byClient render as "No accounts
      // detected" under the visible banner, which is the intended UX.
      setSources(fetchedSources);
      setAccountsByClient(byClient);
      setError(
        rejected.length > 0
          ? new Error(`Failed to fetch accounts for ${rejected.length} source(s): ${rejected.join('; ')}`)
          : null,
      );
    } catch (err) {
      if (!isCurrentRunFn()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (isCurrentRunFn()) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!bus) return;

    void performFetch(bus, captureGeneration());

    const cleanups = [
      bus.on(AccountManagerSubjects.credentials.switched, () => {
        void performFetch(bus, captureGeneration());
      }),
      bus.on(AccountManagerSubjects.credentials.refreshed, () => {
        void performFetch(bus, captureGeneration());
      }),
      bus.on(AccountManagerSubjects.credentials.detected, () => {
        void performFetch(bus, captureGeneration());
      }),
      bus.on(AccountManagerSubjects.accounts.metadataPatched, () => {
        void performFetch(bus, captureGeneration());
      }),
      bus.on(AccountManagerSubjects.accounts.labeled, () => {
        void performFetch(bus, captureGeneration());
      }),
    ];

    return () => {
      captureGeneration(); // Invalidate this generation on cleanup.
      cleanups.forEach((fn) => fn());
    };
  }, [bus, performFetch, captureGeneration]);

  /**
   * Manually trigger a re-fetch of all sources and accounts.
   */
  const refresh = useCallback((): void => {
    if (!bus) return;
    void performFetch(bus, captureGeneration());
  }, [bus, performFetch, captureGeneration]);

  if (!bus) {
    return NO_BUS_RESULT;
  }

  return { accountsByClient, sources, loading, error, refresh };
}

/** No-op function used as the null-bus refresh stub. */
function noopRefresh(): void {
  // Intentionally empty.
}

/**
 * Shared empty map for the null-bus result.
 *
 * `ReadonlyMap` gives consumers the correct type-level contract; keeping one
 * module-level instance preserves stable dependency identities without
 * implying stronger runtime immutability than `Map` can provide here.
 */
const EMPTY_ACCOUNTS_BY_CLIENT: ReadonlyMap<string, Account[]> = new Map<string, Account[]>();

/**
 * Module-level frozen result returned when no bus is present so consumers
 * that put these fields in useEffect dependency arrays don't re-run on every
 * render due to fresh object/array/map identities.
 */
const NO_BUS_RESULT: UseAccountsResult = Object.freeze({
  accountsByClient: EMPTY_ACCOUNTS_BY_CLIENT,
  sources: Object.freeze<SourceInfo[]>([]),
  loading: false,
  error: null,
  refresh: noopRefresh,
}) as UseAccountsResult;
