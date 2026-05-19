/// <reference types="bun-types" />
import { describe, it, expect, afterEach, jest } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';
import { createBusInstance } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import type { UsageEntry } from '../bus/usage-entry.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type { IAccountUsageSnapshotStore } from '../interfaces/account-store.js';
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
function _makeUsage(fetchedAt: number): AccountUsage {
  return {
    fetchedAt,
    windows: [],
  };
}

function _makeUsageWithWindow(fetchedAt: number): AccountUsage {
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

class _PendingSnapshotStore implements IAccountUsageSnapshotStore {
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

describe('LabelResolver', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('re-resolves label after credentials.switched fires with cleared label (identity change)', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let labelToReturn = 'Alice';
    source.setLabelResolver(async () => labelToReturn);
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      // Step 1: Detect account A — explicit fingerprint so we control the switch path.
      const credA = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'alice@x.com' } };
      source.setCredential(credA);
      await advanceTimersByTimeAsync(1000);

      // Account A is detected and auto-labeled "Alice".
      expect(labeled).toHaveLength(1);
      expect(labeled[0]).toMatchObject({ account: expect.objectContaining({ label: 'Alice' }) });

      // Step 2: Detect account B to make A inactive. B may also get auto-labeled.
      const credB = { token: 'token-b', fingerprint: 'fp-b', metadata: { email: 'bob@y.com' } };
      source.setCredential(credB);
      await advanceTimersByTimeAsync(1000);

      // Snapshot count before the switch — B's auto-label (if any) is already included.
      const labeledBeforeSwitch = labeled.length;

      // Step 3: Update the label resolver so the re-resolution returns a new value.
      labelToReturn = 'Bob';

      // Step 4: Switch back to A with same fingerprint but different metadata email.
      // CredentialTracker will detect fp-a as a known-account switch, run
      // mergeSourceAccountMetadataWithIdentityCheck, see identityChanged=true,
      // clear the label, and emit credentials.switched with to.label=undefined.
      const credAModified = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'bob@y.com' } };
      source.setCredential(credAModified);
      await advanceTimersByTimeAsync(1000);

      // LabelResolver must have picked up credentials.switched and re-resolved the label.
      expect(labeled).toHaveLength(labeledBeforeSwitch + 1);
      expect(labeled[labeled.length - 1]).toMatchObject({
        clientId: 'claude-code',
        account: expect.objectContaining({ label: 'Bob' }),
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('does NOT re-resolve label when switched account already has a label', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    source.setLabelResolver(async () => 'Alice');
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      // Step 1: Detect account A with label "Alice" (same metadata = no identity change on switch back).
      const credA = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'alice@x.com' } };
      source.setCredential(credA);
      await advanceTimersByTimeAsync(1000);

      expect(labeled).toHaveLength(1);
      expect(labeled[0]).toMatchObject({ account: expect.objectContaining({ label: 'Alice' }) });

      // Step 2: Detect account B — may also auto-label via the same resolver.
      const credB = { token: 'token-b', fingerprint: 'fp-b', metadata: { email: 'bob@y.com' } };
      source.setCredential(credB);
      await advanceTimersByTimeAsync(1000);

      // Snapshot labeled count after B's detection — B may also receive an auto-label.
      const labeledAfterB = labeled.length;

      // Step 3: Switch back to A with the same metadata — no identity change → label preserved.
      // credentials.switched fires with to.label="Alice", LabelResolver must skip re-resolution.
      const credASame = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'alice@x.com' } };
      source.setCredential(credASame);
      await advanceTimersByTimeAsync(1000);

      // No additional labeled event should fire for the switch back.
      expect(labeled).toHaveLength(labeledAfterB);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('emits accounts.labeled when a label is resolved on detection', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // Resolver must be installed before AccountManager construction so the source
    // is included in the label-capable map built in buildLabelSources().
    source.setLabelResolver(async () => 'Work Account');
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      source.setCredential(makeCredential('token-labelable'));
      await advanceTimersByTimeAsync(1000);

      expect(labeled).toHaveLength(1);
      expect(labeled[0]).toMatchObject({
        clientId: 'claude-code',
        account: expect.objectContaining({ label: 'Work Account' }),
      });

      // Label must also be persisted in the store.
      const accounts = await store.list('claude-code');
      expect(accounts[0].label).toBe('Work Account');
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('does not emit accounts.labeled when the source returns null', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // Resolver installed before construction — returns null so no label is emitted.
    source.setLabelResolver(async () => null);
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      source.setCredential(makeCredential('token-no-label'));
      await advanceTimersByTimeAsync(1000);
      expect(labeled).toHaveLength(0);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('stops retrying after a label is successfully resolved', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let resolveCallCount = 0;
    // Resolver installed before construction.
    source.setLabelResolver(async () => {
      resolveCallCount++;
      return 'Personal';
    });
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      source.setCredential(makeCredential('token-once'));

      // First poll — label resolved.
      await advanceTimersByTimeAsync(1000);
      expect(labeled).toHaveLength(1);
      const callCountAfterFirst = resolveCallCount;

      // Subsequent polls — account is labeled; LabelResolver should not call resolveLabel again.
      await advanceTimersByTimeAsync(1000);
      await advanceTimersByTimeAsync(1000);

      expect(resolveCallCount).toBe(callCountAfterFirst);
      expect(labeled).toHaveLength(1);
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('throttles label resolution retries to 60 seconds', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    let resolveCallCount = 0;
    // Resolver installed before construction — always returns null to trigger retries.
    source.setLabelResolver(async () => {
      resolveCallCount++;
      return null;
    });
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
      source.setCredential(makeCredential('token-throttled'));

      // First poll fires the first attempt.
      await advanceTimersByTimeAsync(1000);
      expect(resolveCallCount).toBe(1);

      // Advance less than the throttle interval — no retry.
      await advanceTimersByTimeAsync(30_000);
      expect(resolveCallCount).toBe(1);

      // Advance past the throttle interval — retry happens.
      await advanceTimersByTimeAsync(31_000);
      expect(resolveCallCount).toBe(2);
    } finally {
      await service.destroy();
    }
  });

  it('re-resolves immediately after credentials.switched even when a prior lookup set the retry timer', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // Resolver initially returns null (first lookup fails, sets retry timer).
    let resolveToLabel: string | null = null;
    source.setLabelResolver(async () => resolveToLabel);
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      // Step 1: Detect account A — resolver returns null, sets retry timer.
      const credA = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'alice@x.com' } };
      source.setCredential(credA);
      await advanceTimersByTimeAsync(1000);
      expect(labeled).toHaveLength(0);

      // Step 2: Detect account B to displace A.
      const credB = { token: 'token-b', fingerprint: 'fp-b', metadata: { email: 'bob@y.com' } };
      source.setCredential(credB);
      await advanceTimersByTimeAsync(1000);

      // Step 3: Make resolver return a label, then switch back to A.
      // The retry timer for A was set in step 1 and only ~2 s have elapsed —
      // well inside the 60 s throttle window. Without clearRetryState the
      // credentials.switched handler would be throttled and emit no label.
      resolveToLabel = 'Alice';
      const credASame = { token: 'token-a', fingerprint: 'fp-a', metadata: { email: 'alice@x.com' } };
      source.setCredential(credASame);
      await advanceTimersByTimeAsync(1000);

      // LabelResolver must have cleared the retry state on switched and resolved
      // the label immediately rather than waiting for the throttle to expire.
      expect(labeled).toHaveLength(1);
      expect(labeled[0]).toMatchObject({
        clientId: 'claude-code',
        account: expect.objectContaining({ label: 'Alice' }),
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('emits accounts.labeled when a label is resolved after a token refresh', async () => {
    jest.useFakeTimers();
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    // Resolver installed before construction but initially returns null (simulates
    // network unavailability). After the account is detected unlabeled, the resolver
    // is updated to return a real label, and the retry logic picks it up.
    let resolveToLabel: string | null = null;
    source.setLabelResolver(async () => resolveToLabel);
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

    const labeled: unknown[] = [];
    const cleanup = bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
      labeled.push(ctx.payload);
    });

    try {
      // Account detected unlabeled — resolver returns null.
      source.setCredential(makeCredential('refresh-no-label'));
      await advanceTimersByTimeAsync(1000);

      // Resolver now returns a label — advance past the throttle so the retry fires.
      resolveToLabel = 'Late Label';
      await advanceTimersByTimeAsync(61_000);

      expect(labeled).toHaveLength(1);
      expect(labeled[0]).toMatchObject({
        account: expect.objectContaining({ label: 'Late Label' }),
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });
});
