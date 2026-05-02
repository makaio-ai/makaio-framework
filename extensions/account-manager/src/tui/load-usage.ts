import type { Dispatch, SetStateAction } from 'react';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { Account } from '../bus/schemas.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { usageKey, type UsageMap } from './usage-keys.js';
import type { UsageAwaitingResolutionMap } from './usage-state.js';

/** Dependencies required by {@link loadUsageForAccounts}. */
export interface LoadUsageDeps {
  /** Bus instance used to request usage data. */
  bus: IMakaioBus;
  /**
   * Guard that returns false when the load sequence has been superseded
   * or the component has unmounted.
   * @param loadSeq - Sequence token from the matching `loadData()` call.
   * @param isCurrentRun - Guard returning false on unmount/re-mount.
   */
  canCommitLoad: (loadSeq: number, isCurrentRun: () => boolean) => boolean;
  /** React state setter for the per-account usage map. */
  setUsageByAccount: Dispatch<SetStateAction<UsageMap>>;
  /** React state setter for the per-account usage-resolution marker map. */
  setUsageAwaitingResolutionByAccount: Dispatch<SetStateAction<UsageAwaitingResolutionMap>>;
}

/**
 * Merge usage snapshots for a single load run.
 *
 * The `loadSeq` token must come from the matching `loadData()` call so stale
 * usage work cannot commit after a newer reload has already advanced the
 * sequence.
 * @param deps - Bus and state setters required to merge usage.
 * @param loadSeq - Sequence token returned by the matching `loadData()` call.
 * @param accountsMap - Accounts to bootstrap usage for.
 * @param isCurrentRun - Guard that returns false on unmount/re-mount.
 */
export async function loadUsageForAccounts(
  { bus, canCommitLoad, setUsageByAccount, setUsageAwaitingResolutionByAccount }: LoadUsageDeps,
  loadSeq: number,
  accountsMap: Record<string, Account[]>,
  isCurrentRun: () => boolean,
): Promise<void> {
  const requestedKeys = Object.entries(accountsMap).flatMap(([clientId, accounts]) =>
    accounts.map((account) => usageKey(clientId, account.id)),
  );
  const requestedKeySet = new Set(requestedKeys);
  setUsageAwaitingResolutionByAccount((prev) => {
    const next = Object.fromEntries(
      Object.entries(prev).filter(([key]) => requestedKeySet.has(key)),
    ) as UsageAwaitingResolutionMap;
    for (const key of requestedKeys) next[key] = true;
    return next;
  });

  const requests = Object.entries(accountsMap).flatMap(([clientId, accounts]) =>
    accounts.map(async (account) => {
      const key = usageKey(clientId, account.id);
      try {
        const { usage } = await bus.request(AccountManagerSubjects.usage.get, {
          clientId,
          accountId: account.id,
        });
        if (!canCommitLoad(loadSeq, isCurrentRun)) return null;
        return { key, usage };
      } catch {
        return { key, usage: null };
      }
    }),
  );

  const results = await Promise.all(requests);
  if (!canCommitLoad(loadSeq, isCurrentRun)) return;

  setUsageAwaitingResolutionByAccount((prev) => {
    const next = Object.fromEntries(
      Object.entries(prev).filter(([key]) => requestedKeySet.has(key)),
    ) as UsageAwaitingResolutionMap;
    for (const key of requestedKeys) delete next[key];
    for (const entry of results) {
      if (entry?.usage === null) next[entry.key] = true;
    }
    return next;
  });

  setUsageByAccount((prev) => {
    let next = prev;
    for (const entry of results) {
      if (!entry || entry.usage === null) continue;
      const existing = next[entry.key];
      if (existing && existing.fetchedAt > entry.usage.fetchedAt) continue;
      if (next === prev) next = { ...prev };
      next[entry.key] = entry.usage;
    }
    return next;
  });
}
