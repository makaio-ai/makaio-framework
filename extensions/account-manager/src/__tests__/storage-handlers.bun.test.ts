import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createTempDb } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import { sql } from 'drizzle-orm';
import { BusAccountMetadataStore, BusAccountUsageSnapshotStore } from '../storage/client.js';
import { registerDrizzleAccountManagerStorage } from '../storage/handlers.js';

const CLIENT_ID = 'claude-code';

async function applyAccountManagerSchema(db: MakaioDatabase): Promise<void> {
  const migrations = readMigrations(fileURLToPath(new URL('../drizzle', import.meta.url)));
  await applyMigrations(db, migrations, '__drizzle_migrations_test_account_manager_storage');
}

describe('registerDrizzleAccountManagerStorage', () => {
  let bus: IMakaioBus;
  let db: MakaioDatabase;
  let cleanupDb: () => void;
  let cleanupHandlers: () => void;
  let metadataStore: BusAccountMetadataStore;
  let usageSnapshotStore: BusAccountUsageSnapshotStore;

  beforeEach(async () => {
    bus = createBusInstance();
    const dbContext = await createTempDb('account-manager-storage');
    db = dbContext.db;
    cleanupDb = dbContext.cleanup;
    await applyAccountManagerSchema(db);
    cleanupHandlers = registerDrizzleAccountManagerStorage(bus, db, makeStubExtensionContext(bus));
    metadataStore = new BusAccountMetadataStore(bus);
    usageSnapshotStore = new BusAccountUsageSnapshotStore(bus);
  });

  afterEach(() => {
    cleanupHandlers();
    cleanupDb();
  });

  it('returns null before the first timeline row and resolves the most recent account switch at or before the timestamp', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-a',
      label: 'Account A',
      metadata: { planType: 'free' },
      active: false,
      detectedAt: 100,
      lastSeenAt: 200,
    });
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-b',
      label: 'Account B',
      metadata: { planType: 'pro' },
      active: true,
      detectedAt: 150,
      lastSeenAt: 300,
    });

    await metadataStore.appendTimeline({
      clientId: CLIENT_ID,
      fromAccountId: null,
      toAccountId: 'acc-a',
      effectiveAt: 500,
      reason: 'bootstrap',
    });
    await metadataStore.appendTimeline({
      clientId: CLIENT_ID,
      fromAccountId: 'acc-a',
      toAccountId: 'acc-b',
      effectiveAt: 900,
      reason: 'switch',
    });

    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 499)).resolves.toBeNull();
    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 500)).resolves.toBe('acc-a');
    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 899)).resolves.toBe('acc-a');
    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 900)).resolves.toBe('acc-b');
    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 10_000)).resolves.toBe('acc-b');
  });

  it('prefers the later appended timeline row when effectiveAt ties', async () => {
    await metadataStore.appendTimeline({
      clientId: CLIENT_ID,
      fromAccountId: null,
      toAccountId: 'acc-orphan',
      effectiveAt: 500,
      reason: 'bootstrap',
    });
    await metadataStore.appendTimeline({
      clientId: CLIENT_ID,
      fromAccountId: null,
      toAccountId: 'acc-survivor',
      effectiveAt: 500,
      reason: 'bootstrap',
    });

    await expect(metadataStore.getActiveAtTimestamp(CLIENT_ID, 500)).resolves.toBe('acc-survivor');
    await expect(metadataStore.getLatestTimelineEntry(CLIENT_ID, 'bootstrap')).resolves.toMatchObject({
      clientId: CLIENT_ID,
      toAccountId: 'acc-survivor',
      effectiveAt: 500,
      reason: 'bootstrap',
    });
  });

  it('stores only public account metadata rows in Drizzle', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-public',
      label: 'Public Account',
      metadata: { planType: 'team' },
      active: true,
      detectedAt: 1_000,
      lastSeenAt: 2_000,
    });

    const account = await metadataStore.get(CLIENT_ID, 'acc-public');
    expect(account).toMatchObject({
      id: 'acc-public',
      label: 'Public Account',
      metadata: { planType: 'team' },
      active: true,
      detectedAt: 1_000,
      lastSeenAt: 2_000,
    });

    const rows = await db.all<Record<string, unknown>>(sql.raw("SELECT * FROM accounts WHERE id = 'acc-public'"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('credential');
    expect(rows[0]).not.toHaveProperty('fingerprint');
  });

  it('persists linkedClientAccountId as part of the public account row', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-linked',
      label: 'Linked Account',
      linkedClientAccountId: 'client-account-42',
      metadata: { planType: 'team' },
      active: true,
      detectedAt: 1_000,
      lastSeenAt: 2_000,
    });

    await expect(metadataStore.get(CLIENT_ID, 'acc-linked')).resolves.toMatchObject({
      id: 'acc-linked',
      linkedClientAccountId: 'client-account-42',
    });

    await expect(
      metadataStore.setLinkedClientAccountId(CLIENT_ID, 'acc-linked', 'client-account-99'),
    ).resolves.toMatchObject({
      id: 'acc-linked',
      linkedClientAccountId: 'client-account-99',
    });

    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-linked',
      label: 'Linked Account Renamed',
      metadata: { planType: 'team' },
      active: true,
      detectedAt: 1_000,
      lastSeenAt: 3_000,
    });

    await expect(metadataStore.get(CLIENT_ID, 'acc-linked')).resolves.toMatchObject({
      id: 'acc-linked',
      label: 'Linked Account Renamed',
      linkedClientAccountId: 'client-account-99',
      lastSeenAt: 3_000,
    });

    await expect(metadataStore.listByLinkedClientAccountId(CLIENT_ID, 'client-account-99')).resolves.toEqual([
      expect.objectContaining({
        id: 'acc-linked',
        linkedClientAccountId: 'client-account-99',
      }),
    ]);

    await expect(metadataStore.setLinkedClientAccountId(CLIENT_ID, 'acc-linked', null)).resolves.toMatchObject({
      id: 'acc-linked',
    });
    await expect(metadataStore.get(CLIENT_ID, 'acc-linked')).resolves.toMatchObject({
      linkedClientAccountId: undefined,
    });
    await expect(metadataStore.listByLinkedClientAccountId(CLIENT_ID, 'client-account-99')).resolves.toEqual([]);
  });

  it('returns the most recently seen active account, breaking ties by id', async () => {
    await db.run(sql.raw('DROP INDEX uniq_accounts_active_client'));

    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-a',
      label: 'Account A',
      metadata: {},
      active: true,
      detectedAt: 100,
      lastSeenAt: 2_000,
    });
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-b',
      label: 'Account B',
      metadata: {},
      active: true,
      detectedAt: 200,
      lastSeenAt: 2_000,
    });
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-c',
      label: 'Account C',
      metadata: {},
      active: true,
      detectedAt: 300,
      lastSeenAt: 3_000,
    });

    await expect(metadataStore.getActive(CLIENT_ID)).resolves.toMatchObject({ id: 'acc-c' });

    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-c',
      label: 'Account C',
      metadata: {},
      active: false,
      detectedAt: 300,
      lastSeenAt: 3_000,
    });

    await expect(metadataStore.getActive(CLIENT_ID)).resolves.toMatchObject({ id: 'acc-b' });
  });

  it('preserves client ownership when an upsert hits an existing account id', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'shared-id',
      label: 'Original',
      metadata: { owner: CLIENT_ID },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await metadataStore.upsert('codex', {
      id: 'shared-id',
      label: 'Updated',
      metadata: { owner: 'codex' },
      active: false,
      detectedAt: 300,
      lastSeenAt: 400,
    });

    await expect(metadataStore.get(CLIENT_ID, 'shared-id')).resolves.toMatchObject({
      id: 'shared-id',
      label: 'Original',
      metadata: { owner: CLIENT_ID },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });
    await expect(metadataStore.get('codex', 'shared-id')).resolves.toBeNull();
  });

  it('advances metadata generation after metadata patches and rejects stale generations', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-generated',
      label: 'Generated',
      metadata: { planType: 'free', nested: { seats: 1, expiresAt: 99 } },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await expect(metadataStore.getWithMetadataGeneration(CLIENT_ID, 'acc-generated')).resolves.toMatchObject({
      metadataGeneration: 0,
      account: { metadata: { planType: 'free', nested: { seats: 1, expiresAt: 99 } } },
    });

    await expect(
      metadataStore.patchMetadata(CLIENT_ID, 'acc-generated', 0, {
        planType: 'plus',
        nested: { seats: 4, expiresAt: null },
      }),
    ).resolves.toMatchObject({
      metadata: { planType: 'plus', nested: { seats: 4 } },
    });

    await expect(metadataStore.getWithMetadataGeneration(CLIENT_ID, 'acc-generated')).resolves.toMatchObject({
      metadataGeneration: 1,
      account: { metadata: { planType: 'plus', nested: { seats: 4 } } },
    });
    await expect(metadataStore.bumpMetadataGeneration(CLIENT_ID, 'acc-generated')).resolves.toBe(2);
    await expect(
      metadataStore.patchMetadata(CLIENT_ID, 'acc-generated', 1, { rateLimitTier: 'team' }),
    ).resolves.toBeNull();
    await expect(metadataStore.getMetadataGeneration(CLIENT_ID, 'acc-generated')).resolves.toBe(2);
  });

  it('treats missing metadata-generation handlers as an absent optional storage seam', async () => {
    const unhandledStore = new BusAccountMetadataStore(createBusInstance());

    await expect(unhandledStore.bumpMetadataGeneration(CLIENT_ID, 'acc-missing')).resolves.toBeNull();
  });

  it('does not advance metadata generation for a semantic no-op nested patch', async () => {
    await metadataStore.upsert(CLIENT_ID, {
      id: 'acc-noop',
      label: 'Noop',
      metadata: { nested: { seats: 4 } },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await expect(
      metadataStore.patchMetadata(CLIENT_ID, 'acc-noop', 0, {
        nested: { seats: 4 },
      }),
    ).resolves.toMatchObject({
      metadata: { nested: { seats: 4 } },
    });
    await expect(metadataStore.getMetadataGeneration(CLIENT_ID, 'acc-noop')).resolves.toBe(0);
  });

  it('appends usage snapshots and reads them back in fetchedAt order', async () => {
    await expect(usageSnapshotStore.hasAnySnapshots()).resolves.toBe(false);

    await usageSnapshotStore.append(CLIENT_ID, 'acc-usage', {
      ts: 2_000,
      windowId: '7d',
      utilization: 30,
      resetsAt: 9_999,
      blocked: false,
    });
    await usageSnapshotStore.append(CLIENT_ID, 'acc-usage', {
      ts: 1_000,
      windowId: '5h',
      utilization: 60,
      resetsAt: 8_888,
      blocked: true,
    });

    expect(await usageSnapshotStore.hasAnySnapshots()).toBe(true);

    const entries = [];
    for await (const entry of usageSnapshotStore.read(CLIENT_ID, 'acc-usage', { from: 0, to: 5_000 })) {
      entries.push(entry);
    }

    expect(entries).toEqual([
      {
        ts: 1_000,
        windowId: '5h',
        utilization: 60,
        resetsAt: 8_888,
        blocked: true,
      },
      {
        ts: 2_000,
        windowId: '7d',
        utilization: 30,
        resetsAt: 9_999,
        blocked: false,
      },
    ]);
  });

  it('ignores duplicate usage snapshots on replay', async () => {
    const entry = {
      ts: 2_000,
      windowId: '5h',
      utilization: 60,
      resetsAt: 8_888,
      blocked: false,
    };

    await expect(usageSnapshotStore.append(CLIENT_ID, 'acc-usage', entry)).resolves.toBe(true);
    await expect(usageSnapshotStore.append(CLIENT_ID, 'acc-usage', entry)).resolves.toBe(false);

    const entries = [];
    for await (const snapshot of usageSnapshotStore.read(CLIENT_ID, 'acc-usage', { from: 0, to: 5_000 })) {
      entries.push(snapshot);
    }

    expect(entries).toEqual([entry]);
  });
});

describe('BusAccountMetadataStore optional generation handlers', () => {
  it('degrades to null when metadata generation handlers are not registered', async () => {
    const bus = createBusInstance();
    const metadataStore = new BusAccountMetadataStore(bus);

    await expect(metadataStore.getMetadataGeneration(CLIENT_ID, 'missing')).resolves.toBeNull();
    await expect(metadataStore.bumpMetadataGeneration(CLIENT_ID, 'missing')).resolves.toBeNull();
  });
});
