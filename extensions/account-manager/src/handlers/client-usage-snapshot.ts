import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientUsageSnapshot } from '@makaio/contracts/client';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import type { IAccountMetadataStore, IAccountUsageSnapshotStore } from '../interfaces/account-store.js';
import { logAccountManagerError } from '../utils/diagnostics.js';
import { createUsageCacheKey } from '../usage/usage-partitioning.js';
import type { PersistedWindowState } from '../usage/usage-persistence.js';
import { scheduleUsagePersistence } from './usage-tracker-lifecycle.js';
import { resolveLinkedClientSnapshotFreshUntil, type UsageSourceConfig } from './usage-tracker-types.js';

interface IngestLinkedClientSnapshotOptions {
  bus: IMakaioBus;
  metadataStore: IAccountMetadataStore;
  usageSnapshotStore: IAccountUsageSnapshotStore | undefined;
  snapshot: ClientUsageSnapshot;
  accountGenerations: Map<string, number>;
  usageCache: Map<string, AccountUsage>;
  cacheKeyIndex: Map<string, { clientId: string; accountId: string }>;
  linkedClientSnapshotFreshUntil: Map<string, number>;
  lastFetchAt: Map<string, number>;
  errorCooldownUntil: Map<string, number>;
  persistedWindows: Map<string, Map<string, PersistedWindowState>>;
  persistenceChains: Map<string, Promise<void>>;
  pollIntervalMs: number;
  sourceConfigs: ReadonlyMap<string, UsageSourceConfig>;
  isCurrentGeneration: (cacheKey: string, generation: number) => boolean;
  isStopped: () => boolean;
  emitPendingResetsIfFresh: (
    clientId: string,
    accountId: string,
    cacheKey: string,
    generation: number,
  ) => Promise<void>;
}

/**
 * Bridges a canonical clients-core usage snapshot into local account-manager state.
 * @param opts - Tracker state and the normalized clients-core snapshot
 * @returns Nothing
 */
export async function ingestLinkedClientSnapshot(opts: IngestLinkedClientSnapshotOptions): Promise<void> {
  const linkedAccounts = await opts.metadataStore.listByLinkedClientAccountId(
    opts.snapshot.clientId,
    opts.snapshot.clientAccountId,
  );
  if (opts.isStopped() || linkedAccounts.length === 0) {
    return;
  }

  for (const account of linkedAccounts) {
    if (opts.isStopped()) {
      return;
    }

    const key = createUsageCacheKey(opts.snapshot.clientId, account.id);
    const generation = opts.accountGenerations.get(key) ?? 0;
    opts.accountGenerations.set(key, generation);

    const bridgedUsage = toAccountUsage(opts.snapshot);
    const currentUsage = opts.usageCache.get(key);
    if (currentUsage && currentUsage.fetchedAt > bridgedUsage.fetchedAt) {
      continue;
    }

    const now = Date.now();
    const freshnessObservedAt = Math.min(opts.snapshot.observedAt, now);
    opts.linkedClientSnapshotFreshUntil.set(
      key,
      resolveLinkedClientSnapshotFreshUntil(
        opts.sourceConfigs.get(opts.snapshot.clientId),
        opts.pollIntervalMs,
        account.active,
        freshnessObservedAt,
      ),
    );
    opts.lastFetchAt.set(key, now);
    opts.errorCooldownUntil.delete(key);
    opts.usageCache.set(key, bridgedUsage);
    opts.cacheKeyIndex.set(key, { clientId: opts.snapshot.clientId, accountId: account.id });

    scheduleUsagePersistence({
      clientId: opts.snapshot.clientId,
      accountId: account.id,
      usage: bridgedUsage,
      generation,
      usageSnapshotStore: opts.usageSnapshotStore,
      persistedWindows: opts.persistedWindows,
      persistenceChains: opts.persistenceChains,
      isCurrentGeneration: opts.isCurrentGeneration,
      isStopped: opts.isStopped,
      onPersistenceError: (sourceClientId, error) => {
        logAccountManagerError(`[UsageTracker] persistChangedWindows failed for source ${sourceClientId}:`, error);
      },
    });

    await opts.bus.emit(AccountManagerSubjects.usage.updated, {
      clientId: opts.snapshot.clientId,
      accountId: account.id,
      usage: bridgedUsage,
    });
    await opts.emitPendingResetsIfFresh(opts.snapshot.clientId, account.id, key, generation);
  }
}

/**
 * Converts a normalized clients-core snapshot into the account-manager shape.
 * @param snapshot - Canonical client usage snapshot
 * @returns Account-manager usage snapshot
 */
function toAccountUsage(snapshot: ClientUsageSnapshot): AccountUsage {
  return {
    fetchedAt: snapshot.observedAt,
    lastOkAt: snapshot.observedAt,
    stale: false,
    windows: snapshot.usage.windows.map((window) => ({
      id: window.key,
      label: window.label.trim() || window.key,
      utilization: window.usedPercentage,
      resetsAt: window.resetsAt ?? snapshot.observedAt,
      windowSeconds: 0,
    })),
  };
}
