/**
 * Visibility-aware polling hook for account usage data.
 *
 * Polls `usage.get` every 60 seconds while the document is visible and
 * subscribes to `credentials.switched`, `credentials.refreshed`, and
 * `usage.updated` for instant refresh. The manual `refresh()` action
 * triggers `usage.refresh` on the bus, relying on the server-side tracker
 * to emit `usage.updated` on completion.
 *
 * Results are cached at module level keyed by account so that multiple
 * widgets sharing the same filter avoid redundant RPCs.
 * @packageDocumentation
 */

import { useCallback, useSyncExternalStore } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { AccountUsage } from '@makaio-community/account-manager/schemas';
import { createAccountCacheKey } from '@makaio-community/account-manager/utils';

// ---------------------------------------------------------------------------
// Module-level cache and observer registry
// ---------------------------------------------------------------------------

/**
 * Module-level cache: accountKey → last known snapshot.
 *
 * Seeds newly-created shared observers so remounts do not flash empty state
 * before the first RPC resolves.
 */
const usageCache = new Map<string, AccountUsage>();
const usageObservers = new Map<string, UsageObserver>();

/**
 * Clears all cached usage snapshots.
 *
 * Intended for test isolation only. Production code should not call this.
 */
export function clearUsageCache(): void {
  usageCache.clear();
  for (const observer of usageObservers.values()) {
    observer.dispose();
  }
  usageObservers.clear();
}

interface UsageObserverState {
  data: AccountUsage | null;
  loading: boolean;
  error: Error | null;
}

interface UsageObserver {
  readonly accountId: string;
  readonly accountKey: string;
  readonly bus: NonNullable<ReturnType<typeof useOptionalBus>>;
  readonly cancelDeferredDispose: () => void;
  readonly clientId: string;
  readonly deferDispose: () => void;
  readonly listeners: Set<() => void>;
  dispose: () => void;
  readonly refresh: () => void;
  state: UsageObserverState;
}

const POLL_INTERVAL_MS = 60_000;
const NO_USAGE_OBSERVER_STATE: UsageObserverState = Object.freeze({
  data: null,
  error: null,
  loading: false,
});

/**
 * Build the initial observer snapshot for one account key.
 * @param accountKey - Stable account cache key.
 * @returns Initial observer state seeded from the module cache.
 */
function createInitialObserverState(accountKey: string): UsageObserverState {
  return {
    data: usageCache.get(accountKey) ?? null,
    error: null,
    loading: false,
  };
}

/**
 * Notify all subscribers of an observer state change.
 * @param observer - Shared observer whose listeners should be invoked.
 */
function notifyObserver(observer: UsageObserver): void {
  for (const listener of observer.listeners) {
    listener();
  }
}

/**
 * Merge a partial state update into an observer snapshot and notify listeners.
 * @param observer - Shared observer receiving the updated snapshot.
 * @param nextState - Partial state to merge into the current snapshot.
 */
function updateObserverState(observer: UsageObserver, nextState: Partial<UsageObserverState>): void {
  observer.state = { ...observer.state, ...nextState };
  notifyObserver(observer);
}

/**
 * Get or create the shared live observer for one account.
 * @param bus - Bus instance used for RPCs and event subscriptions.
 * @param clientId - Credential-source identifier.
 * @param accountId - Account identifier within the source.
 * @returns Shared observer for the requested account key.
 */
function getUsageObserver(
  bus: NonNullable<ReturnType<typeof useOptionalBus>>,
  clientId: string,
  accountId: string,
): UsageObserver {
  const accountKey = createAccountCacheKey(clientId, accountId);
  const existing = usageObservers.get(accountKey);
  if (existing && existing.bus === bus) {
    existing.cancelDeferredDispose();
    return existing;
  }

  existing?.dispose();

  const listeners = new Set<() => void>();
  let latestRequestId = 0;
  let refreshPending = false;
  let disposed = false;
  let deferredDisposeHandle: ReturnType<typeof setTimeout> | null = null;

  const observer: UsageObserver = {
    accountId,
    accountKey,
    bus,
    cancelDeferredDispose: () => {
      if (deferredDisposeHandle !== null) {
        clearTimeout(deferredDisposeHandle);
        deferredDisposeHandle = null;
      }
    },
    clientId,
    deferDispose: () => {
      if (deferredDisposeHandle !== null) {
        clearTimeout(deferredDisposeHandle);
      }
      deferredDisposeHandle = setTimeout(() => {
        deferredDisposeHandle = null;
        if (observer.listeners.size === 0) {
          observer.dispose();
        }
      }, 0);
    },
    listeners,
    state: createInitialObserverState(accountKey),
    refresh: () => {
      if (refreshPending || disposed) {
        return;
      }
      refreshPending = true;
      void bus
        .request(AccountManagerSubjects.usage.refresh, { clientId, accountId })
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }
          updateObserverState(observer, {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        })
        .finally(() => {
          refreshPending = false;
        });
    },
    dispose: () => undefined,
  };

  const fetchUsage = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    const requestId = ++latestRequestId;
    updateObserverState(observer, { loading: true });

    try {
      const result = await bus.request(AccountManagerSubjects.usage.get, { clientId, accountId });
      if (disposed || requestId !== latestRequestId) {
        return;
      }

      if (result.usage !== null) {
        usageCache.set(accountKey, result.usage);
      } else {
        usageCache.delete(accountKey);
      }

      updateObserverState(observer, {
        data: result.usage,
        error: null,
        loading: false,
      });
    } catch (error) {
      if (disposed || requestId !== latestRequestId) {
        return;
      }

      updateObserverState(observer, {
        error: error instanceof Error ? error : new Error(String(error)),
        loading: false,
      });
    }
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void fetchUsage();
    }
  };

  const unsubscribeSwitched = bus.on(AccountManagerSubjects.credentials.switched, () => void fetchUsage(), {
    filter: { clientId },
  });
  const unsubscribeRefreshed = bus.on(
    AccountManagerSubjects.credentials.refreshed,
    (ctx) => {
      if (ctx.payload.account.id === accountId) {
        void fetchUsage();
      }
    },
    { filter: { clientId } },
  );
  const unsubscribeUpdated = bus.on(
    AccountManagerSubjects.usage.updated,
    (ctx) => {
      if (disposed || ctx.payload.accountId !== accountId) {
        return;
      }
      // Event-pushed snapshots are fresher than any in-flight usage.get
      // response, so advance the request epoch before publishing them.
      latestRequestId += 1;
      usageCache.set(accountKey, ctx.payload.usage);
      updateObserverState(observer, {
        data: ctx.payload.usage,
        error: null,
        loading: false,
      });
    },
    { filter: { clientId } },
  );

  const pollHandle = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void fetchUsage();
    }
  }, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void fetchUsage();

  observer.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (deferredDisposeHandle !== null) {
      clearTimeout(deferredDisposeHandle);
      deferredDisposeHandle = null;
    }
    clearInterval(pollHandle);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    unsubscribeSwitched();
    unsubscribeRefreshed();
    unsubscribeUpdated();
    if (usageObservers.get(accountKey) === observer) {
      usageObservers.delete(accountKey);
    }
  };

  usageObservers.set(accountKey, observer);
  return observer;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Shape returned by {@link useUsageData}.
 */
export interface UseUsageDataResult {
  /** Latest usage snapshot, or `null` when not yet fetched or unavailable. */
  data: AccountUsage | null;
  /** Whether a fetch is in progress. */
  loading: boolean;
  /** Last fetch error, or `null` if the most recent fetch succeeded. */
  error: Error | null;
  /**
   * Manually trigger a fresh usage fetch.
   *
   * Sends a `usage.refresh` RPC to the server-side tracker which schedules
   * an immediate fetch and emits `usage.updated` on completion. The component
   * state is updated via the `usage.updated` subscription, not directly from
   * the RPC response.
   */
  refresh: () => void;
}

/**
 * Visibility-aware polling hook for a single account's usage snapshot.
 *
 * - Polls `usage.get` every 60 s while `document.visibilityState === 'visible'`.
 * - Pauses when the document is hidden; resumes with an immediate fetch on
 *   `visibilitychange`.
 * - Subscribes to `credentials.switched`, `credentials.refreshed`, and
 *   `usage.updated` for instant invalidation and state updates.
 * - When bus is absent (no BusProvider ancestor), returns a no-op shape without
 *   throwing.
 *
 * StrictMode-safe: uses a run-id ref to discard results from stale effect
 * invocations.
 * @param filter - Account scope to observe.
 * @returns Current snapshot state and control functions.
 */
export function useUsageData(filter: { clientId: string; accountId: string }): UseUsageDataResult {
  const bus = useOptionalBus();
  const { clientId, accountId } = filter;
  const accountKey = createAccountCacheKey(clientId, accountId);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!bus) {
        return () => undefined;
      }

      const observer = getUsageObserver(bus, clientId, accountId);
      observer.listeners.add(listener);

      return () => {
        observer.listeners.delete(listener);
        if (observer.listeners.size === 0) {
          observer.deferDispose();
        }
      };
    },
    [bus, clientId, accountId],
  );

  const getSnapshot = useCallback((): UsageObserverState => {
    if (!bus) {
      return NO_USAGE_OBSERVER_STATE;
    }

    return usageObservers.get(accountKey)?.state ?? NO_USAGE_OBSERVER_STATE;
  }, [accountKey, bus]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  /**
   * Manually trigger a fresh usage fetch via the `usage.refresh` RPC.
   *
   * State is updated via the `usage.updated` subscription after the server
   * completes the fetch — not from the RPC response directly.
   */
  const refresh = useCallback((): void => {
    if (!bus) {
      return;
    }

    getUsageObserver(bus, clientId, accountId).refresh();
  }, [bus, clientId, accountId]);

  if (!bus) {
    return { data: null, loading: false, error: null, refresh: noop };
  }

  return { ...state, refresh };
}

/** No-op function used as the null-bus refresh stub. */
function noop(): void {
  // Intentionally empty.
}
