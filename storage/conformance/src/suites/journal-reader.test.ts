import { createBusInstance } from '@makaio/bus-core';
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import {
  defineReaction,
  dep,
  type HostDatabase,
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
import { createBusNamespace, journalSubject, MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import type { RuleSourceContribution } from '@makaio/contracts/rules';
import { ExtensionCoordinator, type ContributionProcessor, type KernelMakaioExtension } from '@makaio/kernel';
import {
  createJournalCapability,
  JournalContributionProcessor,
  JournalReaderService,
  JournalReaderStore,
  SubjectDirectory,
} from '@makaio/services-core/journal';
import { journalStorageSchema } from '@makaio/services-core/journal/storage';
import {
  busMessageTrigger,
  createRuleJournalReader,
  RuleEvaluator,
  startRuleJournalEvaluation,
} from '@makaio/services-core';
import {
  createHostDatabase,
  getDatabaseSignals,
  getHostDatabaseWake,
  getTransactionQueryContext,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { eq, inArray, sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from '../../../../services/core/src/journal/storage/append-entries.js';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { waitForWakeFence } from '../harness/wake-fence.js';
import { contributions, read, ruleFor } from './rules-evaluation-support.js';

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
  options: {
    additionalExtensions?: readonly KernelMakaioExtension[];
    additionalProcessor?: ContributionProcessor;
    startReaders?: boolean;
    hostReader?: ConstructorParameters<typeof JournalReaderService>[0]['hostReader'];
    host?: HostDatabase;
  } = {},
) {
  const host = options.host ?? createHostDatabase(database.db);
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
      hostReader: options.hostReader,
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
  if (options.additionalProcessor) coordinator.registerContributionProcessor(options.additionalProcessor);
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
    host,
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
    await store.initialize(extension, [{ reader, startAt: 'beginning' }]);

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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
    await edge.accept({
      entries: [entry('restart-first'), entry('restart-unmatched', undefined, otherSubject)],
    });
    await store.admit(reader, [subject]);
    await store.settle(await claimEntry(store, reader, 'restart-first'), done, isCurrent);

    await edge.accept({ entries: [entry('restart-after', undefined, otherSubject)] });
    await peer.initialize(extension, [{ reader, startAt: 'beginning' }]);
    await peer.admit(reader, [otherSubject]);
    const resumed = await claimEntry(peer, reader, 'restart-after');
    await peer.settle(resumed, done, isCurrent);
    expect(await peer.claim(reader, leaseMs)).toBeUndefined();

    const { states, nextCursor } = await peer.getReaderStates({ reader, limit: 1 });
    expect(states).toEqual([{ entryId: expect.any(String), position: expect.any(Number), state: 'done', retries: 0 }]);
    expect(typeof nextCursor).toBe('string');
    expect(await peer.getReaderStates({ reader, cursor: nextCursor })).toEqual({
      readerPosition: resumed.entry.position,
      states: [{ entryId: resumed.entry.entryId, position: resumed.entry.position, state: 'done', retries: 0 }],
    });
  });

  it('returns the saved position even when a reader state filter finds no match', async () => {
    const { store, edge, peer } = await setup(getDatabase());
    const reader = `${extension}.filtered`;
    const [{ entryId }] = await edge.accept({ entries: [entry('before-reader')] });
    const start = await store.head();
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
    await expect(peer.getReaderStates({ reader, entryId })).resolves.toEqual({ readerPosition: start, states: [] });
    await expect(peer.getReaderStates({ reader: `${extension}.missing` })).resolves.toEqual({ states: [] });
    await edge.accept({ entries: [entry('after-reader')] });
    await store.admit(reader, [subject]);
    await expect(peer.getReaderStates({ reader, state: 'failed' })).resolves.toEqual({
      readerPosition: start + 1,
      states: [],
    });
  });

  it('keeps independent readers and runs unrelated keys while one key is leased', async () => {
    const { store, peer, edge } = await setup(getDatabase());
    const reader = `${extension}.ordering`;
    const independent = `${extension}.independent`;
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
    await store.initialize(extension, [{ reader: independent, startAt: 'now' }]);
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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
    const { host, store, edge, readers } = await setup(
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
      await waitForWakeFence(host, signals);
      notifications = 0;
    }
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
    await store.initialize(extension, [{ reader, startAt: 'now' }]);
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
  it('resumes only for the stored owner after restarting the coordinator', async () => {
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
    const database = getDatabase();
    const { coordinator, edge, store, readers } = await setup(database, {}, { additionalExtensions });
    expect(coordinator.getInfo('a')).toMatchObject({ state: 'active' });
    expect(coordinator.getInfo('a.b')).toMatchObject({
      state: 'failed',
      error: 'duplicate-reader: extension "a.b", contribution "a.b.jobs": Extension "a" already declares this reader',
    });

    const [first] = await edge.accept({ entries: [entry('first-owner')] });
    await vi.waitFor(async () => {
      const { states } = await store.getReaderStates({ reader });
      expect(states).toMatchObject([{ state: 'done' }]);
    });
    expect(handled).toEqual([{ owner: 'a', key: 'first-owner' }]);

    await coordinator.shutdown();
    await readers?.destroy();
    const [owner, claimant] = additionalExtensions;
    if (owner === undefined || claimant === undefined) throw new Error('Missing fixture extensions.');
    const foreign = await setup(database, {}, { additionalExtensions: [{ ...claimant, dependencies: [] }] });
    expect(foreign.coordinator.getInfo('a.b')).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('reader-owner-conflict'),
    });
    const [second] = await foreign.edge.accept({ entries: [entry('same-owner-resume')] });
    expect((await foreign.store.getReaderStates({ reader })).states).toHaveLength(1);
    const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
    if (!first || !second) throw new Error('Expected recorded entries.');
    const [firstEntry] = (await store.readEntries({ entryId: first.entryId }, async () => true)).entries;
    const [secondEntry] = (await store.readEntries({ entryId: second.entryId }, async () => true)).entries;
    const before = await database.db.select().from(cursors).where(eq(cursors.reader, reader));
    expect(before).toMatchObject([{ owner: 'a', position: firstEntry?.position }]);

    await setup(database, {}, { additionalExtensions: [owner] });
    await vi.waitFor(() =>
      expect(handled).toEqual([
        { owner: 'a', key: 'first-owner' },
        { owner: 'a', key: 'same-owner-resume' },
      ]),
    );
    const after = await database.db.select().from(cursors).where(eq(cursors.reader, reader));
    expect(after).toMatchObject([{ owner: 'a', position: secondEntry?.position }]);
  });
}

/** @param getDatabase - Migrated database for the activation test. */
function testReaderDeclarationSnapshot(getDatabase: () => StorageDatabaseContext): void {
  describe('reader declaration snapshot', () => {
    const owner = 'reader-declaration';
    const reader = `${owner}.verified`;
    const foreign = 'another-reader.legacy';
    let fixture: Awaited<ReturnType<typeof setup>>;

    beforeEach(async () => {
      const database = getDatabase();
      const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
      await database.db.insert(cursors).values({ reader: foreign, position: 0 });
      const declaration = new (class {
        public reader = reader;
        public readonly description = 'Process recorded entries.';
        public readonly startAt = 'beginning';
        private readonly pattern = subject;

        public subjects() {
          return [this.pattern];
        }

        public async handle() {
          return done;
        }
      })();
      const manifest: KernelMakaioExtension = {
        name: owner,
        displayName: 'Journal reader declaration',
        version: '1.0.0',
        readers: [declaration],
        create: () => ({
          async init() {
            declaration.reader = foreign;
          },
          destroy() {},
        }),
      };
      fixture = await setup(database, {}, { additionalExtensions: [manifest], startReaders: false });
    });

    it('reserves the validated name when extension initialization mutates the declaration', async () => {
      const { db } = getDatabase();
      const { journalReaderCursors: cursors } = resolveSchema(db, journalStorageSchema);
      expect(fixture.coordinator.getInfo(owner)).toMatchObject({ state: 'active' });
      expect(await db.select().from(cursors).where(eq(cursors.reader, reader))).toEqual([
        { reader, owner, position: 0, reservationToken: expect.any(String) },
      ]);
      expect(await db.select().from(cursors).where(eq(cursors.reader, foreign))).toEqual([
        { reader: foreign, owner: null, position: 0, reservationToken: null },
      ]);
    });
  });
}

/**
 * Declare fixture readers that report each entry handed to them.
 * @param owner - Declaring extension.
 * @param names - Exact names of its readers.
 * @param handleKey - Observe the key passed to the handler.
 * @returns Extension ready to load into a coordinator.
 */
function readerExtension(
  owner: string,
  names: readonly string[],
  handleKey: (key: string) => void,
): KernelMakaioExtension {
  return {
    name: owner,
    displayName: owner,
    version: '1.0.0',
    readers: names.map((reader) => ({
      reader,
      description: 'Process recorded entries.',
      startAt: 'now',
      subjects: () => [subject],
      async handle(_call, recordedEntry) {
        handleKey(recordedEntry.key);
        return done;
      },
    })),
  };
}

/**
 * Verify that an upgraded cursor participates in the actual activation lifecycle.
 * @param getDatabase - Migrated database for the test.
 */
function testLegacyReaderOwnership(getDatabase: () => StorageDatabaseContext): void {
  const reader = 'legacy.reader.jobs';
  const related = `${reader}.other`;
  const owner = 'legacy.reader';
  let fixture: Awaited<ReturnType<typeof setup>>;
  let position: number;
  let received: PromiseWithResolvers<string>;

  describe('legacy reader ownership', () => {
    beforeEach(async () => {
      const database = getDatabase();
      const writer = await setup(database);
      await writer.edge.accept({ entries: [entry('legacy-prefix')] });
      position = await writer.store.head();
      await writer.edge.accept({ entries: [entry('legacy-unread', 'legacy-stream')] });
      const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
      await database.db.insert(cursors).values([
        { reader, position },
        { reader: related, position },
      ]);
      received = Promise.withResolvers<string>();
      fixture = await setup(
        database,
        {},
        { additionalExtensions: [readerExtension(owner, [reader], received.resolve)], startReaders: false },
      );
    });

    it('adopts by exact name, runs from the saved position, and rejects a later foreign owner', async () => {
      const database = getDatabase();
      const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
      const rows = () => database.db.select().from(cursors).where(eq(cursors.reader, reader));
      expect(fixture.coordinator.getInfo(owner)).toMatchObject({ state: 'active' });
      expect(await rows()).toEqual([{ reader, owner, position, reservationToken: expect.any(String) }]);
      expect(await database.db.select().from(cursors).where(eq(cursors.reader, related))).toEqual([
        { reader: related, owner: null, position, reservationToken: null },
      ]);
      fixture.readers?.start();
      expect(await received.promise).toBe('legacy-unread');
      await fixture.coordinator.shutdown();
      const before = await rows();

      const foreign = await setup(
        database,
        {},
        { additionalExtensions: [readerExtension('legacy', [reader], received.resolve)] },
      );
      expect(foreign.coordinator.getInfo('legacy')).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('reader-owner-conflict'),
      });
      expect(await rows()).toEqual(before);
    });
  });

  it('lets exactly one concurrent claimant adopt the same unowned cursor', async () => {
    const database = getDatabase();
    const reader = 'concurrent.reader.jobs';
    const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
    const { edge, store, peer } = await setup(database);
    await edge.accept({ entries: [entry('concurrent-prefix')] });
    const position = await store.head();
    await database.db.insert(cursors).values({ reader, position });
    // SQLite has one host; PostgreSQL also permits competing reservations from separate hosts.
    const secondHost = database.dialect === 'postgres' ? peer : store;
    const outcomes = await Promise.allSettled([
      store.initialize('concurrent', [{ reader, startAt: 'beginning' }]),
      secondHost.initialize('concurrent.reader', [{ reader, startAt: 'now' }]),
    ]);
    const owner = outcomes[0]?.status === 'fulfilled' ? 'concurrent' : 'concurrent.reader';
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toEqual([
      {
        status: 'fulfilled',
        value: [{ reader, owner, position, change: { kind: 'adopted', token: expect.any(String) } }],
      },
    ]);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'reader-owner-conflict' },
    });
    expect(await database.db.select().from(cursors).where(eq(cursors.reader, reader))).toEqual([
      { reader, owner, position, reservationToken: expect.any(String) },
    ]);
  });
}

/**
 * Verify compensation when another contribution processor prevents activation.
 * @param getDatabase - Migrated database for the test.
 */
function testReaderActivationRollback(getDatabase: () => StorageDatabaseContext): void {
  it('removes a new cursor, releases an adopted cursor, and keeps a cursor already owned', async () => {
    const database = getDatabase();
    const owner = 'rollback';
    const created = 'rollback.child.new';
    const adopted = 'rollback.adopted';
    const owned = 'rollback.owned';
    const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
    const writer = await setup(database);
    const position = await writer.store.head();
    await database.db.insert(cursors).values([
      { reader: adopted, position },
      { reader: owned, owner, position },
    ]);
    await writer.edge.accept({ entries: [entry('rollback-before')] });
    const failed = await setup(
      database,
      {},
      {
        additionalExtensions: [readerExtension(owner, [created, adopted, owned], () => {})],
        additionalProcessor: {
          filter: (pkg) => pkg.name === owner,
          async processActivated() {
            throw new Error('Later contribution failed');
          },
        },
      },
    );
    expect(failed.coordinator.getInfo(owner)).toMatchObject({ state: 'failed', error: 'Later contribution failed' });
    expect(await database.db.select().from(cursors).where(eq(cursors.reader, created))).toEqual([]);
    expect(await database.db.select().from(cursors).where(eq(cursors.reader, adopted))).toEqual([
      { reader: adopted, owner: null, position, reservationToken: null },
    ]);
    expect(await database.db.select().from(cursors).where(eq(cursors.reader, owned))).toEqual([
      { reader: owned, owner, position, reservationToken: null },
    ]);

    const recoveredOwner = 'rollback.child';
    const received = Promise.withResolvers<string>();
    await writer.edge.accept({ entries: [entry('rollback-between', 'rollback-stream')] });
    const start = await writer.store.head();
    const recovered = await setup(
      database,
      {},
      {
        additionalExtensions: [readerExtension(recoveredOwner, [created], received.resolve)],
        startReaders: false,
      },
    );
    expect(recovered.coordinator.getInfo(recoveredOwner)).toMatchObject({ state: 'active' });
    expect(await database.db.select().from(cursors).where(eq(cursors.reader, created))).toEqual([
      { reader: created, owner: recoveredOwner, position: start, reservationToken: expect.any(String) },
    ]);
    recovered.readers?.start();
    await recovered.edge.accept({ entries: [entry('rollback-after', 'rollback-stream')] });
    expect(await received.promise).toBe('rollback-after');
  });
}

/** @param getDatabase - Migrated database shared by independent reader services. */
function testSharedReaderReservation(getDatabase: () => StorageDatabaseContext): void {
  const owner = 'shared-reader';
  const created = `${owner}.created`;
  const adopted = `${owner}.adopted`;

  it('keeps shared new and legacy cursors when the first activation fails', async () => {
    const database = getDatabase();
    const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
    const writer = await setup(database);
    await writer.edge.accept({ entries: [entry('shared-prefix')] });
    const position = await writer.store.head();
    await database.db.insert(cursors).values({ reader: adopted, position });
    const peer = await database.createSiblingClient();
    const reserved = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const handled: string[] = [];
    const first = setup(
      database,
      {},
      {
        additionalExtensions: [readerExtension(owner, [created, adopted], () => {})],
        additionalProcessor: {
          filter: (pkg) => pkg.name === owner,
          async processActivated() {
            reserved.resolve();
            await fail.promise;
            throw new Error('Later contribution failed on the first host');
          },
        },
      },
    );
    try {
      await Promise.race([
        reserved.promise,
        first.then(() => {
          throw new Error('Expected a staged activation');
        }),
      ]);
      const second = await setup(
        database,
        {},
        {
          host: createHostDatabase(peer.db),
          // SQLite exercises overlapping reservations but only runs one reader service at a time.
          startReaders: database.dialect === 'postgres',
          additionalExtensions: [
            readerExtension(owner, [created, adopted], (key) => {
              handled.push(key);
              if (handled.length === 2) received.resolve();
            }),
          ],
        },
      );
      expect(second.coordinator.getInfo(owner)).toMatchObject({ state: 'active' });
      fail.resolve();
      expect((await first).coordinator.getInfo(owner)).toMatchObject({
        state: 'failed',
        error: 'Later contribution failed on the first host',
      });
      const shared = await peer.db
        .select()
        .from(cursors)
        .where(inArray(cursors.reader, [adopted, created]))
        .orderBy(cursors.reader);
      expect(shared).toEqual([
        { reader: adopted, owner, position, reservationToken: null },
        { reader: created, owner, position, reservationToken: null },
      ]);
      await second.edge.accept({ entries: [entry('shared-unread')] });
      if (database.dialect === 'sqlite') second.readers?.start();
      await received.promise;
      expect(handled).toEqual(['shared-unread', 'shared-unread']);
    } finally {
      fail.resolve();
      await first;
    }
  });

  it('recovers a missing cursor at its saved start instead of skipping unread entries', async () => {
    const database = getDatabase();
    const name = `${owner}.restored`;
    const { journalReaderCursors: cursors } = resolveSchema(database.db, journalStorageSchema);
    const writer = await setup(database);
    await writer.edge.accept({ entries: [entry('restore-prefix')] });
    const received = Promise.withResolvers<string>();
    const reader = await setup(
      database,
      {},
      {
        additionalExtensions: [readerExtension(owner, [name], received.resolve)],
        startReaders: false,
      },
    );
    const position = await writer.store.head();
    await writer.host.transaction(async (tx) => {
      await getTransactionQueryContext(tx).delete(cursors).where(eq(cursors.reader, name));
    });
    await expect(writer.peer.claim(name, leaseMs, [subject], undefined, owner)).rejects.toMatchObject({
      code: 'reader-cursor-lost',
    });
    await writer.edge.accept({ entries: [entry('restore-unread')] });
    reader.readers?.start();
    expect(await received.promise).toBe('restore-unread');
    expect((await reader.store.getReaderStates({ reader: name })).readerPosition).toBe(position + 1);
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

/** @param getDatabase - Isolated database holding both journal and rule state. */
function testRuleJournal(getDatabase: () => StorageDatabaseContext): void {
  let recovery: {
    restarted: Awaited<ReturnType<typeof setup>>;
    entryId: string;
    laterId: string;
    duplicate: RecordEntryInput;
    keys: string[];
    completed: Promise<void>;
  };

  beforeEach(async () => {
    const database = getDatabase();
    const reader = MAKAIO_RULES_PARTY_KIND;
    const party = { id: reader, kind: reader };
    const keys: string[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Record reaction keys across attempts',
        parameterSchema: z.object({}),
        keyed: true,
        async handler(_call, _parameters, { key }) {
          keys.push(key);
          return keys.length === 1 ? { state: 'retry', reason: 'try-again' } : { state: 'accepted' };
        },
      }),
    );
    const eventSubject = otherSubject;
    const rule = ruleFor({ on: { kind: busMessageTrigger.kind, params: { subject: eventSubject } } });
    const source: RuleSourceContribution = {
      rulesFor: async () => ({
        set: { id: 'journal-rules', digest: 'first' },
        rules: [rule],
        groups: [],
        excluded: [],
      }),
      ruleTriggers: () => [],
      onTriggersChanged: () => () => {},
    };
    const owner: KernelMakaioExtension = {
      name: 'journal-rule-source',
      displayName: 'Journal rule source',
      version: '1.0.0',
      ruleSource: source,
    };
    let evaluator: RuleEvaluator | undefined;
    const contribution = createRuleJournalReader(() => evaluator);
    let rollBack = true;
    const hostReader = {
      call: mintCallContext({ caller: party, principal: party }),
      contribution: {
        ...contribution,
        async handle(...args: Parameters<typeof contribution.handle>): Promise<ReaderOutcome> {
          const result = await contribution.handle(...args);
          if (result.state !== 'done' || !result.commit || !rollBack) return result;
          return {
            state: 'done',
            async commit(tx, signal) {
              await result.commit?.(tx, signal);
              throw new Error('Rollback the first rule enqueue');
            },
          };
        },
      },
    };
    const first = await setup(database, {}, { additionalExtensions: [owner], hostReader, startReaders: false });
    evaluator = new RuleEvaluator(first.host, service, invoke, first.coordinator.getRuleSourceRegistration);
    const orderKey = 'ordered-changes';
    const [recorded, later] = await first.edge.accept({
      entries: [entry('recorded-rule', orderKey, eventSubject), entry('later-rule', orderKey, eventSubject)],
    });
    if (!recorded || !later) throw new Error('The fixture did not record the entries.');
    const { entryId } = recorded;
    const rolledBack = afterJournalCommit(first.host, async () =>
      (await first.store.getReaderStates({ reader, entryId })).states.some(
        (state) => state.state === 'open' && state.retries === 1,
      ),
    );
    const committed = afterJournalCommit(
      first.host,
      async () =>
        (await first.store.getReaderStates({ reader })).states.filter((state) => state.state === 'done').length === 2,
    );
    first.readers?.start();
    await rolledBack;
    expect(await first.store.getReaderStates({ reader, entryId })).toMatchObject({
      states: [{ state: 'open', retries: 1 }],
    });
    expect((await read(first.host, entryId)).cause).toBeUndefined();
    rollBack = false;
    await committed;
    expect(await first.store.getReaderStates({ reader, entryId })).toMatchObject({
      states: [{ state: 'done', retries: 1 }],
    });
    expect(await first.store.getReaderStates({ reader, entryId: later.entryId })).toMatchObject({
      states: [{ state: 'done' }],
    });
    expect((await read(first.host, entryId)).rules).toHaveLength(1);
    expect(keys).toEqual([]);
    await first.readers?.destroy();
    await first.coordinator.shutdown();

    const restarted = await setup(database, {}, { hostReader, startReaders: false });
    const evaluated = Promise.withResolvers<void>();
    evaluator = new (class extends RuleEvaluator {
      /**
       * Observe completion after the real evaluator's transactions have committed.
       * @param id - Occasion selected by the runner.
       * @param signal - Runner cancellation signal.
       */
      public override async evaluate(id: string, signal?: AbortSignal): Promise<void> {
        await super.evaluate(id, signal);
        if (id === later.entryId) evaluated.resolve();
      }
    })(restarted.host, service, invoke, restarted.coordinator.getRuleSourceRegistration);
    onTestFinished(startRuleJournalEvaluation(restarted.host, evaluator));
    recovery = {
      restarted,
      entryId,
      laterId: later.entryId,
      duplicate: entry('recorded-rule', orderKey, eventSubject),
      keys,
      completed: evaluated.promise,
    };
  });

  it('recovers committed rule work without replaying the reader or changing its reaction key', async () => {
    const { restarted, entryId, laterId, duplicate, keys, completed } = recovery;
    restarted.readers?.start();
    const [outcome] = await restarted.edge.accept({ entries: [duplicate] });
    expect(outcome).toEqual({ status: 'known', entryId });
    await completed;
    expect((await read(restarted.host, entryId)).parts).toMatchObject([{ state: 'accepted', attempt: 2 }]);
    expect((await read(restarted.host, laterId)).parts).toMatchObject([{ state: 'accepted', attempt: 1 }]);
    const expectedKey = JSON.stringify(['notify', entryId, 0]);
    expect(keys).toEqual([expectedKey, expectedKey, JSON.stringify(['notify', laterId, 0])]);
    expect((await read(restarted.host, entryId)).rules).toHaveLength(1);
  });
}

/**
 * Wait for a state made visible by a committed journal transaction.
 * @param host - Facade publishing the transaction wake.
 * @param matches - Check the committed state.
 * @returns A promise that resolves on the first matching commit.
 */
function afterJournalCommit(host: HostDatabase, matches: () => Promise<boolean>): Promise<void> {
  const matched = Promise.withResolvers<void>();
  const unsubscribe = getHostDatabaseWake(host).subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, async () => {
    try {
      if (await matches()) {
        unsubscribe();
        matched.resolve();
      }
    } catch (error) {
      unsubscribe();
      matched.reject(error);
    }
  });
  onTestFinished(unsubscribe);
  return matched.promise;
}

/** @param getDatabase - Isolated database holding journal and rule state.
 * @param firstResponse - Whether the source can answer for the first entry.
 */
function testRuleSourceAvailability(
  getDatabase: () => StorageDatabaseContext,
  firstResponse: 'no-set' | 'unavailable',
): void {
  const reader = MAKAIO_RULES_PARTY_KIND;
  const party = { id: reader, kind: reader };
  let fixture: Awaited<ReturnType<typeof setup>>;
  let evaluator: RuleEvaluator;
  let reaction: PromiseWithResolvers<string>;

  beforeEach(async () => {
    reaction = Promise.withResolvers<string>();
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Observe the selected journal entry',
        parameterSchema: z.object({}),
        keyed: true,
        async handler(_call, _parameters, { cause: { event } }) {
          if ('entryId' in event.cause) reaction.resolve(event.cause.entryId);
          return { state: 'accepted' };
        },
      }),
    );
    const snapshot = {
      set: { id: 'journal-rules', digest: 'first' },
      rules: [ruleFor({ on: { kind: busMessageTrigger.kind, params: { subject: otherSubject } } })],
      groups: [],
      excluded: [],
    };
    const source: RuleSourceContribution = {
      async rulesFor({ cause }) {
        if (cause.subject === otherSubject) return snapshot;
        if (firstResponse === 'unavailable') throw new Error('Rule source unavailable');
        return { set: null };
      },
      ruleTriggers: () => [],
      onTriggersChanged: () => () => {},
    };
    const owner: KernelMakaioExtension = {
      name: 'journal-rule-source',
      displayName: 'Journal rule source',
      version: '1.0.0',
      ruleSource: source,
    };
    const hostReader = {
      call: mintCallContext({ caller: party, principal: party }),
      contribution: createRuleJournalReader(() => evaluator),
    };
    fixture = await setup(getDatabase(), {}, { additionalExtensions: [owner], hostReader, startReaders: false });
    evaluator = new RuleEvaluator(fixture.host, service, invoke, fixture.coordinator.getRuleSourceRegistration);
  });

  it('preserves order according to the outcome of the first source request', async () => {
    const { edge, host, readers, store } = fixture;
    const [first, second] = await edge.accept({
      entries: [entry('first', 'ordered'), entry('second', 'ordered', otherSubject)],
    });
    if (!first || !second || !readers) throw new Error('The fixture did not start with two recorded entries.');
    const expected = firstResponse === 'no-set' ? 'done' : 'open';
    const settled = afterJournalCommit(host, async () => {
      const [state] = (await store.getReaderStates({ reader, entryId: first.entryId })).states;
      return state?.state === expected && (expected === 'done' || state.retries > 0);
    });

    readers.start();
    await settled;
    expect((await read(host, first.entryId)).cause).toBeUndefined();
    if (firstResponse === 'unavailable') {
      expect((await store.getReaderStates({ reader })).states).toMatchObject([
        { entryId: first.entryId, state: 'open', reason: 'rule-source-unavailable' },
        { entryId: second.entryId, state: 'open', retries: 0 },
      ]);
      expect((await read(host, second.entryId)).cause).toBeUndefined();
      return;
    }

    const stop = startRuleJournalEvaluation(host, evaluator);
    onTestFinished(stop);
    expect(await reaction.promise).toBe(second.entryId);
    await stop();
    expect((await read(host, second.entryId)).parts).toMatchObject([{ state: 'accepted' }]);
    expect((await store.getReaderStates({ reader })).states).toMatchObject([
      { entryId: first.entryId, state: 'done', retries: 0 },
      { entryId: second.entryId, state: 'done', retries: 0 },
    ]);
  });
}

describeStorageConformance('journal readers', (config) => {
  // Retry recovery waits for the append and settlement wakes on the database channel.
  const getDatabase = useSuiteDatabaseContext(config, { postgresIsolation: 'database' });

  beforeAll(async () => {
    await getDatabase().executor.run(sql.raw(fixtureKvDdl(config.dialect)));
  });

  testSelection(getDatabase);
  testSettlement(getDatabase);
  testRetry(getDatabase);
  testReadEntries(getDatabase);
  testReaderOwnership(getDatabase);
  testReaderDeclarationSnapshot(getDatabase);
  testLegacyReaderOwnership(getDatabase);
  testReaderActivationRollback(getDatabase);
  testSharedReaderReservation(getDatabase);
  testReaderAuthorization(getDatabase);
});

describeStorageConformance('rule journal', (config) => {
  testRuleJournal(useSuiteDatabaseContext(config));
});

describeStorageConformance('rule journal with no applicable set', (config) => {
  testRuleSourceAvailability(useSuiteDatabaseContext(config), 'no-set');
});

describeStorageConformance('rule journal with an unavailable source', (config) => {
  testRuleSourceAvailability(useSuiteDatabaseContext(config), 'unavailable');
});

describeStorageConformance('rule journal across source activations', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  const reader = MAKAIO_RULES_PARTY_KIND;
  const owner = 'journal-rule-source';
  const set = {
    set: { id: 'journal-rules', digest: 'retired' },
    rules: [ruleFor({ on: { kind: busMessageTrigger.kind, params: { subject } } })],
    groups: [],
    excluded: [],
  };
  let fixture: Awaited<ReturnType<typeof setup>>;
  let evaluator: RuleEvaluator;
  let requested: PromiseWithResolvers<void>;
  let retiredReply: PromiseWithResolvers<Awaited<ReturnType<RuleSourceContribution['rulesFor']>>>;
  let replacementReply: PromiseWithResolvers<void>;
  let reaction: PromiseWithResolvers<string>;

  beforeEach(async () => {
    requested = Promise.withResolvers<void>();
    retiredReply = Promise.withResolvers();
    replacementReply = Promise.withResolvers<void>();
    reaction = Promise.withResolvers<string>();
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Observe the effective rule set',
        parameterSchema: z.object({}),
        keyed: true,
        async handler(_call, _parameters, { cause }) {
          reaction.resolve(cause.ruleSet.digest);
          return { state: 'accepted' };
        },
      }),
    );
    let started = false;
    const source: KernelMakaioExtension = {
      name: owner,
      displayName: 'Journal rule source',
      version: '1.0.0',
      ruleSource: {
        async rulesFor() {
          if (started) {
            await replacementReply.promise;
            return { ...set, set: { ...set.set, digest: 'replacement' } };
          }
          started = true;
          requested.resolve();
          return await retiredReply.promise;
        },
        ruleTriggers: () => [],
        onTriggersChanged: () => () => {},
      },
    };
    const party = { id: reader, kind: reader };
    const hostReader = {
      call: mintCallContext({ caller: party, principal: party }),
      contribution: createRuleJournalReader(() => evaluator),
    };
    fixture = await setup(getDatabase(), {}, { additionalExtensions: [source], hostReader, startReaders: false });
    evaluator = new RuleEvaluator(fixture.host, service, invoke, fixture.coordinator.getRuleSourceRegistration);
  });

  it.each([
    { kind: 'no applicable set', reply: { set: null } },
    { kind: 'applicable set', reply: set },
  ])('retries a retired registration that replies with $kind', async ({ kind, reply }) => {
    const { coordinator, edge, host, readers, store } = fixture;
    const [recorded] = await edge.accept({ entries: [entry(`source-changed-${kind}`, 'ordered')] });
    if (!recorded || !readers) throw new Error('The fixture did not start with a recorded entry.');
    const { entryId } = recorded;
    const retried = afterJournalCommit(host, async () => {
      const [state] = (await store.getReaderStates({ reader, entryId })).states;
      return state?.state === 'open' && state.reason === 'rule-source-unavailable';
    });
    try {
      readers.start();
      await requested.promise;
      const originalSource = coordinator.getRuleSource();
      await expect(coordinator.applyExtensionTransition(owner, false)).resolves.toBe('applied');
      await expect(coordinator.applyExtensionTransition(owner, true)).resolves.toBe('applied');
      expect(coordinator.getRuleSource()).toBe(originalSource);
      retiredReply.resolve(reply);
      await retried;
      expect((await read(host, entryId)).cause).toBeUndefined();

      const stop = startRuleJournalEvaluation(host, evaluator);
      onTestFinished(stop);
      replacementReply.resolve();
      expect(await reaction.promise).toBe('replacement');
      await stop();
      expect((await read(host, entryId)).parts).toMatchObject([{ state: 'accepted' }]);
      expect((await store.getReaderStates({ reader, entryId })).states).toMatchObject([{ state: 'done', retries: 1 }]);
    } finally {
      retiredReply.resolve(reply);
      replacementReply.resolve();
    }
  });
});
