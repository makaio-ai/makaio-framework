import { createBusInstance } from '@makaio/bus-core';
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import {
  dep,
  type HostTransaction,
  type JournalEdgeCapability,
  type ReaderOutcome,
  type RecordEntryInput,
} from '@makaio/contracts';
import { JournalReprocessRequestSchema, JournalSubjects } from '@makaio/contracts/journal';
import {
  RightDenialReason,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  SubjectSendRightContextSchema,
  SubjectSubscribeRightContextSchema,
} from '@makaio/contracts/rights';
import { createBusNamespace, journalSubject } from '@makaio/core';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import {
  createJournalCapability,
  JournalContributionProcessor,
  JournalReaderService,
  JournalReaderStore,
  SubjectDirectory,
} from '@makaio/services-core/journal';
import {
  createHostDatabase,
  getDatabaseSignals,
  getTransactionQueryContext,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { eq, sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const extension = 'reader-conformance';
const subject = `${extension}.changed`;
const otherSubject = `${extension}.updated`;
const edgeName = `${extension}.inbound`;
const recorded = journalSubject(z.string(), {
  retention: 'recorded',
  schemaVersion: '1',
  readOlder: { kind: 'as-recorded' },
});
const namespace = createBusNamespace(extension, { changed: recorded, updated: recorded });
const leaseMs = 30_000;
const isCurrent = (): boolean => true;
const done = { state: 'done' } satisfies ReaderOutcome;

/**
 * Set up a real writer and reader against the migrated test database.
 * @param database - Isolated conformance database.
 * @param contributionsForRun - Optional reader and rights source contributions for live dispatch.
 * @param options - Additional extensions and control over reader startup.
 * @returns Reader store, writer, and access to side effects on a second connection.
 */
async function setup(
  database: StorageDatabaseContext,
  contributionsForRun?: Pick<KernelMakaioExtension, 'readers' | 'rightsSources'>,
  options: { additionalExtensions?: readonly KernelMakaioExtension[]; startReaders?: boolean } = {},
) {
  const host = createHostDatabase(database.db);
  const store = new JournalReaderStore(host);
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'journal-reader-test',
      tryImport: async () => null,
      /**
       * @param context - Shared context assembled by the coordinator.
       * @returns Full context with the writer's real host capabilities.
       */
      constructContext: (context) => ({
        ...context,
        database: host,
        journal: createJournalCapability({
          extension,
          bus: context.bus,
          host,
          subjects: directory,
          contributions,
          isActive: () => context.hasExtension(extension),
          startGate: { awaitOpen: async () => {}, isOwnStartRunning: () => false },
        }),
      }),
    },
  });
  const directory = new SubjectDirectory(bus, coordinator);
  const contributions = new JournalContributionProcessor(directory);
  const readers =
    contributionsForRun &&
    new JournalReaderService({
      bus,
      host,
      directory,
      ...coordinator.hostRights,
      bindCall: (caller, { principal, attestedBy }) =>
        mintCallContext({ caller, principal, ...(attestedBy === undefined ? {} : { attestedBy }) }),
    });
  let edge: JournalEdgeCapability | undefined;
  onTestFinished(async () => {
    try {
      await coordinator.shutdown();
    } finally {
      await readers?.destroy();
      await directory.destroy();
    }
  });
  await directory.init();
  coordinator.registerContributionProcessor(contributions);
  if (readers) {
    await readers.init();
    coordinator.registerContributionProcessor(readers);
  }
  coordinator.load([
    {
      name: extension,
      displayName: 'Journal reader fixture',
      version: '1.0.0',
      critical: true,
      namespaces: [namespace],
      edges: [{ edge: edgeName, description: 'Accept fixture entries', subjects: [subject, otherSubject] }],
      ...contributionsForRun,
      create: ({ journal }) => {
        edge = journal.edge(edgeName);
        return { init: async () => {}, destroy: () => {} };
      },
    },
    ...(options.additionalExtensions ?? []),
  ]);
  await coordinator.startAll();
  if (options.startReaders !== false) readers?.start();
  if (edge === undefined) throw new Error('The fixture edge did not start.');
  const sibling = await database.createSiblingClient();
  onTestFinished(() => sibling.close());
  const { kv } = resolveSchema(sibling.db, fixtureKv);
  return {
    bus,
    store,
    coordinator,
    readers,
    peer: new JournalReaderStore(createHostDatabase(sibling.db)),
    edge,
    /**
     * Read an effect via the independent database client.
     * @param id - Effect identifier.
     * @returns Committed values of that effect.
     */
    effects: (id: string) => sibling.db.select({ label: kv.label }).from(kv).where(eq(kv.id, id)),
  };
}

/**
 * Prepare a journal entry for the fixture writer.
 * @param key - Unique entry key, also used as payload.
 * @param orderKey - Optional sequencing key.
 * @param name - The recorded subject.
 * @returns Entry accepted through the fixture's edge.
 */
function entry(key: string, orderKey?: string, name = subject): RecordEntryInput {
  return { key, payload: key, subject: name, orderKey };
}

/**
 * Write an effect through the transaction supplied to the reader.
 * @param tx - Reader transaction.
 * @param id - Entry receiving the effect.
 * @param label - Attempt label written as the effect.
 */
async function writeEffect(tx: HostTransaction, id: string, label: string): Promise<void> {
  const query = getTransactionQueryContext(tx);
  const { kv } = resolveSchema(query, fixtureKv);
  await query.insert(kv).values({ id, label });
}

/**
 * Claim the next entry and assert its identity.
 * @param store - Active store for this attempt.
 * @param reader - Reader claiming the entry.
 * @param key - Expected entry key.
 * @param ttl - Claim duration in milliseconds.
 * @returns The claim for further assertions or settlement.
 */
async function claimEntry(store: JournalReaderStore, reader: string, key: string, ttl = leaseMs) {
  const claim = await store.claim(reader, ttl);
  expect(claim?.entry.key).toBe(key);
  if (claim === undefined) throw new Error('Expected a journal claim.');
  return claim;
}

/**
 * Verify reader cursors and selection continuity using both connections.
 * @param getDatabase - Migrated database for each test.
 */
function testSelection(getDatabase: () => StorageDatabaseContext): void {
  it('stops admitting between batches and resumes from the stored frontier', async () => {
    const { store, edge, peer } = await setup(getDatabase());
    const reader = `${extension}.admission-stop`;
    const batchSize = 64;
    const entries = await edge.accept({
      entries: Array.from({ length: batchSize + 1 }, (_, index) => entry(`admission-${index}`)),
    });
    await store.initialize(reader, 'beginning');

    let remainingBatches = 1;
    await store.admit(reader, [subject], () => remainingBatches-- > 0);
    const admitted = await peer.getReaderStates({ reader, limit: batchSize + 1 });
    expect(admitted.states).toHaveLength(batchSize);
    expect(admitted.states.map(({ entryId }) => entryId)).not.toContain(entries.at(-1)?.entryId);

    await peer.admit(reader, [subject]);
    const resumed = await store.getReaderStates({ reader, limit: batchSize + 1 });
    expect(resumed.states.map(({ entryId }) => entryId)).toEqual(entries.map(({ entryId }) => entryId));
  });

  it('initializes now once, catches up after a restart and uses the changed pattern', async () => {
    const { store, edge, peer } = await setup(getDatabase());
    const reader = `${extension}.restart`;
    await edge.accept({ entries: [entry('restart-before')] });
    await store.initialize(reader, 'now');
    await edge.accept({
      entries: [entry('restart-first'), entry('restart-unmatched', undefined, otherSubject)],
    });
    await store.admit(reader, [subject]);
    await store.settle(await claimEntry(store, reader, 'restart-first'), done, isCurrent);

    await edge.accept({ entries: [entry('restart-after', undefined, otherSubject)] });
    await peer.initialize(reader, 'beginning');
    await peer.admit(reader, [otherSubject]);
    const resumed = await claimEntry(peer, reader, 'restart-after');
    await peer.settle(resumed, done, isCurrent);
    expect(await peer.claim(reader, leaseMs)).toBeUndefined();

    const { states, nextCursor } = await peer.getReaderStates({ reader, limit: 1 });
    expect(states).toEqual([{ entryId: expect.any(String), position: expect.any(Number), state: 'done', retries: 0 }]);
    expect(typeof nextCursor).toBe('string');
    expect(await peer.getReaderStates({ reader, cursor: nextCursor })).toEqual({
      states: [{ entryId: resumed.entry.entryId, position: resumed.entry.position, state: 'done', retries: 0 }],
    });
  });

  it('keeps independent readers and runs unrelated keys while one key is leased', async () => {
    const { store, peer, edge } = await setup(getDatabase());
    const reader = `${extension}.ordering`;
    const independent = `${extension}.independent`;
    await store.initialize(reader, 'now');
    await store.initialize(independent, 'now');
    const key = 'ordered';
    await edge.accept({
      entries: [entry('order-first', key), entry('order-second', key), entry('order-other', 'other'), entry('unkeyed')],
    });
    await store.admit(reader, [subject]);
    await peer.admit(independent, [subject]);

    const first = await claimEntry(store, reader, 'order-first');
    const other = await claimEntry(peer, reader, 'order-other');
    await peer.settle(other, done, isCurrent);
    await claimEntry(peer, reader, 'unkeyed');
    await claimEntry(peer, independent, 'order-first');
    expect(await store.claim(reader, leaseMs)).toBeUndefined();
    await store.settle(first, done, isCurrent);
    await claimEntry(peer, reader, 'order-second');
  });

  it('orders current matches and waits for a claim held under a previous pattern', async () => {
    const { store, peer, edge } = await setup(getDatabase());
    const reader = `${extension}.pattern-ordering`;
    const key = 'pattern-change';
    await store.initialize(reader, 'now');
    await edge.accept({ entries: [entry('old-pattern', key)] });
    await store.admit(reader, [subject]);
    const first = await claimEntry(store, reader, 'old-pattern');

    const patterns = [otherSubject];
    await edge.accept({ entries: [entry('after-pattern-change', key, otherSubject)] });
    await peer.admit(reader, patterns);
    expect(await peer.claim(reader, leaseMs, patterns)).toBeUndefined();
    const notBefore = new Date(Date.now() + 60_000).toISOString();
    await store.settle(first, { state: 'retry', reason: 'deferred', notBefore }, isCurrent);
    expect(await peer.claim(reader, leaseMs, [subject, otherSubject])).toBeUndefined();
    expect((await peer.claim(reader, leaseMs, patterns))?.entry.key).toBe('after-pattern-change');
  });
}

/**
 * Verify durable claim fences and effect rollback across two database clients.
 * @param getDatabase - Migrated database for each test.
 */
function testSettlement(getDatabase: () => StorageDatabaseContext): void {
  it('grants only one live claim to simultaneous contenders', async () => {
    const database = getDatabase();
    const { store, peer, edge } = await setup(database);
    const reader = `${extension}.contended`;
    await store.initialize(reader, 'now');
    await edge.accept({ entries: [entry('exclusive')] });
    await store.admit(reader, [subject]);
    // SQLite serializes asynchronous transactions on a single handle. The
    // second SQLite connection is used in the cross-connection expiry case.
    const rival = database.dialect === 'postgres' ? peer : store;
    const contenders = await Promise.all([store.claim(reader, leaseMs), rival.claim(reader, leaseMs)]);
    expect(contenders.filter((claim) => claim !== undefined).map(({ entry }) => entry.key)).toEqual(['exclusive']);
  });

  it('reclaims an expired attempt and books the replacement effect at most once', async () => {
    const { store, peer, edge, effects } = await setup(getDatabase());
    const reader = `${extension}.lease`;
    await store.initialize(reader, 'now');
    await edge.accept({ entries: [entry('expiring')] });
    await store.admit(reader, [subject]);
    const stale = await claimEntry(store, reader, 'expiring', 100);
    const { entryId } = stale.entry;
    await delay(Math.max(0, stale.expiresAt - Date.now() + 1));
    // Discovering the expired lease also schedules its retry backoff.
    let live = await peer.claim(reader, leaseMs);
    while (live === undefined) {
      const due = await peer.nextDue(reader);
      if (due === undefined) throw new Error('An expired attempt has no scheduled retry.');
      await delay(Math.max(0, due - Date.now() + 1));
      live = await peer.claim(reader, leaseMs);
    }
    expect(live.entry.entryId).toBe(entryId);
    let staleCalls = 0;
    await store.settle(
      stale,
      {
        state: 'done',
        commit: async (tx) => {
          staleCalls++;
          await writeEffect(tx, entryId, 'stale');
        },
      },
      isCurrent,
    );
    expect(staleCalls).toBe(0);
    expect(await effects(entryId)).toEqual([]);
    const complete: ReaderOutcome = { state: 'done', commit: (tx) => writeEffect(tx, entryId, 'live') };
    await peer.settle(live, complete, isCurrent);
    await peer.settle(live, complete, isCurrent);
    expect(await effects(entryId)).toEqual([{ label: 'live' }]);
    expect(await store.getReaderStates({ reader, entryId })).toMatchObject({ states: [{ state: 'done', retries: 1 }] });
  });

  it('rolls back a permanently failed commit, frees the next entry and allows targeted reprocess', async () => {
    const reader = `${extension}.failure`;
    let approvedEntryId: string | undefined;
    const { bus, store, peer, edge, effects } = await setup(getDatabase(), {
      rightsSources: [
        {
          source: `${extension}.reprocess-policy`,
          description: 'Authorize reprocessing only for the specified reader and entry.',
          rights: [SUBJECT_SEND_RIGHT],
          requiresPayload: [SUBJECT_SEND_RIGHT],
          async answer({ context }) {
            const { payload } = SubjectSendRightContextSchema.parse(context);
            const target = JournalReprocessRequestSchema.safeParse(payload);
            const approved = target.success && target.data.reader === reader && target.data.entryId === approvedEntryId;
            return approved ? { granted: true } : { granted: false, reason: 'target-denied' };
          },
        },
      ],
    });
    await store.initialize(reader, 'now');
    await edge.accept({ entries: [entry('failed', 'chain'), entry('after-failed', 'chain')] });
    await store.admit(reader, [subject]);
    const claim = await claimEntry(store, reader, 'failed');
    const { entryId } = claim.entry;
    await store.settle(
      claim,
      {
        state: 'done',
        async commit(tx) {
          await writeEffect(tx, entryId, 'discarded');
          return { state: 'failed', reason: 'permanent' };
        },
      },
      isCurrent,
    );
    expect(await effects(entryId)).toEqual([]);
    expect(await peer.getReaderStates({ reader, state: 'failed' })).toMatchObject({
      states: [{ entryId, state: 'failed', reason: 'permanent' }],
    });
    const following = await claimEntry(peer, reader, 'after-failed');
    approvedEntryId = entryId;
    await expect(bus.request(JournalSubjects.reprocess, { reader, entryId: following.entry.entryId })).rejects.toThrow(
      'target-denied',
    );
    await expect(bus.request(JournalSubjects.reprocess, { reader, entryId })).resolves.toEqual({
      success: true,
      status: 'requeued',
    });
    expect(await store.claim(reader, leaseMs)).toBeUndefined();
    await peer.settle(following, done, isCurrent);
    await expect(peer.reprocess({ reader, entryId: following.entry.entryId })).resolves.toEqual({
      success: false,
      code: 'not-failed',
    });
    await expect(peer.reprocess({ reader, entryId: 'missing' })).resolves.toEqual({
      success: false,
      code: 'not-found',
    });
    const replay = await claimEntry(peer, reader, 'failed');
    await peer.settle(replay, { state: 'done', commit: (tx) => writeEffect(tx, entryId, 'replayed') }, isCurrent);
    expect(await effects(entryId)).toEqual([{ label: 'replayed' }]);
  });
}

/**
 * Verify durable retry scheduling and ordering of successors.
 * @param getDatabase - Migrated database for the test.
 */
function testRetry(getDatabase: () => StorageDatabaseContext): void {
  it('recovers the persisted due time after a transient selection failure', async () => {
    const reader = `${extension}.selection-retry`;
    const database = getDatabase();
    const { store, edge, readers } = await setup(
      database,
      {
        readers: [
          {
            reader,
            description: 'Handle work after the selection retry.',
            subjects: () => [subject],
            async handle() {
              return done;
            },
          },
        ],
      },
      { startReaders: false },
    );
    if (readers === undefined) throw new Error('The fixture reader service was not created.');
    const signals = getDatabaseSignals(database.db);
    let notifications = 0;
    if (signals.kind === 'database-notify') {
      onTestFinished(
        signals.subscribe((signal) => {
          if (signal.kind === 'topic') notifications++;
        }),
      );
      await signals.ready();
    }
    await store.initialize(reader, 'now');
    await edge.accept({ entries: [entry('selection-retry')] });
    await store.admit(reader, [subject]);
    const claim = await claimEntry(store, reader, 'selection-retry');
    const notBefore = new Date(Date.now() + 1_500).toISOString();
    await store.settle(claim, { state: 'retry', reason: 'deferred', notBefore }, isCurrent);
    // Let the append and settlement notifications reach the disabled service before startup.
    if (signals.kind === 'database-notify') {
      await vi.waitFor(() => expect(notifications).toBeGreaterThanOrEqual(2));
    }

    const nextDue = vi.spyOn(JournalReaderStore.prototype, 'nextDue');
    nextDue.mockRejectedValueOnce(new Error('Temporary read failure'));
    onTestFinished(() => nextDue.mockRestore());
    readers.start();

    await vi.waitFor(
      async () => {
        expect(await store.getReaderStates({ reader, entryId: claim.entry.entryId })).toMatchObject({
          states: [{ state: 'done', retries: 1 }],
        });
      },
      { timeout: 4_000 },
    );
    expect(nextDue.mock.calls.length).toBeGreaterThan(1);
  });

  it('preserves a retry notBefore and leaves unrelated entries claimable', async () => {
    const { store, peer, edge, effects } = await setup(getDatabase());
    const reader = `${extension}.retry`;
    await store.initialize(reader, 'now');
    await edge.accept({
      entries: [
        entry('deferral', 'retry'),
        entry('behind-deferral', 'retry'),
        entry('throwing', 'throwing'),
        entry('behind-throwing', 'throwing'),
      ],
    });
    await store.admit(reader, [subject]);
    const claim = await claimEntry(store, reader, 'deferral');
    const notBefore = new Date(Date.now() + 60_000).toISOString();
    await store.settle(claim, { state: 'retry', reason: 'deferred', notBefore }, isCurrent);
    expect(await peer.getReaderStates({ reader, entryId: claim.entry.entryId })).toMatchObject({
      states: [{ state: 'open', retries: 1, reason: 'deferred', notBefore }],
    });

    const throwing = await claimEntry(peer, reader, 'throwing', 120_000);
    expect(await store.claim(reader, leaseMs)).toBeUndefined();
    const due = await peer.nextDue(reader);
    expect(due).toBeGreaterThan(Date.parse(notBefore) - 5_000);
    expect(due).toBeLessThan(Date.parse(notBefore) + 5_000);
    await peer.settle(
      throwing,
      {
        state: 'done',
        async commit(tx) {
          await writeEffect(tx, throwing.entry.entryId, 'rolled-back');
          throw new Error('Retry this commit');
        },
      },
      isCurrent,
    );
    expect(await effects(throwing.entry.entryId)).toEqual([]);
    expect(await store.getReaderStates({ reader, entryId: throwing.entry.entryId })).toMatchObject({
      states: [{ state: 'open', retries: 1, notBefore: expect.any(String) }],
    });
  });
}

/**
 * Verify bounded paging and authorization against recorded entries.
 * @param getDatabase - Migrated database for the test.
 */
function testReadEntries(getDatabase: () => StorageDatabaseContext): void {
  it('continues after the last returned row and omits denied entries', async () => {
    const { store, edge } = await setup(getDatabase());
    const mayRead = async ({ key }: { key: string }): Promise<boolean> => key.startsWith('page-visible-');
    const rows = await edge.accept({
      entries: [
        entry('page-visible-one'),
        entry('page-hidden-middle'),
        entry('page-visible-two'),
        entry('page-hidden-last'),
      ],
    });
    const first = await store.readEntries({ subject, limit: 1 }, mayRead);
    expect(first.entries.map(({ key }) => key)).toEqual(['page-visible-one']);
    expect(typeof first.nextCursor).toBe('string');
    const last = await store.readEntries(
      { subject, limit: 1, cursor: first.nextCursor, from: Number.MAX_SAFE_INTEGER },
      mayRead,
    );
    expect(last.entries.map(({ key }) => key)).toEqual(['page-visible-two']);
    expect(last.nextCursor).toBeUndefined();

    const denied = rows[1];
    if (denied === undefined) throw new Error('The fixture did not record the denied entry.');
    expect(await store.readEntries({ entryId: denied.entryId }, mayRead)).toEqual({ entries: [] });
  });
}

/**
 * Exercise reservation and release through the real extension lifecycle.
 * @param getDatabase - Migrated database for the test.
 */
function testReaderOwnership(getDatabase: () => StorageDatabaseContext): void {
  it('reserves a reader name across extension activations until its owner stops', async () => {
    const reader = 'a.b.jobs';
    const handled: { owner: string; key: string }[] = [];
    const additionalExtensions: KernelMakaioExtension[] = ['a', 'a.b'].map((owner) => ({
      name: owner,
      displayName: owner,
      version: '1.0.0',
      ...(owner === 'a.b' && { dependencies: [dep('a', '^1.0.0', true)] }),
      readers: [
        {
          reader,
          description: 'Process recorded entries.',
          startAt: 'now',
          subjects: () => [subject],
          async handle(_call, recordedEntry) {
            handled.push({ owner, key: recordedEntry.key });
            return done;
          },
        },
      ],
    }));
    const { coordinator, edge, store } = await setup(getDatabase(), {}, { additionalExtensions });
    expect(coordinator.getInfo('a')).toMatchObject({ state: 'active' });
    expect(coordinator.getInfo('a.b')).toMatchObject({
      state: 'failed',
      error: 'duplicate-reader: extension "a.b", contribution "a.b.jobs": Extension "a" already declares this reader',
    });

    await edge.accept({ entries: [entry('first-owner')] });
    await vi.waitFor(async () => {
      const { states } = await store.getReaderStates({ reader });
      expect(states).toMatchObject([{ state: 'done' }]);
    });
    expect(handled).toEqual([{ owner: 'a', key: 'first-owner' }]);

    expect(await coordinator.applyExtensionTransition('a', false)).toBe('applied');
    expect(await coordinator.applyExtensionTransition('a.b', true)).toBe('applied');
    await edge.accept({ entries: [entry('next-owner')] });
    await vi.waitFor(() =>
      expect(handled).toEqual([
        { owner: 'a', key: 'first-owner' },
        { owner: 'a.b', key: 'next-owner' },
      ]),
    );
  });
}

/**
 * Verify that the real rights resolver controls durable reader settlement.
 * @param getDatabase - Migrated database for the test.
 */
function testReaderAuthorization(getDatabase: () => StorageDatabaseContext): void {
  it.each(['throws', 'times out'] as const)('retries when an answer source %s', {
    timeout: 15_000,
  }, async (failure) => {
    const key = failure === 'throws' ? 'unavailable-throw' : 'unavailable-timeout';
    const reader = `${extension}.${key}`;
    const handled: string[] = [];
    let attempts = 0;
    const { store, edge } = await setup(getDatabase(), {
      readers: [
        {
          reader,
          description: 'Check authorization before handling a recorded entry.',
          subjects: () => [subject],
          async handle(_call, recordedEntry) {
            handled.push(recordedEntry.key);
            return done;
          },
        },
      ],
      rightsSources: [
        {
          source: `${extension}.read-policy`,
          description: 'Reject one entry and fail to answer the first question about another.',
          rights: [SUBJECT_SUBSCRIBE_RIGHT],
          async answer({ context }) {
            const { payload } = SubjectSubscribeRightContextSchema.parse(context);
            if (payload === `${key}-denied`) return { granted: false, reason: 'policy-denied' };
            if (payload === key && ++attempts === 1) {
              if (failure === 'throws') throw new Error('Source unavailable.');
              return new Promise<never>(() => {});
            }
            return { granted: true };
          },
        },
      ],
    });
    const [unavailable, denied] = await edge.accept({ entries: [entry(key), entry(`${key}-denied`)] });
    if (unavailable === undefined || denied === undefined) throw new Error('The fixture entries were not recorded.');
    await vi.waitFor(
      async () => {
        const { states } = await store.getReaderStates({ reader, entryId: unavailable.entryId });
        expect(states).toMatchObject([
          {
            state: 'open',
            reason: RightDenialReason.sourceUnavailable,
            retries: 1,
            notBefore: expect.any(String),
          },
        ]);
      },
      { timeout: 8_000 },
    );
    expect(handled).toEqual([]);
    await vi.waitFor(
      async () => {
        const { states } = await store.getReaderStates({ reader });
        expect(states).toMatchObject([
          { entryId: unavailable.entryId, state: 'done', retries: 1 },
          { entryId: denied.entryId, state: 'done', reason: 'access-denied', retries: 0 },
        ]);
      },
      { timeout: 4_000 },
    );
    expect(handled).toEqual([key]);
  });
}

describeStorageConformance('journal readers', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);

  beforeAll(async () => {
    await getDatabase().executor.run(sql.raw(fixtureKvDdl(config.dialect)));
  });

  testSelection(getDatabase);
  testSettlement(getDatabase);
  testRetry(getDatabase);
  testReadEntries(getDatabase);
  testReaderOwnership(getDatabase);
  testReaderAuthorization(getDatabase);
});
