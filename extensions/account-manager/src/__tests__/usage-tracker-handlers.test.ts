import { describe, it, expect, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import type { UsageEntry } from '../bus/usage-entry.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type { IAccountUsageSnapshotStore } from '../interfaces/account-store.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a test credential with a deterministic fingerprint derived from the token.
 * @param token - Token string to use as the credential payload
 * @returns A RawCredential with a computed fingerprint
 */
function makeCredential(token: string): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: {},
  };
}

/**
 * Creates a minimal usage snapshot for testing.
 * @param fetchedAt - Epoch ms for the snapshot timestamp
 * @returns A valid AccountUsage fixture
 */
function makeUsage(fetchedAt: number): AccountUsage {
  return {
    fetchedAt,
    windows: [],
  };
}

function makeUsageWithWindow(fetchedAt: number): AccountUsage {
  return {
    fetchedAt,
    windows: [
      {
        id: '5h',
        label: '5 Hour',
        utilization: 50,
        resetsAt: fetchedAt + 18_000_000,
        windowSeconds: 18_000,
      },
    ],
  };
}

class PendingSnapshotStore implements IAccountUsageSnapshotStore {
  private readonly entries = new Map<string, UsageEntry[]>();
  private appendCount = 0;
  public started: Promise<void>;
  private resolveStarted!: () => void;
  private gate: Promise<void>;
  private resolveGate!: () => void;

  public constructor() {
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.resolveGate = resolve;
    });
  }

  public async append(clientId: string, accountId: string, entry: UsageEntry): Promise<boolean> {
    const key = `${clientId}:${accountId}`;
    const rows = this.entries.get(key) ?? [];
    rows.push(structuredClone(entry));
    this.entries.set(key, rows);
    this.appendCount += 1;
    if (this.appendCount === 1) {
      this.resolveStarted();
      await this.gate;
    }
    return true;
  }

  public async *read(
    clientId: string,
    accountId: string,
    _opts: { from: number; to: number; windowId?: string },
  ): AsyncIterable<UsageEntry> {
    for (const entry of this.entries.get(`${clientId}:${accountId}`) ?? []) {
      yield structuredClone(entry);
    }
  }

  public async hasAnySnapshots(): Promise<boolean> {
    return [...this.entries.values()].some((rows) => rows.length > 0);
  }

  public release(): void {
    this.resolveGate();
  }
}

describe('UsageTracker', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('emits usage.updated when a credential is first detected', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const usage = makeUsage(1000);
    // Resolver must be installed before AccountManager construction so the source
    // is included in the usage-capable map built in buildUsageSources().
    source.setUsageResolver(async () => usage);
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const cred = makeCredential('token-usage');
    source.setCredential(cred);

    // Capture the stable UUID assigned by handleNewAccount when detection fires.
    let detectedAccountId: string | undefined;
    const detectedCleanup = bus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
      detectedAccountId = ctx.payload.account.id;
    });

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);

      expect(detectedAccountId).toBeDefined();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        clientId: 'claude-code',
        accountId: detectedAccountId,
        usage,
      });
    } finally {
      detectedCleanup();
      cleanup();
      await service.destroy();
    }
  });

  it('responds to usage.get with cached usage', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const usage = makeUsage(2000);
    // Resolver installed before construction.
    source.setUsageResolver(async () => usage);
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const cred = makeCredential('token-cached-usage');
    source.setCredential(cred);

    // Trigger detection so usage is fetched and cached.
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve the stable UUID assigned at detection time.
    const accounts = await store.list('claude-code');
    const account = accounts.find((a) => a.fingerprint === cred.fingerprint);
    expect(account).toBeDefined();

    const result = await bus.request(AccountManagerSubjects.usage.get, {
      clientId: 'claude-code',
      accountId: account!.id,
    });

    try {
      // UsageTracker annotates cached snapshots with stale=false + lastOkAt so
      // downstream consumers can tell an authoritative result from a recovered
      // stale one. The shape-matching assertion covers both.
      expect(result.usage).toMatchObject({ ...usage, stale: false, lastOkAt: usage.fetchedAt });
    } finally {
      await service.destroy();
    }
  });

  it('returns null from usage.get when there is no cached usage', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      const result = await bus.request(AccountManagerSubjects.usage.get, {
        clientId: 'claude-code',
        accountId: 'nonexistent-account',
      });
      expect(result.usage).toBeNull();
    } finally {
      await service.destroy();
    }
  });

  it('emits usage.updated for old and new accounts on credential switch', async () => {
    vi.useFakeTimers();
    // Use an isolated bus to avoid handler collisions across tests.
    const isolatedBus = createBusInstance();
    const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const isolatedStore = new InMemoryAccountStore();

    let fetchCount = 0;
    isolatedSource.setUsageResolver(async () => {
      fetchCount++;
      return makeUsage(fetchCount * 100);
    });

    const isolatedService = new AccountManager(isolatedBus, {
      sources: [isolatedSource],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });

    await isolatedService.init();

    try {
      // Detect account A.
      const credA = makeCredential('token-switch-a');
      isolatedSource.setCredential(credA);
      await vi.advanceTimersByTimeAsync(1000);

      // Detect account B — new account, not a switch.
      const credB = makeCredential('token-switch-b');
      isolatedSource.setCredential(credB);
      await vi.advanceTimersByTimeAsync(1000);

      // Resolve stable UUIDs from the store after both accounts are detected.
      const accounts = await isolatedStore.list('claude-code');
      const accountA = accounts.find((a) => a.fingerprint === credA.fingerprint);
      const accountB = accounts.find((a) => a.fingerprint === credB.fingerprint);
      expect(accountA).toBeDefined();
      expect(accountB).toBeDefined();

      // Switch back to known account A — this emits credentials.switched with from=B, to=A.
      isolatedSource.setCredential(credA);

      const updates: unknown[] = [];
      const cleanup = isolatedBus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        updates.push(ctx.payload);
      });

      try {
        // Advance well past the 60s throttle so forceRefresh kicks in for both accounts.
        await vi.advanceTimersByTimeAsync(61_000);

        // UsageTracker should emit usage.updated for both the old account (B) and
        // the new active account (A) in response to the credentials.switched event.
        const accountIds = updates.map((u) => (u as { accountId: string }).accountId);
        expect(accountIds).toContain(accountA!.id);
        expect(accountIds).toContain(accountB!.id);
      } finally {
        cleanup();
      }
    } finally {
      await isolatedService.destroy();
    }
  });

  it('does not emit usage.updated when the source has no usage provider', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    // No usageResolver installed — source is absent from usageSources map.
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    source.setCredential(makeCredential('token-no-usage'));

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(updates).toHaveLength(0);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('refreshes a single account when usage.refresh is called with clientId and accountId', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-refresh-one'));
      await vi.advanceTimersByTimeAsync(1000);
      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      const baselineFetchCount = fetchCount;

      const updates: string[] = [];
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        updates.push(ctx.payload.accountId);
      });

      try {
        const response = await bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
          accountId: accounts[0].id,
        });
        expect(response.refreshed).toBe(1);

        await vi.advanceTimersByTimeAsync(0);
        expect(updates).toEqual([accounts[0].id]);
        expect(fetchCount).toBe(baselineFetchCount + 1);
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('refreshes every known account when usage.refresh is called with no scope', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const sourceA = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const sourceB = new InMemoryCredentialSource('codex', 'Codex');
    let fetchCountA = 0;
    let fetchCountB = 0;
    sourceA.setUsageResolver(async () => makeUsage(++fetchCountA * 1000));
    sourceB.setUsageResolver(async () => makeUsage(++fetchCountB * 1000));
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [sourceA, sourceB],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      // Two sources × two accounts on A + one on B exercises both the source
      // iteration and the per-source account iteration — an implementation
      // that only refreshed one source or skipped a secondary account would
      // fail the total count assertion.
      sourceA.setCredential(makeCredential('token-refresh-all-a1'));
      await vi.advanceTimersByTimeAsync(1000);
      sourceA.setCredential(makeCredential('token-refresh-all-a2'));
      await vi.advanceTimersByTimeAsync(1000);
      sourceB.setCredential(makeCredential('token-refresh-all-b1'));
      await vi.advanceTimersByTimeAsync(1000);

      const accountsA = await store.list('claude-code');
      const accountsB = await store.list('codex');
      expect(accountsA).toHaveLength(2);
      expect(accountsB).toHaveLength(1);
      const baselineA = fetchCountA;
      const baselineB = fetchCountB;

      const updates: string[] = [];
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        updates.push(ctx.payload.accountId);
      });

      try {
        const response = await bus.request(AccountManagerSubjects.usage.refresh, {});
        expect(response.refreshed).toBe(3);

        await vi.advanceTimersByTimeAsync(0);
        expect(updates.sort()).toEqual([...accountsA.map((a) => a.id), ...accountsB.map((a) => a.id)].sort());
        expect(fetchCountA).toBe(baselineA + 2);
        expect(fetchCountB).toBe(baselineB + 1);
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('bootstraps a usage fetch for every stored account when the service starts', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();

    // Seed the store with an inactive account as if from a previous session —
    // without the bootstrap refresh, this account would wait a full poll
    // interval for its first usage snapshot.
    await store.upsert('claude-code', {
      id: 'prev-session-account',
      metadata: {},
      fingerprint: 'prev-session-fp',
      active: false,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: { token: 'prev-session-token', fingerprint: 'prev-session-fp', metadata: {} },
    });

    const updates: string[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload.accountId);
    });

    // 60 s is long enough that only the bootstrap — not the first periodic
    // tick — can produce the assertion.
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();
      // Let the bootstrap refresh's async fetches settle without advancing
      // far enough to trigger the first periodic tick.
      await vi.advanceTimersByTimeAsync(0);

      expect(updates).toContain('prev-session-account');
      expect(fetchCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('does not delay bootstrap usage fetches by periodic jitter', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();

    await store.upsert('claude-code', {
      id: 'jitter-bootstrap-account',
      metadata: {},
      fingerprint: 'jitter-bootstrap-fp',
      active: true,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: { token: 'jitter-bootstrap-token', fingerprint: 'jitter-bootstrap-fp', metadata: {} },
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 60_000,
      usageSourceConfigs: new Map([
        [
          'claude-code',
          { minFetchIntervalMs: 60_000, activeIntervalMs: 1_000, inactiveIntervalMs: 1_000, jitterMs: 5_000 },
        ],
      ]),
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCount).toBe(1);
    } finally {
      await service.destroy();
    }
  });

  it('coalesces bootstrap and startup refresh fetches for the same stored account', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const cred = makeCredential('token-startup-coalesce');
    let fetchCount = 0;
    let releaseResolveUsage: (() => void) | undefined;
    source.setCredential(cred);
    source.setUsageResolver(async () => {
      fetchCount++;
      await new Promise<void>((resolve) => {
        releaseResolveUsage = resolve;
      });
      return makeUsage(fetchCount * 1000);
    });
    const store = new InMemoryAccountStore();

    await store.upsert('claude-code', {
      id: 'existing-account',
      metadata: {},
      fingerprint: cred.fingerprint,
      active: true,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: cred,
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      // credential detection's fetchAndEmit blocks on the resolver gate,
      // which blocks credentialTracker.start(), so init() hasn't returned yet.
      // Release the gate so init() can complete (including bootstrap()).
      const initPromise = service.init();
      await vi.advanceTimersByTimeAsync(0);
      releaseResolveUsage?.();
      await initPromise;
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCount).toBe(1);
    } finally {
      await service.destroy();
    }
  });

  it('refreshes only accounts for the given clientId when usage.refresh is called with clientId only', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const sourceA = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const sourceB = new InMemoryCredentialSource('codex', 'Codex');
    let fetchCountA = 0;
    let fetchCountB = 0;
    sourceA.setUsageResolver(async () => makeUsage(++fetchCountA * 1000));
    sourceB.setUsageResolver(async () => makeUsage(++fetchCountB * 1000));
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [sourceA, sourceB],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      sourceA.setCredential(makeCredential('token-client-scope-a'));
      sourceB.setCredential(makeCredential('token-client-scope-b'));
      await vi.advanceTimersByTimeAsync(1000);

      const accountsA = await store.list('claude-code');
      const accountsB = await store.list('codex');
      expect(accountsA).toHaveLength(1);
      expect(accountsB).toHaveLength(1);
      const baselineA = fetchCountA;
      const baselineB = fetchCountB;

      const updates: string[] = [];
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        updates.push(ctx.payload.accountId);
      });

      try {
        const response = await bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
        });
        expect(response.refreshed).toBe(1);

        await vi.advanceTimersByTimeAsync(0);
        expect(updates).toEqual([accountsA[0].id]);
        expect(fetchCountA).toBe(baselineA + 1);
        expect(fetchCountB).toBe(baselineB);
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('reports refreshed=0 when usage.refresh targets an unknown accountId', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-unknown-account'));
      await vi.advanceTimersByTimeAsync(1000);
      const baselineFetchCount = fetchCount;

      const response = await bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: 'not-a-real-account-id',
      });
      expect(response.refreshed).toBe(0);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCount).toBe(baselineFetchCount);
    } finally {
      await service.destroy();
    }
  });

  it('reports refreshed=0 when usage.refresh is suppressed by an account cooldown', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    let shouldRateLimit = false;
    source.setUsageResolver(async () => {
      fetchCount++;
      if (shouldRateLimit) throw new RateLimitedError(60_000);
      return makeUsage(fetchCount * 1000);
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-refresh-cooldown'));
      await vi.advanceTimersByTimeAsync(1000);
      const [account] = await store.list('claude-code');
      expect(account).toBeDefined();

      shouldRateLimit = true;
      const firstRefresh = await bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: account!.id,
      });
      expect(firstRefresh.refreshed).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      const countAfterCooldownStart = fetchCount;

      const secondRefresh = await bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: account!.id,
      });
      expect(secondRefresh.refreshed).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCount).toBe(countAfterCooldownStart);
    } finally {
      await service.destroy();
    }
  });

  it('runs the internal periodic poll at the configured cadence', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();
    // usagePollIntervalMs is the scheduler tick cadence; activeIntervalMs is
    // how much the scheduler must see elapsed before an account is picked
    // again. Setting the account interval well below the tick guarantees the
    // first tick after a credential-event fetch always picks the account up.
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-periodic-poll'));
      // Bootstrap + first credential-event-driven fetch.
      await vi.advanceTimersByTimeAsync(1000);
      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      const baselineFetchCount = fetchCount;

      const updates: string[] = [];
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        updates.push(ctx.payload.accountId);
      });

      try {
        // Advance past one periodic-poll boundary and let pending microtasks settle.
        await vi.advanceTimersByTimeAsync(5_000);

        expect(fetchCount).toBeGreaterThan(baselineFetchCount);
        expect(updates).toContain(accounts[0].id);
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('allows a per-source tick override to re-enable bootstrap and periodic polling when the global cadence is 0', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();

    await store.upsert('claude-code', {
      id: 'override-enabled-account',
      metadata: {},
      fingerprint: 'override-enabled-fp',
      active: true,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: { token: 'override-enabled-token', fingerprint: 'override-enabled-fp', metadata: {} },
    });

    const updates: string[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload.accountId);
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      usageSourceConfigs: new Map([
        ['claude-code', { minFetchIntervalMs: 5_000, activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }],
      ]),
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();
      await vi.advanceTimersByTimeAsync(0);

      expect(updates).toContain('override-enabled-account');
      const bootstrapFetchCount = fetchCount;
      expect(bootstrapFetchCount).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchCount).toBeGreaterThan(bootstrapFetchCount);
      expect(updates.filter((accountId) => accountId === 'override-enabled-account').length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('skips the next periodic tick while an in-flight refresh is still running', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    // Wrapping in an array avoids TypeScript's control-flow narrowing that
    // would otherwise make the element type `never` after an explicit `= undefined`.
    const releaseGate: Array<() => void> = [];
    source.setUsageResolver(async () => {
      fetchCount++;
      await new Promise<void>((resolve) => {
        releaseGate[0] = resolve;
      });
      return makeUsage(fetchCount * 1000);
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-overlap-guard'));
      await vi.advanceTimersByTimeAsync(1000);
      // Bootstrap + credentials.refreshed both route into fetchAndEmit; the
      // bootstrap grabs the polling lock first and the throttle suppresses
      // the credential-event fetch. Release it so the bootstrap settles.
      expect(fetchCount).toBe(1);
      releaseGate[0]?.();
      await vi.advanceTimersByTimeAsync(0);

      // Arm the next resolveUsage to stay pending so the periodic cycle
      // that fires at t+5s holds the polling lock.
      const baselineFetchCount = fetchCount;

      // Advance past the first periodic tick — the cycle kicks off but
      // resolveUsage is pending (no release called), so polling stays true.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchCount).toBe(baselineFetchCount + 1);

      // Advance past a second periodic tick while the first is still
      // in-flight. polling === true must suppress a concurrent sweep.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchCount).toBe(baselineFetchCount + 1);

      // Release the held fetch; the next tick is then free to run.
      releaseGate[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchCount).toBe(baselineFetchCount + 2);
      releaseGate[0]?.();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await service.destroy();
    }
  });

  it('does not emit usage.updated for fetches that resolve after stop()', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let releaseResolveUsage: (() => void) | undefined;
    source.setUsageResolver(async () => {
      await new Promise<void>((resolve) => {
        releaseResolveUsage = resolve;
      });
      return makeUsage(1);
    });
    const store = new InMemoryAccountStore();
    const credential = makeCredential('token-post-stop');
    await store.upsert('claude-code', {
      id: 'acct-post-stop',
      metadata: {},
      active: true,
      fingerprint: credential.fingerprint,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential,
    });
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      const refreshPromise = bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: 'acct-post-stop',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(updates).toHaveLength(0);

      // Tear down while the fetch is still in flight.
      const destroyPromise = service.destroy();

      // Release the fetch so quiescing teardown can finish.
      releaseResolveUsage?.();
      await destroyPromise;
      await expect(refreshPromise).resolves.toMatchObject({ refreshed: 1 });

      expect(updates).toHaveLength(0);
    } finally {
      cleanup();
      releaseResolveUsage?.();
    }
  });

  it('fetches usage again immediately after an account is removed and re-detected', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    source.setUsageResolver(async () => makeUsage(++fetchCount * 1000));
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const cred = makeCredential('token-redetect-after-remove');
    source.setCredential(cred);

    // Capture the UUID assigned on first detection.
    let firstAccountId: string | undefined;
    const detectedCleanup = bus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
      firstAccountId = ctx.payload.account.id;
    });

    const updates: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(updates).toHaveLength(1);
      expect(firstAccountId).toBeDefined();

      const removeResult = await bus.request(AccountManagerSubjects.accounts.remove, {
        clientId: 'claude-code',
        accountId: firstAccountId!,
      });
      expect(removeResult.success).toBe(true);

      // Capture the UUID assigned on re-detection (a new UUID since it's a brand-new account).
      let redetectedAccountId: string | undefined;
      const redetectedCleanup = bus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        redetectedAccountId = ctx.payload.account.id;
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);

        expect(updates).toHaveLength(2);
        expect(redetectedAccountId).toBeDefined();
        expect(updates[1]).toMatchObject({
          clientId: 'claude-code',
          accountId: redetectedAccountId,
          usage: expect.objectContaining({ fetchedAt: 2000 }),
        });
      } finally {
        redetectedCleanup();
      }
    } finally {
      detectedCleanup();
      cleanup();
      await service.destroy();
    }
  });

  it('emits a stale empty snapshot when provider throws RateLimitedError and no prior snapshot exists', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    source.setUsageResolver(async () => {
      throw new RateLimitedError(90_000);
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const updates: Array<{ clientId: string; accountId: string; usage: { stale?: boolean; windows: unknown[] } }> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      source.setCredential(makeCredential('token-ratelimit-cold'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.usage.stale).toBe(true);
      expect(updates[0]!.usage.windows).toHaveLength(0);
      expect(updates[0]!.usage).not.toHaveProperty('lastOkAt');
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('emits a stale snapshot when provider throws RateLimitedError after a successful fetch', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let shouldRateLimit = false;
    source.setUsageResolver(async () => {
      if (shouldRateLimit) throw new RateLimitedError(90_000);
      return makeUsage(Date.now());
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-ratelimit-warm'));
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);

      shouldRateLimit = true;

      const staleUpdates: Array<{ usage: AccountUsage }> = [];
      const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        staleUpdates.push(ctx.payload as { usage: AccountUsage });
      });

      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(staleUpdates.length).toBeGreaterThanOrEqual(1);
        const stale = staleUpdates[staleUpdates.length - 1].usage;
        expect(stale.stale).toBe(true);
        expect(stale.lastOkAt).toBeDefined();
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('suppresses fetches during RateLimitedError cooldown and resumes after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T12:00:00.000Z'));
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let fetchCount = 0;
    let shouldRateLimit = false;
    source.setUsageResolver(async () => {
      fetchCount++;
      if (shouldRateLimit) throw new RateLimitedError(60_000);
      return makeUsage(Date.now());
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-ratelimit-cooldown'));
      await vi.advanceTimersByTimeAsync(1000);
      const [account] = await store.list('claude-code');
      expect(account).toBeDefined();
      expect(infoSpy.mock.calls).toContainEqual([
        expect.stringMatching(
          new RegExp(
            String.raw`^\[UsageTracker\] 2026-04-22T12:00:\d{2}\.000Z source claude-code account ${account?.id} resolveUsage succeeded \(windows=0\)$`,
          ),
        ),
      ]);

      shouldRateLimit = true;
      const countBeforeRateLimit = fetchCount;

      // Trigger a 429 on the next periodic tick.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchCount).toBe(countBeforeRateLimit + 1);
      expect(warnSpy.mock.calls).toContainEqual([
        expect.stringMatching(
          new RegExp(
            String.raw`^\[UsageTracker\] 2026-04-22T12:00:\d{2}\.000Z source claude-code account ${account?.id} resolveUsage rate-limited, cooldown 60000ms$`,
          ),
        ),
      ]);
      const countAfterRateLimit = fetchCount;

      // Advance 30s — still within the 60s cooldown — no new fetches.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchCount).toBe(countAfterRateLimit);

      // Advance past the cooldown. Provider now succeeds.
      shouldRateLimit = false;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(fetchCount).toBeGreaterThan(countAfterRateLimit);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      await service.destroy();
    }
  });

  it('marks invalid usage auth, suppresses retries, and resumes after credentials.refreshed', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    let shouldFailAuth = true;
    source.setUsageResolver(undefined);
    source.resolveUsage = async () => {
      fetchCount += 1;
      if (shouldFailAuth) {
        throw new UsageAuthInvalidError('Claude usage fetch failed with HTTP 401 Unauthorized');
      }
      return { usage: makeUsage(Date.now()) };
    };
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-auth-invalid'));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchCount).toBe(1);

      const [storedAccount] = await store.list('claude-code');
      expect(storedAccount?.metadata).toMatchObject({
        usageAuthState: 'reauth-required',
        usageAuthMessage: 'Claude usage fetch failed with HTTP 401 Unauthorized',
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchCount).toBe(1);

      const suppressedRefresh = await bus.request(AccountManagerSubjects.usage.refresh, { clientId: 'claude-code' });
      expect(suppressedRefresh).toMatchObject({ refreshed: 0 });

      shouldFailAuth = false;
      const restoredCredential = makeCredential('token-auth-restored');
      source.setCredential(restoredCredential);
      await store.credentialStore.upsert('claude-code', {
        id: storedAccount.id,
        credential: restoredCredential,
        fingerprint: restoredCredential.fingerprint,
      });
      await bus.emit(AccountManagerSubjects.credentials.refreshed, {
        clientId: 'claude-code',
        account: {
          id: storedAccount.id,
          label: storedAccount.label,
          metadata: storedAccount.metadata,
          active: storedAccount.active,
          detectedAt: storedAccount.detectedAt,
          lastSeenAt: storedAccount.lastSeenAt,
        },
        reason: 'credential-updated',
      });

      expect(fetchCount).toBe(2);
      const [recoveredAccount] = await store.list('claude-code');
      expect(recoveredAccount?.metadata.usageAuthState).toBeUndefined();
      expect(recoveredAccount?.metadata.usageAuthMessage).toBeUndefined();
    } finally {
      await service.destroy();
    }
  });

  it('applies source-level cooldown so a 429 on one account suppresses all accounts for that source', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    let shouldRateLimit = false;
    source.setUsageResolver(async () => {
      fetchCount++;
      if (shouldRateLimit) throw new RateLimitedError(60_000);
      return makeUsage(Date.now());
    });
    const store = new InMemoryAccountStore();

    const credA = makeCredential('token-source-cooldown-a');
    const credB = makeCredential('token-source-cooldown-b');

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 5_000,
      usageSourceConfigs: new Map([['claude-code', { activeIntervalMs: 1_000, inactiveIntervalMs: 1_000 }]]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      // Detect two accounts.
      source.setCredential(credA);
      await vi.advanceTimersByTimeAsync(1000);
      source.setCredential(credB);
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(2);

      shouldRateLimit = true;
      const countBefore429 = fetchCount;

      // Let a periodic tick fire — one account hits 429.
      await vi.advanceTimersByTimeAsync(5_000);
      // Only one fetch should have been attempted (the one that got rate-limited).
      expect(fetchCount).toBe(countBefore429 + 1);

      // Advance another tick — source-level cooldown should suppress ALL
      // accounts, not just the one that hit 429.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchCount).toBe(countBefore429 + 1);
    } finally {
      await service.destroy();
    }
  });

  it('does not clear the source cooldown when a concurrent same-source fetch succeeds', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();
    await store.upsert('claude-code', {
      id: 'source-cooldown-overlap-a',
      metadata: {},
      fingerprint: 'source-cooldown-overlap-fp-a',
      active: true,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: {
        token: 'token-source-cooldown-overlap-a',
        fingerprint: 'source-cooldown-overlap-fp-a',
        metadata: {},
      },
    });
    await store.upsert('claude-code', {
      id: 'source-cooldown-overlap-b',
      metadata: {},
      fingerprint: 'source-cooldown-overlap-fp-b',
      active: true,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      credential: {
        token: 'token-source-cooldown-overlap-b',
        fingerprint: 'source-cooldown-overlap-fp-b',
        metadata: {},
      },
    });
    let overlapFetchCount = 0;
    let releaseRateLimitedFetch: (() => void) | undefined;
    let releaseSuccessfulFetch: (() => void) | undefined;
    source.setUsageResolver(async () => {
      overlapFetchCount++;
      if (overlapFetchCount === 1) {
        await new Promise<void>((resolve) => {
          releaseRateLimitedFetch = resolve;
        });
        throw new RateLimitedError(60_000);
      }
      if (overlapFetchCount === 2) {
        await new Promise<void>((resolve) => {
          releaseSuccessfulFetch = resolve;
        });
        return makeUsage(Date.now());
      }
      return makeUsage(Date.now());
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(2);

      const [refreshA, refreshB] = await Promise.all([
        bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
          accountId: accounts[0].id,
        }),
        bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
          accountId: accounts[1].id,
        }),
      ]);
      expect(refreshA.refreshed).toBe(1);
      expect(refreshB.refreshed).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(overlapFetchCount).toBe(2);

      releaseRateLimitedFetch?.();
      await vi.advanceTimersByTimeAsync(0);

      releaseSuccessfulFetch?.();
      await vi.advanceTimersByTimeAsync(0);
      const countAfterOverlap = overlapFetchCount;

      const secondRefresh = await bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: accounts[1].id,
      });
      expect(secondRefresh.refreshed).toBe(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(overlapFetchCount).toBe(countAfterOverlap);
    } finally {
      await service.destroy();
    }
  });

  it('reports refreshed=0 when usage.refresh coalesces onto an in-flight fetch for the same account', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let fetchCount = 0;
    let releaseFetch: (() => void) | undefined;
    source.setUsageResolver(async () => {
      fetchCount++;
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return makeUsage(fetchCount * 1000);
    });
    const store = new InMemoryAccountStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      source.setCredential(makeCredential('token-refresh-overlap'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchCount).toBe(1);
      releaseFetch?.();
      await vi.advanceTimersByTimeAsync(0);

      const [account] = await store.list('claude-code');
      expect(account).toBeDefined();

      const firstRefresh = bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: account!.id,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCount).toBe(2);

      const secondRefresh = await bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: account!.id,
      });
      expect(secondRefresh.refreshed).toBe(0);
      expect(fetchCount).toBe(2);

      releaseFetch?.();
      const firstRefreshResult = await firstRefresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(firstRefreshResult.refreshed).toBe(1);
    } finally {
      await service.destroy();
    }
  });

  it('waits for in-flight usage persistence before resolving accounts.remove', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    source.setUsageResolver(async () => makeUsageWithWindow(1000));
    const store = new InMemoryAccountStore();
    const credential = makeCredential('token-remove-waits');
    await store.upsert('claude-code', {
      id: 'acct-remove-persist',
      metadata: {},
      active: true,
      fingerprint: credential.fingerprint,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential,
    });
    const pendingSnapshots = new PendingSnapshotStore();
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: pendingSnapshots,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      const refreshPromise = bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: 'acct-remove-persist',
      });
      await vi.advanceTimersByTimeAsync(0);
      await pendingSnapshots.started;

      let resolved = false;
      const removePromise = bus
        .request(AccountManagerSubjects.accounts.remove, {
          clientId: 'claude-code',
          accountId: 'acct-remove-persist',
        })
        .then((result) => {
          resolved = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      pendingSnapshots.release();
      await expect(refreshPromise).resolves.toMatchObject({ refreshed: 1 });
      await expect(removePromise).resolves.toMatchObject({ success: true });
      expect(resolved).toBe(true);
    } finally {
      pendingSnapshots.release();
      await service.destroy();
    }
  });

  it('waits for an in-flight usage fetch before resolving accounts.remove', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let releaseFetch: (() => void) | undefined;
    source.setUsageResolver(async () => {
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return makeUsage(1000);
    });
    const store = new InMemoryAccountStore();
    const credential = makeCredential('token-remove-waits-fetch');
    await store.upsert('claude-code', {
      id: 'acct-remove-fetch',
      metadata: {},
      active: true,
      fingerprint: credential.fingerprint,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential,
    });
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      const refreshPromise = bus.request(AccountManagerSubjects.usage.refresh, {
        clientId: 'claude-code',
        accountId: 'acct-remove-fetch',
      });
      await vi.advanceTimersByTimeAsync(0);

      let resolved = false;
      const removePromise = bus
        .request(AccountManagerSubjects.accounts.remove, {
          clientId: 'claude-code',
          accountId: 'acct-remove-fetch',
        })
        .then((result) => {
          resolved = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      releaseFetch?.();
      await expect(refreshPromise).resolves.toMatchObject({ refreshed: 1 });
      await expect(removePromise).resolves.toMatchObject({ success: true });
      expect(resolved).toBe(true);
    } finally {
      releaseFetch?.();
      await service.destroy();
    }
  });

  it('does not wait for tracker quiescence when usage credential preparation already proved the account invalid', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    source.setRefreshHandler(async () => ({
      status: 'failed',
      reason: 'invalid_grant: refresh token revoked',
    }));
    const store = new InMemoryAccountStore();
    const activeCredential = makeCredential('token-active');
    const zombieCredential = makeCredential('token-zombie');
    await store.upsert('claude-code', {
      id: 'acct-active',
      metadata: {},
      active: true,
      fingerprint: activeCredential.fingerprint,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential: activeCredential,
    });
    await store.upsert('claude-code', {
      id: 'acct-zombie',
      metadata: {},
      active: false,
      fingerprint: zombieCredential.fingerprint,
      detectedAt: 1000,
      lastSeenAt: 1000,
      credential: zombieCredential,
    });
    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      pollIntervalMs: 1000,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      await expect(
        bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
          accountId: 'acct-zombie',
        }),
      ).resolves.toMatchObject({ refreshed: 0 });
      let resolved = false;
      const switchResultPromise = bus
        .request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: 'acct-zombie',
        })
        .then((result) => {
          resolved = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
      await expect(switchResultPromise).resolves.toMatchObject({
        success: false,
        error: 'invalid_grant: refresh token revoked',
      });
    } finally {
      await service.destroy();
    }
  });
});
