import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage, UsageWindow } from '../bus/schemas.js';
import { UsageTracker } from '../handlers/usage-tracker.js';
import type { IUsageEntryAppender } from '../usage/usage-persistence.js';
import type { UsageEntry } from '../bus/usage-entry.js';
import type { IUsageProvider, UsageResult } from '../interfaces/usage-provider.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-abc123';
/** Milliseconds past the 60-second throttle. */
const PAST_THROTTLE_MS = 61_000;

/**
 * Creates a deferred promise for tests that need to pause an async step.
 * @returns Deferred promise controls
 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Spy writer
// ---------------------------------------------------------------------------

/**
 * In-memory appender spy that records every `append` call.
 */
class SpyUsageWriter implements IUsageEntryAppender {
  readonly entries: UsageEntry[] = [];

  async append(entry: UsageEntry): Promise<boolean> {
    this.entries.push(entry);
    return true;
  }

  /** Reset recorded entries between phases of a test. */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Appender whose `append` always rejects — used to verify that
 * writer failures do not interrupt the fetch-emit cycle.
 */
class ThrowingUsageWriter implements IUsageEntryAppender {
  /** Number of append calls received (regardless of outcome). */
  attempts = 0;

  async append(_entry: UsageEntry): Promise<boolean> {
    this.attempts++;
    throw new Error('simulated writer failure');
  }
}

/**
 * Appender that fails the first append and succeeds afterwards.
 *
 * Used to verify that the persistence baseline is only advanced after a
 * successful writer cycle.
 */
class FlakyUsageWriter implements IUsageEntryAppender {
  readonly entries: UsageEntry[] = [];
  attempts = 0;

  async append(entry: UsageEntry): Promise<boolean> {
    this.attempts++;
    if (this.attempts === 1) {
      return false;
    }
    this.entries.push(entry);
    return true;
  }
}

/**
 * Appender that throws once for a specific window ID and then
 * succeeds on subsequent retries.
 *
 * Used to verify that successful windows still advance the persistence
 * baseline when a later window throws during the same pass.
 */
class ThrowsOncePerWindowWriter implements IUsageEntryAppender {
  readonly entries: UsageEntry[] = [];
  readonly attempts: string[] = [];
  private readonly thrownWindowIds = new Set<string>();

  constructor(private readonly windowIdToThrow: string) {}

  async append(entry: UsageEntry): Promise<boolean> {
    this.attempts.push(entry.windowId);
    if (entry.windowId === this.windowIdToThrow && !this.thrownWindowIds.has(entry.windowId)) {
      this.thrownWindowIds.add(entry.windowId);
      throw new Error(`simulated writer failure for ${entry.windowId}`);
    }
    this.entries.push(entry);
    return true;
  }
}

/**
 * Appender that holds the first append open until released.
 *
 * Used to prove that `usage.updated` is emitted before persistence finishes.
 */
class PendingUsageWriter implements IUsageEntryAppender {
  readonly entries: UsageEntry[] = [];
  readonly started = createDeferred<void>();
  private readonly gate = createDeferred<void>();
  private appendCount = 0;

  async append(entry: UsageEntry): Promise<boolean> {
    this.appendCount++;
    this.entries.push(entry);
    if (this.appendCount === 1) {
      this.started.resolve();
      await this.gate.promise;
    }
    return true;
  }

  release(): void {
    this.gate.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal {@link UsageWindow} fixture.
 * @param overrides - Properties to override on the default fixture
 * @returns A valid UsageWindow
 */
function makeWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: '5h',
    label: '5 Hour',
    utilization: 50,
    resetsAt: Date.now() + 18_000_000,
    windowSeconds: 18_000,
    ...overrides,
  };
}

/**
 * Creates an {@link AccountUsage} snapshot from a list of windows.
 * @param windows - Rate-limit windows to include in the snapshot
 * @param overrides - Properties to override on the default fixture
 * @returns A valid AccountUsage snapshot
 */
function makeUsage(windows: UsageWindow[], overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows,
    ...overrides,
  };
}

/**
 * Creates a minimal `IUsageProvider` stub whose `resolveUsage` delegates to
 * the supplied resolver function.
 * @param resolver - Function that returns the usage to report
 * @returns An IUsageProvider implementation
 */
function makeProvider(resolver: () => Promise<AccountUsage | null>): IUsageProvider {
  return {
    resolveUsage: async (_credential) => {
      const usage = await resolver();
      return usage ? { usage } : null;
    },
  };
}

/**
 * Creates a minimal `IUsageProvider` stub whose `resolveUsage` returns a full
 * {@link UsageResult} (including optional `metadataPatches`) from the callback.
 * Use this when the test needs to control `metadataPatches` directly.
 * @param resolver - Function that returns the full UsageResult to report
 * @returns An IUsageProvider implementation
 */
function makeProviderWithResult(resolver: () => Promise<UsageResult | null>): IUsageProvider {
  return {
    resolveUsage: async (_credential) => resolver(),
  };
}

/**
 * Builds and starts a {@link UsageTracker} with the given appender (optional).
 * @param bus - Bus instance to attach the tracker to
 * @param store - Account store to read accounts from
 * @param provider - Usage provider to use for CLIENT_ID
 * @param writer - Optional appender for delta persistence
 * @returns A started UsageTracker
 */
function buildTracker(
  bus: IMakaioBus,
  store: InMemoryAccountStore,
  provider: IUsageProvider,
  writer?: IUsageEntryAppender,
): UsageTracker {
  const sources = new Map<string, IUsageProvider>([[CLIENT_ID, provider]]);
  // pollIntervalMs: 0 disables the default bootstrap + periodic cadence here
  // because these tests do not pass per-source tick overrides.
  const usageSnapshotStore =
    writer === undefined
      ? store.usageSnapshotStore
      : {
          append: (_clientId: string, _accountId: string, entry: UsageEntry) => writer.append(entry),
          read: async function* () {},
          hasAnySnapshots: async () => false,
        };
  const tracker = new UsageTracker({
    bus,
    sources,
    credentialStore: store.credentialStore,
    metadataStore: store.metadataStore,
    usageSnapshotStore,
    pollIntervalMs: 0,
  });
  tracker.start();
  return tracker;
}

/**
 * Seeds the store with a minimal {@link StoredAccount} so `store.get` returns
 * a result for CLIENT_ID / ACCOUNT_ID, enabling `fetchAndEmit` to proceed.
 * @param store - Store to seed
 */
async function seedAccount(store: InMemoryAccountStore): Promise<void> {
  await store.upsert(CLIENT_ID, {
    id: ACCOUNT_ID,
    metadata: {},
    active: true,
    fingerprint: ACCOUNT_ID,
    detectedAt: 1000,
    lastSeenAt: 1000,
    credential: {
      token: 'test-token',
      fingerprint: ACCOUNT_ID,
      metadata: {},
    },
  });
}

/**
 * Emits a `credentials.detected` event for the default test client/account.
 * @param bus - Bus instance to emit on
 */
async function emitDetected(bus: IMakaioBus): Promise<void> {
  await bus.emit(AccountManagerSubjects.credentials.detected, {
    clientId: CLIENT_ID,
    account: {
      id: ACCOUNT_ID,
      metadata: {},
      active: true,
      detectedAt: 1000,
      lastSeenAt: 1000,
    },
  });
}

/**
 * Emits a `credentials.refreshed` event for the default test client/account.
 * @param bus - Bus instance to emit on
 */
async function emitRefreshed(bus: IMakaioBus): Promise<void> {
  await bus.emit(AccountManagerSubjects.credentials.refreshed, {
    clientId: CLIENT_ID,
    account: {
      id: ACCOUNT_ID,
      metadata: {},
      active: true,
      detectedAt: 1000,
      lastSeenAt: 1000,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsageTracker persistence / delta-filter integration', () => {
  let bus: IMakaioBus;
  let store: InMemoryAccountStore;
  let writer: SpyUsageWriter;
  let tracker: UsageTracker | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createBusInstance();
    store = new InMemoryAccountStore();
    writer = new SpyUsageWriter();
  });

  afterEach(async () => {
    await tracker?.stop();
    vi.useRealTimers();
  });

  it('writes all windows on first fetch (no previous cache)', async () => {
    await seedAccount(store);
    const window5h = makeWindow({ id: '5h', utilization: 50 });
    const window7d = makeWindow({ id: '7d', label: '7 Day', utilization: 30, windowSeconds: 604_800 });
    const fetchedAt = Date.now();
    const provider = makeProvider(async () => makeUsage([window5h, window7d], { fetchedAt }));

    tracker = buildTracker(bus, store, provider, writer);
    await emitDetected(bus);

    expect(writer.entries).toHaveLength(2);
    const ids = writer.entries.map((entry) => entry.windowId);
    expect(ids).toContain('5h');
    expect(ids).toContain('7d');

    // ts must reflect the snapshot's fetchedAt, not wall clock
    for (const entry of writer.entries) {
      expect(entry.ts).toBe(fetchedAt);
    }
  });

  it('skips windows with unchanged utilization and resetsAt', async () => {
    await seedAccount(store);
    const resetsAt = Date.now() + 18_000_000;
    const provider = makeProvider(async () =>
      makeUsage([
        makeWindow({ id: '5h', utilization: 50, resetsAt }),
        makeWindow({ id: '7d', label: '7 Day', utilization: 30, resetsAt, windowSeconds: 604_800 }),
      ]),
    );

    tracker = buildTracker(bus, store, provider, writer);

    // First fetch — both windows written.
    await emitDetected(bus);
    expect(writer.entries).toHaveLength(2);

    writer.clear();

    // Advance past the throttle and emit again — same utilization and resetsAt.
    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    expect(writer.entries).toHaveLength(0);
  });

  it('writes only changed windows when utilization differs', async () => {
    await seedAccount(store);
    const resetsAt = Date.now() + 18_000_000;
    let utilization5h = 50;
    const provider = makeProvider(async () =>
      makeUsage([
        makeWindow({ id: '5h', utilization: utilization5h, resetsAt }),
        makeWindow({ id: '7d', label: '7 Day', utilization: 30, resetsAt, windowSeconds: 604_800 }),
      ]),
    );

    tracker = buildTracker(bus, store, provider, writer);

    // First fetch.
    await emitDetected(bus);
    expect(writer.entries).toHaveLength(2);

    writer.clear();
    utilization5h = 60;

    // Second fetch after throttle — only 5h changed.
    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].windowId).toBe('5h');
    expect(writer.entries[0].utilization).toBe(60);
  });

  it('writes all windows when blocked state changes', async () => {
    await seedAccount(store);
    const resetsAt = Date.now() + 18_000_000;
    let blocked = false;
    const provider = makeProvider(async () =>
      makeUsage(
        [
          makeWindow({ id: '5h', utilization: 50, resetsAt }),
          makeWindow({ id: '7d', label: '7 Day', utilization: 30, resetsAt, windowSeconds: 604_800 }),
        ],
        { blocked },
      ),
    );

    tracker = buildTracker(bus, store, provider, writer);

    // First fetch — not blocked.
    await emitDetected(bus);
    expect(writer.entries).toHaveLength(2);

    writer.clear();
    blocked = true;

    // Second fetch after throttle — blocked flipped, utilization unchanged.
    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    // Both windows must be written because the blocked flag changed.
    expect(writer.entries).toHaveLength(2);
    expect(writer.entries.every((entry) => entry.blocked === true)).toBe(true);
  });

  it('writes window when resetsAt changes but utilization stays the same', async () => {
    await seedAccount(store);
    let resetsAt = Date.now() + 18_000_000;
    const provider = makeProvider(async () => makeUsage([makeWindow({ id: '5h', utilization: 0, resetsAt })]));

    tracker = buildTracker(bus, store, provider, writer);

    // First fetch.
    await emitDetected(bus);
    expect(writer.entries).toHaveLength(1);

    writer.clear();
    resetsAt = resetsAt + 18_000_000; // window rolled over

    // Second fetch after throttle — resetsAt changed, utilization still 0.
    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].windowId).toBe('5h');
    expect(writer.entries[0].resetsAt).toBe(resetsAt);
  });

  it('does not interrupt the fetch-emit cycle when the writer throws', async () => {
    await seedAccount(store);
    const throwingWriter = new ThrowingUsageWriter();
    const provider = makeProvider(async () => makeUsage([makeWindow()]));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    tracker = buildTracker(bus, store, provider, throwingWriter);

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await emitDetected(bus);
      // Drain microtasks so schedulePersistence's fire-and-forget chain
      // reaches the (throwing) writer.
      await vi.advanceTimersByTimeAsync(0);
      expect(updates).toHaveLength(1);
      expect(throwingWriter.attempts).toBeGreaterThanOrEqual(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[UsagePersistence] append failed for windowId=5h:'),
        expect.any(Error),
      );
    } finally {
      cleanup();
      consoleErrorSpy.mockRestore();
    }
  });

  it('marks cached usage stale (rather than clearing) when the upstream provider later returns null', async () => {
    await seedAccount(store);
    let currentUsage: AccountUsage | null = makeUsage([makeWindow()]);
    const provider = makeProvider(async () => currentUsage);

    tracker = buildTracker(bus, store, provider, writer);
    await emitDetected(bus);

    let result = await bus.request(AccountManagerSubjects.usage.get, {
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
    });
    expect(result.usage).not.toBeNull();
    const lastGoodFetchedAt = result.usage!.fetchedAt;

    writer.clear();
    currentUsage = null;

    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    result = await bus.request(AccountManagerSubjects.usage.get, {
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
    });
    // The last-known snapshot is preserved — flagged stale and tagged with
    // the original success timestamp — so the UI can dim it rather than
    // silently ticking its reset clock past zero. A null response also never
    // produces a persistence write.
    expect(result.usage).not.toBeNull();
    expect(result.usage?.stale).toBe(true);
    expect(result.usage?.lastOkAt).toBe(lastGoodFetchedAt);
    expect(writer.entries).toHaveLength(0);
  });

  it('preserves the fetch throttle after a null usage response', async () => {
    await seedAccount(store);
    let currentUsage: AccountUsage | null = makeUsage([makeWindow()]);
    let resolveCount = 0;
    const provider = makeProvider(async () => {
      resolveCount++;
      return currentUsage;
    });

    tracker = buildTracker(bus, store, provider, writer);
    await emitDetected(bus);
    expect(resolveCount).toBe(1);

    currentUsage = null;
    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);
    expect(resolveCount).toBe(2);

    await emitRefreshed(bus);
    expect(resolveCount).toBe(2);

    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitRefreshed(bus);
    expect(resolveCount).toBe(3);
  });

  it('discards stale in-flight usage fetches after account removal', async () => {
    await seedAccount(store);
    const deferredUsage = createDeferred<AccountUsage | null>();
    const started = createDeferred<void>();
    const provider = makeProvider(async () => {
      started.resolve();
      return deferredUsage.promise;
    });

    tracker = buildTracker(bus, store, provider, writer);

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      const fetchPromise = emitDetected(bus);
      await started.promise;

      const clearPromise = tracker.clearAccountStateAndWait(CLIENT_ID, ACCOUNT_ID);
      let cleared = false;
      void clearPromise.then(() => {
        cleared = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toBe(false);

      deferredUsage.resolve(makeUsage([makeWindow()]));
      await clearPromise;
      await fetchPromise;

      expect(cleared).toBe(true);
      expect(updates).toHaveLength(0);
      expect(writer.entries).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('does not delay usage.updated until persistence finishes', async () => {
    await seedAccount(store);
    const delayedWriter = new PendingUsageWriter();
    const provider = makeProvider(async () => makeUsage([makeWindow()]));

    tracker = buildTracker(bus, store, provider, delayedWriter);

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      const fetchPromise = emitDetected(bus);
      await delayedWriter.started.promise;
      await fetchPromise;

      expect(updates).toHaveLength(1);
      expect(delayedWriter.entries).toHaveLength(1);
    } finally {
      delayedWriter.release();
      cleanup();
    }
  });

  it('clearAccountState waits for in-flight persistence before resolving', async () => {
    await seedAccount(store);
    const delayedWriter = new PendingUsageWriter();
    const provider = makeProvider(async () => makeUsage([makeWindow()]));

    tracker = buildTracker(bus, store, provider, delayedWriter);

    try {
      await emitDetected(bus);
      await delayedWriter.started.promise;

      let cleared = false;
      const clearPromise = tracker.clearAccountStateAndWait(CLIENT_ID, ACCOUNT_ID).then(() => {
        cleared = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toBe(false);

      delayedWriter.release();
      await clearPromise;

      expect(cleared).toBe(true);
    } finally {
      delayedWriter.release();
    }
  });

  it('stop waits for in-flight persistence before resolving', async () => {
    await seedAccount(store);
    const delayedWriter = new PendingUsageWriter();
    const provider = makeProvider(async () => makeUsage([makeWindow()]));

    tracker = buildTracker(bus, store, provider, delayedWriter);

    try {
      await emitDetected(bus);
      await delayedWriter.started.promise;

      let stopped = false;
      const stopPromise = tracker.stop().then(() => {
        stopped = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      delayedWriter.release();
      await stopPromise;

      expect(stopped).toBe(true);
    } finally {
      delayedWriter.release();
    }
  });

  it('does not advance the persistence baseline after a write failure', async () => {
    await seedAccount(store);
    const flakyWriter = new FlakyUsageWriter();
    const usage = makeUsage([makeWindow()]);
    const provider = makeProvider(async () => usage);

    tracker = buildTracker(bus, store, provider, flakyWriter);

    await emitDetected(bus);
    expect(flakyWriter.attempts).toBe(1);
    expect(flakyWriter.entries).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    expect(flakyWriter.attempts).toBe(2);
    expect(flakyWriter.entries).toHaveLength(1);
    expect(flakyWriter.entries[0].windowId).toBe('5h');
  });

  it('preserves successful window baselines when a later append throws', async () => {
    await seedAccount(store);
    const partialThrowWriter = new ThrowsOncePerWindowWriter('7d');
    const resetsAt = Date.now() + 18_000_000;
    const provider = makeProvider(async () =>
      makeUsage([
        makeWindow({ id: '5h', utilization: 50, resetsAt }),
        makeWindow({ id: '7d', label: '7 Day', utilization: 30, resetsAt, windowSeconds: 604_800 }),
      ]),
    );

    tracker = buildTracker(bus, store, provider, partialThrowWriter);

    await emitDetected(bus);
    expect(partialThrowWriter.attempts).toEqual(['5h', '7d']);
    expect(partialThrowWriter.entries).toHaveLength(1);
    expect(partialThrowWriter.entries[0].windowId).toBe('5h');

    await vi.advanceTimersByTimeAsync(PAST_THROTTLE_MS);
    await emitDetected(bus);

    expect(partialThrowWriter.attempts).toEqual(['5h', '7d', '7d']);
    expect(partialThrowWriter.entries).toHaveLength(2);
    expect(partialThrowWriter.entries.map((entry) => entry.windowId)).toEqual(['5h', '7d']);
  });

  it('defaults blocked to false when AccountUsage.blocked is undefined', async () => {
    await seedAccount(store);
    // Omit `blocked` entirely — the delta filter must default to false, not undefined.
    const provider = makeProvider(async () => makeUsage([makeWindow()]));

    tracker = buildTracker(bus, store, provider, writer);
    await emitDetected(bus);

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].blocked).toBe(false);
  });

  it('works normally without a writer (optional dependency)', async () => {
    await seedAccount(store);
    const provider = makeProvider(async () => makeUsage([makeWindow()]));

    // No writer passed — tracker must not throw.
    tracker = buildTracker(bus, store, provider);

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await emitDetected(bus);
      expect(updates).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  describe('metadata patching', () => {
    it('persists metadata patches and emits metadataPatched', async () => {
      await seedAccount(store);
      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);

      const patched: unknown[] = [];
      const cleanup = bus.on(AccountManagerSubjects.accounts.metadataPatched, (ctx) => {
        patched.push(ctx.payload);
      });

      try {
        await emitDetected(bus);

        expect(patched).toHaveLength(1);
        const payload = patched[0] as { clientId: string; account: { metadata: Record<string, unknown> } };
        expect(payload.clientId).toBe(CLIENT_ID);
        expect(payload.account.metadata).toMatchObject({ planType: 'plus' });

        const stored = await store.get(CLIENT_ID, ACCOUNT_ID);
        expect(stored?.metadata).toMatchObject({ planType: 'plus' });
      } finally {
        cleanup();
      }
    });

    it('drops metadata patches when shutdown requestStop() is followed by stop()', async () => {
      await seedAccount(store);
      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);

      const patchStarted = createDeferred<void>();
      const patchGate = createDeferred<void>();
      const invalidationApplied = createDeferred<void>();
      const originalPatchMetadata = store.metadataStore.patchMetadata.bind(store.metadataStore);
      const originalBumpMetadataGeneration = store.metadataStore.bumpMetadataGeneration.bind(store.metadataStore);
      const patchSpy = vi
        .spyOn(store.metadataStore, 'patchMetadata')
        .mockImplementation(async (clientId: string, accountId: string, expectedGeneration: number, patches) => {
          patchStarted.resolve();
          await patchGate.promise;
          return originalPatchMetadata(clientId, accountId, expectedGeneration, patches);
        });
      const bumpSpy = vi
        .spyOn(store.metadataStore, 'bumpMetadataGeneration')
        .mockImplementation(async (clientId: string, accountId: string) => {
          const generation = await originalBumpMetadataGeneration(clientId, accountId);
          invalidationApplied.resolve();
          return generation;
        });

      const patched: unknown[] = [];
      const cleanup = bus.on(AccountManagerSubjects.accounts.metadataPatched, (ctx) => {
        patched.push(ctx.payload);
      });

      try {
        const fetchPromise = emitDetected(bus);
        await patchStarted.promise;

        tracker.requestStop();
        const stopPromise = tracker.stop();
        await invalidationApplied.promise;
        patchGate.resolve();
        await stopPromise;
        await fetchPromise;

        expect(patchSpy).toHaveBeenCalledTimes(1);
        expect(bumpSpy).toHaveBeenCalled();
        expect(patched).toHaveLength(0);

        const stored = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
        expect(stored?.metadata).not.toMatchObject({ planType: 'plus' });
      } finally {
        patchGate.resolve();
        cleanup();
        bumpSpy.mockRestore();
        patchSpy.mockRestore();
      }
    });

    it('drops metadata patches when account generation changes after usage emit', async () => {
      await seedAccount(store);
      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);
      const patchSpy = vi.spyOn(store.metadataStore, 'patchMetadata');
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, () => {
        void tracker?.clearAccountState(CLIENT_ID, ACCOUNT_ID);
      });

      try {
        await emitDetected(bus);

        expect(patchSpy).not.toHaveBeenCalled();
        const stored = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
        expect(stored?.metadata).not.toMatchObject({ planType: 'plus' });
      } finally {
        cleanup();
        patchSpy.mockRestore();
      }
    });

    it('rejects a metadata patch write when invalidation wins mid-patch', async () => {
      await seedAccount(store);
      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);

      const patchStarted = createDeferred<void>();
      const patchGate = createDeferred<void>();
      const originalPatchMetadata = store.metadataStore.patchMetadata.bind(store.metadataStore);
      const patchSpy = vi
        .spyOn(store.metadataStore, 'patchMetadata')
        .mockImplementation(async (clientId, accountId, expectedGeneration, patches) => {
          patchStarted.resolve();
          await patchGate.promise;
          return originalPatchMetadata(clientId, accountId, expectedGeneration, patches);
        });

      const patched: unknown[] = [];
      const cleanup = bus.on(AccountManagerSubjects.accounts.metadataPatched, (ctx) => {
        patched.push(ctx.payload);
      });

      try {
        const fetchPromise = emitDetected(bus);
        await patchStarted.promise;

        const clearPromise = tracker.clearAccountStateAndWait(CLIENT_ID, ACCOUNT_ID);
        patchGate.resolve();
        await clearPromise;
        await fetchPromise;

        expect(patchSpy).toHaveBeenCalledOnce();
        expect(patched).toHaveLength(0);

        const stored = await store.metadataStore.get(CLIENT_ID, ACCOUNT_ID);
        expect(stored?.metadata).not.toMatchObject({ planType: 'plus' });
      } finally {
        patchGate.resolve();
        cleanup();
        patchSpy.mockRestore();
      }
    });

    it('skips upsert when patches already match current metadata', async () => {
      // Seed the account with the patch value already applied.
      await store.upsert(CLIENT_ID, {
        id: ACCOUNT_ID,
        metadata: { planType: 'plus' },
        active: true,
        fingerprint: ACCOUNT_ID,
        detectedAt: 1000,
        lastSeenAt: 1000,
        credential: {
          token: 'test-token',
          fingerprint: ACCOUNT_ID,
          metadata: {},
        },
      });

      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);

      // Spy on patchMetadata AFTER seeding so only tracker-driven calls are counted.
      const patchSpy = vi.spyOn(store.metadataStore, 'patchMetadata');

      const patched: unknown[] = [];
      const cleanup = bus.on(AccountManagerSubjects.accounts.metadataPatched, (ctx) => {
        patched.push(ctx.payload);
      });

      try {
        await emitDetected(bus);

        // No metadata change — patchMetadata must not be called and no event emitted.
        expect(patchSpy).not.toHaveBeenCalled();
        expect(patched).toHaveLength(0);
      } finally {
        cleanup();
        patchSpy.mockRestore();
      }
    });

    it('does not clobber unrelated metadata fields', async () => {
      // Seed the account with a pre-existing unrelated metadata field.
      await store.upsert(CLIENT_ID, {
        id: ACCOUNT_ID,
        metadata: { authMode: 'chatgpt', planType: 'free' },
        active: true,
        fingerprint: ACCOUNT_ID,
        detectedAt: 1000,
        lastSeenAt: 1000,
        credential: {
          token: 'test-token',
          fingerprint: ACCOUNT_ID,
          metadata: {},
        },
      });

      const provider = makeProviderWithResult(async () => ({
        usage: makeUsage([makeWindow()]),
        metadataPatches: { planType: 'plus' },
      }));

      tracker = buildTracker(bus, store, provider);

      await emitDetected(bus);

      const stored = await store.get(CLIENT_ID, ACCOUNT_ID);
      // The patch must update planType while leaving authMode intact.
      expect(stored?.metadata).toMatchObject({ authMode: 'chatgpt', planType: 'plus' });
    });
  });
});
