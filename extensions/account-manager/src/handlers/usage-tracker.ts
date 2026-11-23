/* eslint max-lines: ["error", { "max": 560 }], max-lines-per-function: ["error", { "max": 100 }] */
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { ClientSubjects } from '@makaio/contracts/client';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import type { IUsageProvider } from '../interfaces/usage-provider.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
  StoredAccount,
} from '../interfaces/account-store.js';
import { logAccountManagerDiagnostic, logAccountManagerError } from '../utils/diagnostics.js';
import type { SchedulableTarget } from '../utils/overdue-scheduler.js';
import { OverdueScheduler } from '../utils/overdue-scheduler.js';
import {
  awaitAccountQuiescence,
  awaitTrackerQuiescence,
  checkAndEmitPendingResets,
  collectPendingResetsFromCache,
  createSourceErrorLogger,
  emitStaleSnapshotIfCurrent,
  hasFreshLinkedClientSnapshot,
  invalidateTrackerAccountState,
  logQuiescenceTimeout,
  scheduleTrackedMetadataInvalidations,
  sleepUnref,
  startUsageRefreshes,
  type InFlightSourcePoll,
} from './usage-tracker-lifecycle.js';
import { ingestLinkedClientSnapshot } from './client-usage-snapshot.js';
import {
  executeUsageFetch,
  handleUsageFetchError,
  loadUsageFetchAccount,
  resolveUsageFetchCredential,
} from './usage-tracker-fetch.js';
import {
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  resolveMinFetchInterval,
  resolveTargetInterval,
  type UsagePreparedCredential,
  type UsageSourceConfig,
  type UsageTrackerDeps,
} from './usage-tracker-types.js';
import { createUsageCacheKey } from '../usage/usage-partitioning.js';
import type { PersistedWindowState } from '../usage/usage-persistence.js';
import { listStoredAccounts } from '../storage/joined-account-store.js';

const USAGE_THROTTLE_MS = 60_000,
  ERROR_COOLDOWN_MS = 30_000;

export class UsageTracker {
  private readonly bus: IMakaioBus;
  private readonly sources: Map<string, IUsageProvider>;
  private readonly credentialStore: IAccountCredentialStore;
  private readonly metadataStore: IAccountMetadataStore;
  private readonly usageSnapshotStore: IAccountUsageSnapshotStore | undefined;
  private readonly pollIntervalMs: number;
  private readonly sourceConfigs: Map<string, UsageSourceConfig>;
  private readonly scheduler = new OverdueScheduler();
  private readonly pollHandles = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pollingSources = new Set<string>();
  private readonly inFlightSourcePolls = new Map<string, InFlightSourcePoll>();
  private stopped = false;
  private readonly usageCache = new Map<string, AccountUsage>();
  private readonly linkedClientSnapshotFreshUntil = new Map<string, number>();
  private readonly persistedWindows = new Map<string, Map<string, PersistedWindowState>>();
  private readonly lastFetchAt = new Map<string, number>();
  private readonly inFlightFetches = new Map<string, Promise<void>>();
  private readonly errorCooldownUntil = new Map<string, number>();
  private readonly transientFailureCounts = new Map<string, number>();
  private readonly sourceCooldownUntil = new Map<string, number>();
  private readonly accountGenerations = new Map<string, number>();
  private readonly metadataInvalidations = new Map<string, Promise<void>>();
  private readonly cleanups: Array<() => void> = [];
  private readonly persistenceChains = new Map<string, Promise<void>>();
  /** Deduplication map for `usage.windowResetAvailable` events: cacheKey → windowId → expiredAt. */
  private readonly pendingResets = new Map<string, Map<string, number>>();
  /** Reverse lookup from cache key to `{ clientId, accountId }` for the `getPendingResets` RPC. */
  private readonly cacheKeyIndex = new Map<string, { clientId: string; accountId: string }>();
  private readonly readCredential:
    | ((call: CallContext, clientId: string, accountId: string) => Promise<UsagePreparedCredential | null>)
    | undefined;

  public constructor(deps: UsageTrackerDeps) {
    this.bus = deps.bus;
    this.sources = deps.sources;
    this.credentialStore = deps.credentialStore;
    this.metadataStore = deps.metadataStore;
    this.usageSnapshotStore = deps.usageSnapshotStore;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
    this.sourceConfigs = deps.sourceConfigs ?? new Map();
    this.readCredential = deps.readCredential;
  }
  public start(): void {
    this.cleanups.push(
      this.bus.on(AccountManagerSubjects.credentials.detected, async (ctx) => {
        await this.fetchAndEmit(ctx.call, ctx.payload.clientId, ctx.payload.account.id);
      }),
      this.bus.on(AccountManagerSubjects.credentials.refreshed, async (ctx) => {
        await this.fetchAndEmit(
          ctx.call,
          ctx.payload.clientId,
          ctx.payload.account.id,
          ctx.payload.reason === 'label-retry' ? {} : { forceRefresh: true },
        );
      }),
      this.bus.on(AccountManagerSubjects.credentials.switched, async (ctx) => {
        if (ctx.payload.from) {
          void this.fetchAndEmit(ctx.call, ctx.payload.clientId, ctx.payload.from.id, { forceRefresh: true });
        }
        await this.fetchAndEmit(ctx.call, ctx.payload.clientId, ctx.payload.to.id, { forceRefresh: true });
      }),
      this.bus.on(AccountManagerSubjects.usage.get, async (ctx) => {
        const { clientId, accountId } = ctx.payload;
        const cached = this.usageCache.get(createUsageCacheKey(clientId, accountId));
        if (cached) {
          ctx.setResult({ usage: cached });
          return;
        }
        void this.fetchAndEmit(ctx.call, clientId, accountId, { forceRefresh: true });
        ctx.setResult({ usage: null });
      }),
      this.bus.on(AccountManagerSubjects.usage.refresh, async (ctx) => {
        const scheduled = await startUsageRefreshes({
          call: ctx.call,
          sources: this.sources,
          metadataStore: this.metadataStore,
          credentialStore: this.credentialStore,
          clientId: ctx.payload.clientId,
          accountId: ctx.payload.accountId,
          startFetch: (clientId, accountId) =>
            this.startFetchAndEmit(ctx.call, clientId, accountId, { forceRefresh: true }) !== null,
        });
        ctx.setResult({ refreshed: scheduled });
      }),
      this.bus.on(AccountManagerSubjects.usage.getPendingResets, (ctx) => {
        ctx.setResult({
          pending: collectPendingResetsFromCache(
            this.usageCache,
            this.cacheKeyIndex,
            ctx.payload.clientId,
            ctx.payload.accountId,
          ),
        });
      }),
      this.bus.on(ClientSubjects.usage.snapshot, async (ctx) => {
        await ingestLinkedClientSnapshot({
          call: ctx.call,
          bus: this.bus,
          metadataStore: this.metadataStore,
          usageSnapshotStore: this.usageSnapshotStore,
          snapshot: ctx.payload,
          accountGenerations: this.accountGenerations,
          usageCache: this.usageCache,
          cacheKeyIndex: this.cacheKeyIndex,
          linkedClientSnapshotFreshUntil: this.linkedClientSnapshotFreshUntil,
          lastFetchAt: this.lastFetchAt,
          errorCooldownUntil: this.errorCooldownUntil,
          persistedWindows: this.persistedWindows,
          persistenceChains: this.persistenceChains,
          pollIntervalMs: this.pollIntervalMs,
          sourceConfigs: this.sourceConfigs,
          isCurrentGeneration: (cacheKey, currentGeneration) =>
            (this.accountGenerations.get(cacheKey) ?? 0) === currentGeneration,
          isStopped: () => this.stopped,
          emitPendingResetsIfFresh: (sourceClientId, sourceAccountId, cacheKey, currentGeneration) =>
            this.emitPendingResetsIfFresh(ctx.call, sourceClientId, sourceAccountId, cacheKey, currentGeneration),
        });
      }),
    );

    for (const clientId of this.sources.keys()) {
      const interval = resolveMinFetchInterval(this.sourceConfigs.get(clientId), this.pollIntervalMs);
      if (interval <= 0) continue;
      this.pollHandles.set(
        clientId,
        setInterval(() => this.runScheduledTick(clientId, 'periodic'), interval),
      );
    }
  }
  public bootstrap(): void {
    for (const clientId of this.sources.keys())
      if (resolveMinFetchInterval(this.sourceConfigs.get(clientId), this.pollIntervalMs) > 0)
        this.runScheduledTick(clientId, 'bootstrap');
  }
  /** Stops new work and waits for already-started work to quiesce. */
  public async stop(): Promise<void> {
    const trackedKeys = [...this.accountGenerations.keys()];
    this.requestStop();
    const call = this.bus.own('stop');
    scheduleTrackedMetadataInvalidations({
      call,
      trackedKeys,
      metadataStore: this.metadataStore,
      metadataInvalidations: this.metadataInvalidations,
      onInvalidationError: createSourceErrorLogger('bumpMetadataGeneration'),
    });
    const drained = await awaitTrackerQuiescence({
      inFlightSourcePolls: this.inFlightSourcePolls,
      inFlightFetches: this.inFlightFetches,
      persistenceChains: this.persistenceChains,
      metadataInvalidations: this.metadataInvalidations,
    });
    if (!drained) {
      logQuiescenceTimeout('stop timed out waiting for tracker quiescence', 'Tracker quiescence timeout');
    }
    this.usageCache.clear();
    this.linkedClientSnapshotFreshUntil.clear();
    this.persistedWindows.clear();
    this.lastFetchAt.clear();
    this.errorCooldownUntil.clear();
    this.transientFailureCounts.clear();
    this.sourceCooldownUntil.clear();
    this.pollingSources.clear();
    this.inFlightSourcePolls.clear();
    this.inFlightFetches.clear();
    this.persistenceChains.clear();
    this.accountGenerations.clear();
    this.metadataInvalidations.clear();
    this.pendingResets.clear();
    this.cacheKeyIndex.clear();
  }
  /** Synchronously prevents new tracker work from starting. */
  public requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.pollHandles.values()) clearInterval(handle);
    this.pollHandles.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }
  private runScheduledTick(clientId: string, label: 'bootstrap' | 'periodic'): void {
    if (this.stopped || this.pollingSources.has(clientId)) return;
    this.pollingSources.add(clientId);
    const pollState: { promise: Promise<void>; accountKey: string | null } = {
      promise: Promise.resolve(),
      accountKey: null,
    };
    const call = this.bus.own('schedule');
    const pollPromise = this.pickAndFetchOne(call, clientId, label, pollState)
      .catch((err: unknown) => {
        logAccountManagerError(`[UsageTracker] ${label} tick failed for ${clientId}:`, err);
      })
      .finally(() => {
        this.pollingSources.delete(clientId);
        if (this.inFlightSourcePolls.get(clientId)?.promise === pollPromise) {
          this.inFlightSourcePolls.delete(clientId);
        }
      });
    pollState.promise = pollPromise;
    this.inFlightSourcePolls.set(clientId, pollState);
    void pollPromise;
  }
  private async pickAndFetchOne(
    call: CallContext,
    clientId: string,
    label: 'bootstrap' | 'periodic',
    pollState: { accountKey: string | null },
  ): Promise<void> {
    if (!this.sources.has(clientId)) return;
    if (Date.now() < (this.sourceCooldownUntil.get(clientId) ?? 0)) return;
    const accounts = await listStoredAccounts(call, this.metadataStore, this.credentialStore, clientId);
    if (this.stopped) return;
    const targets = buildSchedulableTargets(clientId, accounts, this.lastFetchAt, this.sourceConfigs.get(clientId));
    const chosen = this.scheduler.pick(targets, Date.now());
    if (!chosen) {
      logAccountManagerDiagnostic(
        'UsageTracker',
        `${label} tick ${clientId}: no account due (${accounts.length} candidates)`,
      );
      return;
    }
    logAccountManagerDiagnostic('UsageTracker', `${label} tick ${clientId}: picked account ${chosen.key}`);
    pollState.accountKey = createUsageCacheKey(clientId, chosen.key);
    const jitter = this.sourceConfigs.get(clientId)?.jitterMs ?? 0;
    if (label === 'periodic' && jitter > 0) {
      await sleepUnref(Math.random() * jitter);
      if (this.stopped) return;
    }
    await this.fetchAndEmit(call, clientId, chosen.key, { forceRefresh: true });
  }
  /**
   * Clears cached usage state for one account without waiting for in-flight work to drain.
   * @param call - Call context of the request that clears the account state.
   * @param clientId - Source identifier the account belongs to.
   * @param accountId - Account identifier whose cached usage state is cleared.
   */
  public clearAccountState(call: CallContext, clientId: string, accountId: string): void {
    void this.invalidateAccountState(call, clientId, accountId);
  }
  /**
   * Clears cached usage state for one account and waits until the account's in-flight fetches,
   * polls and persistence have quiesced.
   * @param call - Call context of the request that clears the account state.
   * @param clientId - Source identifier the account belongs to.
   * @param accountId - Account identifier whose cached usage state is cleared.
   * @returns Resolves once the account's state is cleared and in-flight work has quiesced.
   */
  public async clearAccountStateAndWait(call: CallContext, clientId: string, accountId: string): Promise<void> {
    const key = createUsageCacheKey(clientId, accountId);
    await this.invalidateAccountState(call, clientId, accountId);
    const drained = await awaitAccountQuiescence({
      clientId,
      key,
      inFlightSourcePolls: this.inFlightSourcePolls,
      inFlightFetches: this.inFlightFetches,
      persistenceChains: this.persistenceChains,
    });
    if (!drained) {
      logQuiescenceTimeout(
        `clearAccountStateAndWait timed out for ${clientId}/${accountId}`,
        'Account quiescence timeout',
      );
    }
  }
  public async waitForAccountQuiescence(clientId: string, accountId: string): Promise<void> {
    await this.metadataInvalidations.get(createUsageCacheKey(clientId, accountId));
    const drained = await awaitAccountQuiescence({
      clientId,
      key: createUsageCacheKey(clientId, accountId),
      inFlightSourcePolls: this.inFlightSourcePolls,
      inFlightFetches: this.inFlightFetches,
      persistenceChains: this.persistenceChains,
    });
    if (!drained) {
      logQuiescenceTimeout(
        `waitForAccountQuiescence timed out for ${clientId}/${accountId}`,
        'Account quiescence timeout',
      );
    }
  }
  private invalidateAccountState(call: CallContext, clientId: string, accountId: string): Promise<void> {
    const key = createUsageCacheKey(clientId, accountId);
    this.linkedClientSnapshotFreshUntil.delete(key);
    this.transientFailureCounts.delete(key);
    return invalidateTrackerAccountState({
      call,
      clientId,
      accountId,
      accountGenerations: this.accountGenerations,
      usageCache: this.usageCache,
      persistedWindows: this.persistedWindows,
      lastFetchAt: this.lastFetchAt,
      errorCooldownUntil: this.errorCooldownUntil,
      pendingResets: this.pendingResets,
      cacheKeyIndex: this.cacheKeyIndex,
      metadataStore: this.metadataStore,
      metadataInvalidations: this.metadataInvalidations,
      onInvalidationError: createSourceErrorLogger('bumpMetadataGeneration'),
    });
  }
  private async fetchAndEmit(
    call: CallContext,
    clientId: string,
    accountId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<boolean> {
    const key = createUsageCacheKey(clientId, accountId);
    const existingFetch = this.inFlightFetches.get(key);
    if (existingFetch) {
      logAccountManagerDiagnostic('UsageTracker', `fetchAndEmit ${clientId}/${accountId}: awaiting in-flight fetch`);
      if (options.forceRefresh) await existingFetch;
      return false;
    }
    const fetchPromise = this.startFetchAndEmit(call, clientId, accountId, options);
    if (!fetchPromise) return false;
    await fetchPromise;
    return true;
  }
  private startFetchAndEmit(
    call: CallContext,
    clientId: string,
    accountId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<void> | null {
    const key = createUsageCacheKey(clientId, accountId);
    const source = this.sources.get(clientId);
    if (
      this.stopped ||
      this.inFlightFetches.has(key) ||
      !source ||
      (!options.forceRefresh && hasFreshLinkedClientSnapshot(this.linkedClientSnapshotFreshUntil, key)) ||
      Date.now() < (this.sourceCooldownUntil.get(clientId) ?? 0)
    )
      return null;
    const now = Date.now();
    const errorCooldownRemaining = (this.errorCooldownUntil.get(key) ?? 0) - now;
    if (errorCooldownRemaining > 0) {
      console.warn(
        `[UsageTracker] ${new Date(now).toISOString()} source ${clientId} account ${accountId} fetch suppressed: errorCooldown expires in ${errorCooldownRemaining}ms`,
      );
      return null;
    }
    if (!options.forceRefresh && now - (this.lastFetchAt.get(key) ?? 0) < USAGE_THROTTLE_MS) return null;
    const generation = this.accountGenerations.get(key) ?? 0;
    if (!this.accountGenerations.has(key)) this.accountGenerations.set(key, 0);
    this.lastFetchAt.set(key, Date.now());
    const fetchPromise = this.runFetchAndEmit(call, clientId, accountId, key, generation, source).finally(() => {
      if (this.inFlightFetches.get(key) === fetchPromise) this.inFlightFetches.delete(key);
    });
    this.inFlightFetches.set(key, fetchPromise);
    return fetchPromise;
  }
  private async runFetchAndEmit(
    call: CallContext,
    clientId: string,
    accountId: string,
    key: string,
    generation: number,
    source: IUsageProvider,
  ): Promise<void> {
    if (this.stopped) return;
    let credential: RawCredential | null = null;
    try {
      const account = await loadUsageFetchAccount({
        call,
        metadataStore: this.metadataStore,
        credentialStore: this.credentialStore,
        clientId,
        accountId,
        key,
        generation,
        isAccountGone: (cacheKey, currentGeneration) => this.isAccountGone(cacheKey, currentGeneration),
        invalidateAccountState: (sourceClientId, sourceAccountId) =>
          this.invalidateAccountState(call, sourceClientId, sourceAccountId),
      });
      if (!account) return;
      const preparedCredential = await resolveUsageFetchCredential({
        call,
        readCredential: this.readCredential,
        clientId,
        accountId,
        key,
        account,
      });
      credential = preparedCredential.credential;
      this.cacheKeyIndex.set(key, { clientId, accountId });
      credential = await executeUsageFetch({
        call,
        source,
        account,
        preparedCredential,
        bus: this.bus,
        accountMetadata: account.metadata,
        clientId,
        accountId,
        key,
        generation,
        metadataStore: this.metadataStore,
        usageCache: this.usageCache,
        usageSnapshotStore: this.usageSnapshotStore,
        persistedWindows: this.persistedWindows,
        persistenceChains: this.persistenceChains,
        errorCooldownUntil: this.errorCooldownUntil,
        errorCooldownMs: ERROR_COOLDOWN_MS,
        transientFailureCounts: this.transientFailureCounts,
        fingerprint: preparedCredential.credential.fingerprint,
        isAccountGone: (cacheKey, currentGeneration) => this.isAccountGone(cacheKey, currentGeneration),
        isCurrentGeneration: (cacheKey, currentGeneration) =>
          (this.accountGenerations.get(cacheKey) ?? 0) === currentGeneration,
        isStopped: () => this.stopped,
        emitStaleSnapshot: (sourceClientId, sourceAccountId, cacheKey, currentGeneration) =>
          this.emitStaleSnapshot(call, sourceClientId, sourceAccountId, cacheKey, currentGeneration),
        onResolveError: createSourceErrorLogger('resolveUsage'),
        onMetadataPatchError: createSourceErrorLogger('applyMetadataPatches'),
        onPersistenceError: createSourceErrorLogger('persistChangedWindows'),
      });
      await this.emitPendingResetsIfFresh(call, clientId, accountId, key, generation);
    } catch (err) {
      await handleUsageFetchError({
        call,
        bus: this.bus,
        clientId,
        accountId,
        key,
        generation,
        credential,
        error: err,
        metadataStore: this.metadataStore,
        usageCache: this.usageCache,
        errorCooldownUntil: this.errorCooldownUntil,
        sourceCooldownUntil: this.sourceCooldownUntil,
        transientFailureCounts: this.transientFailureCounts,
        defaultErrorCooldownMs: ERROR_COOLDOWN_MS,
        isAccountGone: (cacheKey, currentGeneration) => this.isAccountGone(cacheKey, currentGeneration),
        emitStaleSnapshot: (sourceClientId, sourceAccountId, cacheKey, currentGeneration) =>
          this.emitStaleSnapshot(call, sourceClientId, sourceAccountId, cacheKey, currentGeneration),
        onUnexpectedError: createSourceErrorLogger('fetchAndEmit'),
      });
    }
  }
  private async emitPendingResetsIfFresh(
    call: CallContext,
    clientId: string,
    accountId: string,
    key: string,
    generation: number,
  ): Promise<void> {
    if (this.isAccountGone(key, generation)) return;
    const fresh = this.usageCache.get(key);
    if (!fresh || fresh.stale) return;
    await checkAndEmitPendingResets({
      call,
      bus: this.bus,
      clientId,
      accountId,
      key,
      generation,
      freshSnapshot: fresh,
      pendingResets: this.pendingResets,
      isAccountGone: (cacheKey, currentGeneration) => this.isAccountGone(cacheKey, currentGeneration),
    });
  }
  private async emitStaleSnapshot(
    call: CallContext,
    clientId: string,
    accountId: string,
    key: string,
    generation: number,
  ): Promise<void> {
    await emitStaleSnapshotIfCurrent({
      call,
      bus: this.bus,
      clientId,
      accountId,
      key,
      generation,
      usageCache: this.usageCache,
      isAccountGone: (cacheKey, currentGeneration) => this.isAccountGone(cacheKey, currentGeneration),
    });
  }
  private isAccountGone(key: string, generation: number): boolean {
    return this.stopped || (this.accountGenerations.get(key) ?? 0) !== generation;
  }
}
/**
 * Maps the stored accounts of one source to scheduler targets.
 * @param clientId - Source identifier the accounts belong to.
 * @param accounts - Stored accounts of the source.
 * @param lastFetchAt - Last fetch timestamps keyed by usage cache key.
 * @param config - Optional per-source scheduling overrides.
 * @returns One target per account; active accounts get the higher priority.
 */
function buildSchedulableTargets(
  clientId: string,
  accounts: readonly StoredAccount[],
  lastFetchAt: ReadonlyMap<string, number>,
  config: UsageSourceConfig | undefined,
): Array<SchedulableTarget<string>> {
  return accounts.map((account) => ({
    key: account.id,
    lastFetchAt: lastFetchAt.get(createUsageCacheKey(clientId, account.id)) ?? 0,
    targetIntervalMs: resolveTargetInterval(config, account.active),
    priority: account.active ? 2 : 1,
  }));
}
