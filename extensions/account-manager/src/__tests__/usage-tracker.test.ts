import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import { UsageTracker } from '../handlers/usage-tracker.js';
import {
  collectPendingResetsFromCache,
  USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS,
} from '../handlers/usage-tracker-lifecycle.js';
import { MAX_TRANSIENT_FAILURES } from '../handlers/usage-tracker-fetch.js';
import type { UsagePreparedCredential } from '../handlers/usage-tracker-types.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import type { IUsageProvider, UsageResult } from '../interfaces/usage-provider.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { createUsageCacheKey } from '../usage/usage-partitioning.js';
import { USAGE_AUTH_CODE_TRANSIENT } from '../utils/usage-auth-state.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-abc123';

/** Milliseconds past the 30-second error cooldown. */
const PAST_COOLDOWN_MS = 31_000;

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal {@link AccountUsage} snapshot.
 * @returns A valid AccountUsage
 */
function makeUsage(): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows: [],
  };
}

/**
 * Creates an {@link IUsageProvider} whose `resolveUsage` delegates to the
 * supplied resolver and captures every credential it was called with.
 * @param resolver - Function that returns the usage result to report
 * @returns Provider and credential-capture array
 */
function makeSpyProvider(resolver: () => Promise<UsageResult | null>): {
  provider: IUsageProvider;
  receivedCredentials: RawCredential[];
} {
  const receivedCredentials: RawCredential[] = [];
  const provider: IUsageProvider = {
    resolveUsage: async (credential) => {
      receivedCredentials.push(credential);
      return resolver();
    },
  };
  return { provider, receivedCredentials };
}

/**
 * Builds and starts a {@link UsageTracker} with optional `readCredential`.
 *
 * Passes `pollIntervalMs: 0` to disable bootstrap and periodic scheduling so
 * tests drive fetches explicitly through bus events.
 * @param bus - Bus instance to attach the tracker to
 * @param store - Account store to read accounts from
 * @param provider - Usage provider to use for CLIENT_ID
 * @param readCredential - Optional prepared-credential reader
 * @returns A started UsageTracker
 */
function buildTracker(
  bus: IMakaioBus,
  store: InMemoryAccountStore,
  provider: IUsageProvider,
  readCredential?: (clientId: string, accountId: string) => Promise<UsagePreparedCredential | null>,
): UsageTracker {
  const sources = new Map<string, IUsageProvider>([[CLIENT_ID, provider]]);
  const tracker = new UsageTracker({
    bus,
    sources,
    credentialStore: store.credentialStore,
    metadataStore: store.metadataStore,
    usageSnapshotStore: store.usageSnapshotStore,
    pollIntervalMs: 0,
    readCredential,
  });
  tracker.start();
  return tracker;
}

/**
 * Seeds the store with a minimal account so `store.get` returns a result for
 * CLIENT_ID / ACCOUNT_ID, enabling fetch paths to proceed past the existence
 * check.
 * @param store - Store to seed
 * @param credentialOverride - Optional credential to seed instead of the default
 */
async function seedAccount(store: InMemoryAccountStore, credentialOverride?: RawCredential): Promise<void> {
  await store.upsert(CLIENT_ID, {
    id: ACCOUNT_ID,
    metadata: {},
    active: true,
    fingerprint: credentialOverride?.fingerprint ?? ACCOUNT_ID,
    detectedAt: 1000,
    lastSeenAt: 1000,
    credential: credentialOverride ?? {
      token: 'stored-token',
      fingerprint: ACCOUNT_ID,
      metadata: {},
    },
  });
}

/**
 * Emits a `credentials.switched` event for the test account, which triggers a
 * `forceRefresh: true` fetch in the tracker — bypassing the throttle so tests
 * are not affected by `USAGE_THROTTLE_MS`.
 * @param bus - Bus instance to emit on
 */
async function emitSwitched(bus: IMakaioBus): Promise<void> {
  await bus.emit(AccountManagerSubjects.credentials.switched, {
    clientId: CLIENT_ID,
    from: null,
    to: {
      id: ACCOUNT_ID,
      metadata: {},
      active: true,
      detectedAt: 1000,
      lastSeenAt: 1000,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests: error cooldown and readCredential
// ---------------------------------------------------------------------------

describe('UsageTracker error cooldown and readCredential', () => {
  let bus: IMakaioBus;
  let store: InMemoryAccountStore;
  let tracker: UsageTracker | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createBusInstance();
    store = new InMemoryAccountStore();
  });

  afterEach(async () => {
    await tracker?.stop();
    vi.useRealTimers();
  });

  it('failed fetch → cooldown suppresses a subsequent forceRefresh: true call', async () => {
    await seedAccount(store);
    let resolveCount = 0;
    const { provider } = makeSpyProvider(async () => {
      resolveCount++;
      return null;
    });

    tracker = buildTracker(bus, store, provider);

    // First forceRefresh (credentials.switched) — resolveUsage is called,
    // returns null, error cooldown is set.
    await emitSwitched(bus);
    expect(resolveCount).toBe(1);

    // Second forceRefresh immediately — still inside the 30-second window.
    // The cooldown check fires before the store lookup so resolveUsage is
    // never called a second time.
    await emitSwitched(bus);
    expect(resolveCount).toBe(1);
  });

  it('successful fetch → clears cooldown so the next forceRefresh: true goes through', async () => {
    await seedAccount(store);
    let callCount = 0;
    const { provider } = makeSpyProvider(async () => {
      callCount++;
      // First call fails to trigger the cooldown; subsequent calls succeed.
      return callCount === 1 ? null : { usage: makeUsage() };
    });

    tracker = buildTracker(bus, store, provider);

    // First forceRefresh — fails, cooldown is set.
    await emitSwitched(bus);
    expect(callCount).toBe(1);

    // Advance past the 30-second cooldown.
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);

    // Second forceRefresh — succeeds, cooldown is cleared.
    await emitSwitched(bus);
    expect(callCount).toBe(2);

    // Third forceRefresh immediately — cooldown was cleared on success, so
    // this must go through even though no time has passed.
    await emitSwitched(bus);
    expect(callCount).toBe(3);
  });

  it('readCredential returns fresh credential → resolveUsage receives it instead of stored credential', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: ACCOUNT_ID,
      metadata: {},
    };
    const freshCredential: RawCredential = {
      token: 'fresh-token',
      fingerprint: 'fresh-fingerprint',
      metadata: {},
    };

    await seedAccount(store, storedCredential);

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(async (_clientId: string, _accountId: string) => ({
      status: 'ready' as const,
      credential: freshCredential,
      changed: true,
    }));

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(readCredential).toHaveBeenCalledWith(CLIENT_ID, ACCOUNT_ID);
    expect(receivedCredentials).toHaveLength(1);
    expect(receivedCredentials[0]).toBe(freshCredential);
  });

  it('readCredential returns null → resolveUsage falls back to stored credential', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: ACCOUNT_ID,
      metadata: {},
    };

    await seedAccount(store, storedCredential);

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(
      async (_clientId: string, _accountId: string): Promise<UsagePreparedCredential | null> => null,
    );

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(readCredential).toHaveBeenCalledWith(CLIENT_ID, ACCOUNT_ID);
    expect(receivedCredentials).toHaveLength(1);
    expect(receivedCredentials[0].token).toBe('stored-token');
  });

  it('readCredential throws → resolveUsage still falls back to stored credential', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: ACCOUNT_ID,
      metadata: {},
    };

    await seedAccount(store, storedCredential);

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(async () => {
      throw new Error('keychain locked');
    });

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(readCredential).toHaveBeenCalledWith(CLIENT_ID, ACCOUNT_ID);
    expect(receivedCredentials).toHaveLength(1);
    expect(receivedCredentials[0]).toEqual(storedCredential);
  });

  it('persists auth-invalid usage state by fingerprint, suppresses repeats, and clears on successful fetch after credential change', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: 'fp-stored',
      metadata: {},
    };
    let currentCredential: RawCredential | null = null;
    let callCount = 0;
    const { provider, receivedCredentials } = makeSpyProvider(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new UsageAuthInvalidError('Claude usage fetch failed with HTTP 401 Unauthorized');
      }
      return { usage: makeUsage() };
    });
    const readCredential = vi.fn(async () =>
      currentCredential ? { status: 'ready' as const, credential: currentCredential, changed: true } : null,
    );

    await seedAccount(store, storedCredential);
    tracker = buildTracker(bus, store, provider, readCredential);

    await emitSwitched(bus);
    expect(callCount).toBe(1);

    const afterFailure = await store.get(CLIENT_ID, ACCOUNT_ID);
    expect(afterFailure?.metadata).toMatchObject({
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp-stored',
    });

    await emitSwitched(bus);
    expect(callCount).toBe(1);

    currentCredential = {
      token: 'fresh-token',
      fingerprint: 'fp-fresh',
      metadata: {},
    };

    await emitSwitched(bus);
    expect(callCount).toBe(2);
    expect(receivedCredentials[1]).toBe(currentCredential);

    const afterSuccess = await store.get(CLIENT_ID, ACCOUNT_ID);
    expect(afterSuccess?.metadata.usageAuthState).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthFingerprint).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthMessage).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthDetectedAt).toBeUndefined();
  });

  it('marks auth-invalid without calling resolveUsage when credential preparation reports a durable failure', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: 'fp-stored',
      metadata: {},
    };

    await seedAccount(store, storedCredential);

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(async () => ({
      status: 'invalid' as const,
      credential: storedCredential,
      reason: 'Claude OAuth refresh failed with HTTP 401 Unauthorized',
    }));

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(readCredential).toHaveBeenCalledWith(CLIENT_ID, ACCOUNT_ID);
    expect(receivedCredentials).toHaveLength(0);

    const afterFailure = await store.get(CLIENT_ID, ACCOUNT_ID);
    expect(afterFailure?.metadata).toMatchObject({
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp-stored',
    });
  });

  it('bypasses auth-invalid suppression when a prepared credential changed under the same fingerprint', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: 'fp-stable',
      metadata: {},
    };
    const refreshedCredential: RawCredential = {
      token: 'refreshed-token',
      fingerprint: 'fp-stable',
      metadata: {},
    };

    await seedAccount(store, storedCredential);
    await store.metadataStore.patchMetadata(CLIENT_ID, ACCOUNT_ID, 0, {
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp-stable',
      usageAuthMessage: 'expired access token',
      usageAuthDetectedAt: Date.now(),
    });

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(async () => ({
      status: 'ready' as const,
      credential: refreshedCredential,
      changed: true,
    }));

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(receivedCredentials).toHaveLength(1);
    expect(receivedCredentials[0]).toBe(refreshedCredential);

    const afterSuccess = await store.get(CLIENT_ID, ACCOUNT_ID);
    expect(afterSuccess?.metadata.usageAuthState).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthFingerprint).toBeUndefined();
  });

  it('retries usage fetch when reauth marker originated from transient failures even if credential unchanged', async () => {
    const storedCredential: RawCredential = {
      token: 'stored-token',
      fingerprint: 'fp-stored',
      metadata: {},
    };

    await seedAccount(store, storedCredential);
    await store.metadataStore.patchMetadata(CLIENT_ID, ACCOUNT_ID, 0, {
      usageAuthState: 'reauth-required',
      usageAuthFingerprint: 'fp-stored',
      usageAuthMessage: '3 consecutive transient usage-fetch failures',
      usageAuthCode: USAGE_AUTH_CODE_TRANSIENT,
      usageAuthDetectedAt: Date.now(),
    });

    const { provider, receivedCredentials } = makeSpyProvider(async () => ({ usage: makeUsage() }));
    const readCredential = vi.fn(async () => ({
      status: 'ready' as const,
      credential: storedCredential,
      changed: false,
    }));

    tracker = buildTracker(bus, store, provider, readCredential);
    await emitSwitched(bus);

    expect(receivedCredentials).toHaveLength(1);

    const afterSuccess = await store.get(CLIENT_ID, ACCOUNT_ID);
    expect(afterSuccess?.metadata.usageAuthState).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthFingerprint).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthMessage).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthCode).toBeUndefined();
    expect(afterSuccess?.metadata.usageAuthDetectedAt).toBeUndefined();
  });

  it('clearAccountState clears cooldown — next forceRefresh: true goes through', async () => {
    await seedAccount(store);
    let resolveCount = 0;
    const { provider } = makeSpyProvider(async () => {
      resolveCount++;
      return null;
    });

    tracker = buildTracker(bus, store, provider);

    // First fetch — fails, cooldown is set.
    await emitSwitched(bus);
    expect(resolveCount).toBe(1);

    // Verify cooldown is active by confirming a second immediate call is blocked.
    await emitSwitched(bus);
    expect(resolveCount).toBe(1);

    // Clear account state — removes the cooldown for this account.
    tracker.clearAccountState(CLIENT_ID, ACCOUNT_ID);

    // Re-seed so the store lookup succeeds again after the generation bump.
    await seedAccount(store);

    // Now forceRefresh: true must go through — cooldown was cleared.
    await emitSwitched(bus);
    expect(resolveCount).toBe(2);
  });

  it('stop waits for an in-flight fetch to quiesce before resolving', async () => {
    await seedAccount(store);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveFetch!: (value: UsageResult | null) => void;
    const releaseFetch = new Promise<UsageResult | null>((resolve) => {
      resolveFetch = resolve;
    });
    const { provider } = makeSpyProvider(async () => {
      resolveStarted();
      return releaseFetch;
    });

    tracker = buildTracker(bus, store, provider);

    const fetchPromise = emitSwitched(bus);
    await started;

    let stopped = false;
    const stopPromise = tracker.stop().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    resolveFetch({ usage: makeUsage() });
    await stopPromise;
    await fetchPromise;

    expect(stopped).toBe(true);
  });

  it('clears source cooldown state after a stopped in-flight fetch is rate-limited', async () => {
    await seedAccount(store);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let rejectFetch!: (error: unknown) => void;
    const releaseFetch = new Promise<UsageResult | null>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const { provider } = makeSpyProvider(async () => {
      resolveStarted();
      return releaseFetch;
    });

    tracker = buildTracker(bus, store, provider);

    const fetchPromise = emitSwitched(bus);
    await started;

    const stopPromise = tracker.stop();
    rejectFetch(new RateLimitedError(30_000));
    await stopPromise;
    await fetchPromise;

    // This teardown invariant is internal-only: `sourceCooldownUntil` has no
    // public behavior after stop, so the regression check must inspect the map.
    const sourceCooldownUntil = Reflect.get(tracker as object, 'sourceCooldownUntil') as Map<string, number>;
    expect(sourceCooldownUntil.size).toBe(0);
  });

  it('keeps transient state intact during requestStop() until stop() completes', async () => {
    await seedAccount(store);
    const { provider } = makeSpyProvider(async () => ({ usage: makeUsage() }));

    tracker = buildTracker(bus, store, provider);

    const usageCache = Reflect.get(tracker as object, 'usageCache') as Map<string, AccountUsage>;
    usageCache.set(createUsageCacheKey(CLIENT_ID, ACCOUNT_ID), makeUsage());

    tracker.requestStop();
    expect(usageCache.size).toBe(1);

    await tracker.stop();
    expect(usageCache.size).toBe(0);
  });

  it('bounds stop() quiescence waits when a fetch never settles', async () => {
    await seedAccount(store);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { provider } = makeSpyProvider(async () => {
      resolveStarted();
      return new Promise<UsageResult | null>(() => undefined);
    });

    tracker = buildTracker(bus, store, provider);

    void emitSwitched(bus);
    await started;

    let stopped = false;
    const stopPromise = tracker.stop().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS - 1);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;
    expect(stopped).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `[UsageTracker] stop timed out waiting for tracker quiescence after ${USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS}ms:`,
      expect.any(Error),
    );

    tracker = undefined;
    consoleErrorSpy.mockRestore();
  });

  it('bounds clearAccountStateAndWait() when a fetch never settles', async () => {
    await seedAccount(store);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { provider } = makeSpyProvider(async () => {
      resolveStarted();
      return new Promise<UsageResult | null>(() => undefined);
    });

    tracker = buildTracker(bus, store, provider);

    void emitSwitched(bus);
    await started;

    let cleared = false;
    const clearPromise = tracker.clearAccountStateAndWait(CLIENT_ID, ACCOUNT_ID).then(() => {
      cleared = true;
    });

    await vi.advanceTimersByTimeAsync(USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS - 1);
    expect(cleared).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await clearPromise;
    expect(cleared).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `[UsageTracker] clearAccountStateAndWait timed out for ${CLIENT_ID}/${ACCOUNT_ID} after ${USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS}ms:`,
      expect.any(Error),
    );

    const stopPromise = tracker.stop();
    await vi.advanceTimersByTimeAsync(USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS);
    await stopPromise;
    tracker = undefined;
    consoleErrorSpy.mockRestore();
  });

  it('logs the original provider error object when resolveUsage throws', async () => {
    await seedAccount(store);
    const failure = new Error('provider exploded');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { provider } = makeSpyProvider(async () => {
      throw failure;
    });

    tracker = buildTracker(bus, store, provider);

    try {
      await emitSwitched(bus);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[UsageTracker] resolveUsage failed for source ${CLIENT_ID}:`,
        failure,
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: transient failure escalation
// ---------------------------------------------------------------------------

describe('UsageTracker transient failure escalation', () => {
  let bus: IMakaioBus;
  let store: InMemoryAccountStore;
  let tracker: UsageTracker | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createBusInstance();
    store = new InMemoryAccountStore();
  });

  afterEach(async () => {
    tracker?.requestStop();
    await tracker?.stop();
    vi.useRealTimers();
  });

  it(`escalates to reauth-required after ${MAX_TRANSIENT_FAILURES} consecutive transient failures`, async () => {
    await seedAccount(store);
    let resolveCount = 0;
    const { provider } = makeSpyProvider(async () => {
      resolveCount++;
      return null;
    });

    tracker = buildTracker(bus, store, provider);

    for (let i = 0; i < MAX_TRANSIENT_FAILURES; i++) {
      await emitSwitched(bus);
      if (i < MAX_TRANSIENT_FAILURES - 1) {
        await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);
      }
    }

    expect(resolveCount).toBe(MAX_TRANSIENT_FAILURES);

    const account = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
    expect(account?.metadata).toMatchObject({
      usageAuthState: 'reauth-required',
      usageAuthCode: USAGE_AUTH_CODE_TRANSIENT,
    });
  });

  it('resets transient counter on successful fetch', async () => {
    await seedAccount(store);
    let callIndex = 0;
    const { provider } = makeSpyProvider(async () => {
      callIndex++;
      // Fail twice, succeed once, then fail twice more
      if (callIndex <= 2 || callIndex >= 4) return null;
      return { usage: makeUsage() };
    });

    tracker = buildTracker(bus, store, provider);

    // Two transient failures
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);

    // One success — resets the counter
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);

    // Two more transient failures — should NOT escalate (counter was reset)
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);
    await emitSwitched(bus);

    expect(callIndex).toBe(5);
    const account = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
    expect(account?.metadata.usageAuthState).toBeUndefined();
  });

  it('resets transient counter when clearAccountState is called', async () => {
    await seedAccount(store);
    let resolveCount = 0;
    const { provider } = makeSpyProvider(async () => {
      resolveCount++;
      return null;
    });

    tracker = buildTracker(bus, store, provider);

    // Two transient failures
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);

    // External invalidation resets the counter
    tracker.clearAccountState(CLIENT_ID, ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);

    // Two more transient failures — should NOT escalate (counter was reset)
    await emitSwitched(bus);
    await vi.advanceTimersByTimeAsync(PAST_COOLDOWN_MS);
    await emitSwitched(bus);

    expect(resolveCount).toBe(4);
    const account = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
    expect(account?.metadata.usageAuthState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: window reset detection
// ---------------------------------------------------------------------------

/**
 * Builds an AccountUsage snapshot whose single window has an expired resetsAt
 * — i.e. `resetsAt < Date.now()`.
 * @param expiredAt - Epoch ms for the expired resetsAt value
 * @returns AccountUsage with one expired window
 */
function makeUsageWithExpiredWindow(expiredAt: number): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows: [
      {
        id: '5h',
        label: '5 Hour',
        utilization: 100,
        resetsAt: expiredAt,
        windowSeconds: 18_000,
      },
    ],
  };
}

/**
 * Builds an AccountUsage snapshot with a future resetsAt for the same window.
 * @param futureResetsAt - Epoch ms for the future resetsAt value
 * @returns AccountUsage with one active (non-expired) window
 */
function makeUsageWithFutureWindow(futureResetsAt: number): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows: [
      {
        id: '5h',
        label: '5 Hour',
        utilization: 0,
        resetsAt: futureResetsAt,
        windowSeconds: 18_000,
      },
    ],
  };
}

describe('UsageTracker window reset detection', () => {
  let bus: IMakaioBus;
  let store: InMemoryAccountStore;
  let tracker: UsageTracker | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    bus = createBusInstance();
    store = new InMemoryAccountStore();
  });

  afterEach(async () => {
    await tracker?.stop();
    vi.useRealTimers();
  });

  it('emits usage.windowResetAvailable when a window resetsAt is in the past', async () => {
    await seedAccount(store);
    const expiredAt = Date.now() - 5_000;
    const { provider } = makeSpyProvider(async () => ({
      usage: makeUsageWithExpiredWindow(expiredAt),
    }));

    tracker = buildTracker(bus, store, provider);

    const events: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      await emitSwitched(bus);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        windowId: '5h',
        expiredAt,
      });
    } finally {
      cleanup();
    }
  });

  it('does not re-emit usage.windowResetAvailable for the same expired window on a second poll', async () => {
    await seedAccount(store);
    const expiredAt = Date.now() - 5_000;
    const { provider } = makeSpyProvider(async () => ({
      usage: makeUsageWithExpiredWindow(expiredAt),
    }));

    tracker = buildTracker(bus, store, provider);

    const events: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      // First poll — event should fire.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);

      // Second poll with same expiredAt — must be deduped.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('emits usage.windowResetAvailable again when the same window has a new expiredAt', async () => {
    await seedAccount(store);
    const firstExpiredAt = Date.now() - 5_000;
    const secondExpiredAt = Date.now() - 1_000;
    let callCount = 0;
    const { provider } = makeSpyProvider(async () => {
      callCount++;
      return {
        usage: makeUsageWithExpiredWindow(callCount === 1 ? firstExpiredAt : secondExpiredAt),
      };
    });

    tracker = buildTracker(bus, store, provider);

    const events: Array<{ expiredAt: number }> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push({ expiredAt: ctx.payload.expiredAt });
    });

    try {
      await emitSwitched(bus);
      await vi.waitFor(() => {
        const inFlightFetches = Reflect.get(tracker as object, 'inFlightFetches') as Map<string, Promise<void>>;
        expect(inFlightFetches.size).toBe(0);
      });
      await emitSwitched(bus);

      expect(events).toEqual([{ expiredAt: firstExpiredAt }, { expiredAt: secondExpiredAt }]);
    } finally {
      cleanup();
    }
  });

  it('clears pending entry on a new future resetsAt and re-emits on the next expiry', async () => {
    await seedAccount(store);
    const startTime = Date.now();
    const firstExpiredAt = startTime - 5_000;
    const futureResetsAt = startTime + 3_600_000;

    let callCount = 0;
    const { provider } = makeSpyProvider(async () => {
      callCount++;
      if (callCount === 1) return { usage: makeUsageWithExpiredWindow(firstExpiredAt) };
      if (callCount === 2) return { usage: makeUsageWithFutureWindow(futureResetsAt) };
      // Third call: the same window but now expired (resetsAt is in the past
      // because fake time has advanced past futureResetsAt).
      return { usage: makeUsageWithExpiredWindow(futureResetsAt) };
    });

    tracker = buildTracker(bus, store, provider);

    const events: Array<{ windowId: string; expiredAt: number }> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push({ windowId: ctx.payload.windowId, expiredAt: ctx.payload.expiredAt });
    });

    try {
      // Poll 1: expired window → event fires for firstExpiredAt.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);
      expect(events[0].expiredAt).toBe(firstExpiredAt);

      // Poll 2: future window → pending entry cleared, no new event.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);

      // Advance past the future resetsAt so the third poll sees an expired window.
      await vi.advanceTimersByTimeAsync(futureResetsAt - startTime + 1_000);

      // Poll 3: same window now expired again → fresh event fires.
      await emitSwitched(bus);
      expect(events).toHaveLength(2);
      expect(events[1].expiredAt).toBe(futureResetsAt);
    } finally {
      cleanup();
    }
  });

  it('clears pending entry when a previously expired window disappears', async () => {
    await seedAccount(store);
    const expiredAt = Date.now() - 5_000;
    let callCount = 0;
    const { provider } = makeSpyProvider(async () => {
      callCount++;
      if (callCount === 2) return { usage: makeUsage() };
      return { usage: makeUsageWithExpiredWindow(expiredAt) };
    });

    tracker = buildTracker(bus, store, provider);

    const events: Array<{ windowId: string; expiredAt: number }> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push({ windowId: ctx.payload.windowId, expiredAt: ctx.payload.expiredAt });
    });

    try {
      await emitSwitched(bus);
      expect(events).toHaveLength(1);

      await emitSwitched(bus);
      expect(events).toHaveLength(1);

      await emitSwitched(bus);
      expect(events).toEqual([
        { windowId: '5h', expiredAt },
        { windowId: '5h', expiredAt },
      ]);
    } finally {
      cleanup();
    }
  });

  it('usage.getPendingResets returns expired windows from the cache and excludes active ones', async () => {
    const ACCOUNT_B = 'acc-bbb';
    await seedAccount(store);
    // Seed a second account with an active (non-expired) window.
    await store.upsert(CLIENT_ID, {
      id: ACCOUNT_B,
      metadata: {},
      active: false,
      fingerprint: ACCOUNT_B,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential: { token: 'token-b', fingerprint: ACCOUNT_B, metadata: {} },
    });

    const expiredAt = Date.now() - 5_000;
    const futureResetsAt = Date.now() + 3_600_000;

    // Provider returns expired window for ACCOUNT_ID.
    const provider: IUsageProvider = {
      resolveUsage: async () => ({ usage: makeUsageWithExpiredWindow(expiredAt) }),
    };
    tracker = buildTracker(bus, store, provider);

    // Manually put a future-window snapshot for ACCOUNT_B into the cache
    // via a direct cache injection to avoid needing a second provider.
    const usageCache = Reflect.get(tracker as object, 'usageCache') as Map<string, AccountUsage>;
    const cacheKeyIndex = Reflect.get(tracker as object, 'cacheKeyIndex') as Map<
      string,
      { clientId: string; accountId: string }
    >;
    usageCache.set(createUsageCacheKey(CLIENT_ID, ACCOUNT_B), makeUsageWithFutureWindow(futureResetsAt));
    cacheKeyIndex.set(createUsageCacheKey(CLIENT_ID, ACCOUNT_B), { clientId: CLIENT_ID, accountId: ACCOUNT_B });

    // Trigger a fetch for ACCOUNT_ID to populate the expired-window cache entry.
    await emitSwitched(bus);

    const result = await bus.request(AccountManagerSubjects.usage.getPendingResets, {});
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      windowId: '5h',
      expiredAt,
    });
  });

  it('usage.getPendingResets filters by clientId and accountId', async () => {
    const ACCOUNT_B = 'acc-bbb';
    await seedAccount(store);
    await store.upsert(CLIENT_ID, {
      id: ACCOUNT_B,
      metadata: {},
      active: false,
      fingerprint: ACCOUNT_B,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential: { token: 'token-b', fingerprint: ACCOUNT_B, metadata: {} },
    });

    const expiredAtA = Date.now() - 5_000;
    const expiredAtB = Date.now() - 3_000;
    const { provider } = makeSpyProvider(async () => ({
      usage: makeUsageWithExpiredWindow(expiredAtA),
    }));

    tracker = buildTracker(bus, store, provider);

    // Inject expired window for ACCOUNT_B directly into cache.
    const usageCache = Reflect.get(tracker as object, 'usageCache') as Map<string, AccountUsage>;
    const cacheKeyIndex = Reflect.get(tracker as object, 'cacheKeyIndex') as Map<
      string,
      { clientId: string; accountId: string }
    >;
    usageCache.set(createUsageCacheKey(CLIENT_ID, ACCOUNT_B), makeUsageWithExpiredWindow(expiredAtB));
    cacheKeyIndex.set(createUsageCacheKey(CLIENT_ID, ACCOUNT_B), { clientId: CLIENT_ID, accountId: ACCOUNT_B });

    // Trigger fetch for ACCOUNT_ID.
    await emitSwitched(bus);

    // Filter by accountId — should return only ACCOUNT_ID's window.
    const filtered = await bus.request(AccountManagerSubjects.usage.getPendingResets, {
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
    });
    expect(filtered.pending).toHaveLength(1);
    expect(filtered.pending[0].accountId).toBe(ACCOUNT_ID);

    // Filter by clientId only — both expired windows should appear.
    const byClient = await bus.request(AccountManagerSubjects.usage.getPendingResets, {
      clientId: CLIENT_ID,
    });
    expect(byClient.pending).toHaveLength(2);
  });

  it('collectPendingResetsFromCache rejects accountId without clientId', () => {
    expect(() =>
      collectPendingResetsFromCache(
        new Map([[createUsageCacheKey(CLIENT_ID, ACCOUNT_ID), makeUsageWithExpiredWindow(Date.now() - 5_000)]]),
        new Map([[createUsageCacheKey(CLIENT_ID, ACCOUNT_ID), { clientId: CLIENT_ID, accountId: ACCOUNT_ID }]]),
        undefined,
        ACCOUNT_ID,
      ),
    ).toThrow('accountId requires clientId');
  });

  it('clearAccountState removes the account from public pending reset results', async () => {
    await seedAccount(store);
    const expiredAt = Date.now() - 5_000;
    const { provider } = makeSpyProvider(async () => ({
      usage: makeUsageWithExpiredWindow(expiredAt),
    }));

    tracker = buildTracker(bus, store, provider);

    // Trigger fetch — populates pendingResets.
    await emitSwitched(bus);

    await expect(bus.request(AccountManagerSubjects.usage.getPendingResets, {})).resolves.toMatchObject({
      pending: [
        {
          clientId: CLIENT_ID,
          accountId: ACCOUNT_ID,
          windowId: '5h',
          expiredAt,
        },
      ],
    });

    tracker.clearAccountState(CLIENT_ID, ACCOUNT_ID);

    // Re-seed so the store lookup succeeds after the generation bump.
    await seedAccount(store);

    await expect(bus.request(AccountManagerSubjects.usage.getPendingResets, {})).resolves.toEqual({ pending: [] });
  });

  it('does not emit usage.windowResetAvailable when the fetch result is null (stale snapshot path)', async () => {
    // When resolveUsage returns null, the tracker applies a stale snapshot and
    // then calls emitPendingResetsIfFresh. The guard `if (!fresh || fresh.stale)`
    // ensures checkAndEmitPendingResets is never reached.
    await seedAccount(store);
    // Seed a previous fresh snapshot with an expired window so the stale path
    // has something to work with.
    const expiredAt = Date.now() - 5_000;

    // First call succeeds with an expired window (cache is populated, fresh).
    // Second call returns null (triggers the stale path).
    let callCount = 0;
    const { provider } = makeSpyProvider(async () => {
      callCount++;
      if (callCount === 1) return { usage: makeUsageWithExpiredWindow(expiredAt) };
      return null;
    });

    tracker = buildTracker(bus, store, provider);

    const events: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      // First fetch: fresh snapshot with expired window → event fires.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);

      // Second fetch: null result → stale snapshot path → no new reset event.
      await emitSwitched(bus);
      expect(events).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
