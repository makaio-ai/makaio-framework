import { createBusInstance, ForeignOwnContextError, type IMakaioBus } from '@makaio/bus-core';
import {
  JournalError,
  type AccountResolverContribution,
  type JournalCapability,
  type RecordEntryInput,
} from '@makaio/contracts';
import { createBusNamespace, journalSubject } from '@makaio/core';
import { ExtensionCoordinator } from '@makaio/kernel';
import { journalStorageSchema } from '@makaio/services-core/journal/storage';
import { createHostDatabase, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { createTestCall } from '@makaio/test-utils';
import { eq, sql } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  createJournalCapability,
  JournalContributionProcessor,
  SubjectDirectory,
} from '../../../../services/core/src/journal/index.js';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const extension = 'journal-writer';
const caller = { kind: 'makaio.extension', id: extension };
const principal = { kind: 'test.user', id: 'original-user', claims: { verified: true } };
const attestedBy = { kind: 'test.verifier', id: 'ingress' };
const witnessed = { extension, site: 'site', accountId: 'account' };
const subject = 'journal-writer.changed';
const nullableSubject = 'journal-writer.nullable';
const edgeName = 'journal-writer.stream';
const partition = 'primary';
const recorded = z.string();
const namespace = createBusNamespace(extension, {
  changed: journalSubject(recorded, { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } }),
  nullable: journalSubject(z.null(), { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } }),
  unlisted: journalSubject(recorded, { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } }),
  store: { request: z.object({ key: z.string() }), response: z.object({ stored: z.boolean() }) },
});

interface StartupTools {
  readonly journal: JournalCapability;
  readonly host: ReturnType<typeof createHostDatabase>;
  readonly bus: IMakaioBus;
}

interface FixtureOptions {
  readonly duringInit?: (tools: StartupTools) => Promise<void>;
  readonly resolve?: AccountResolverContribution['resolve'];
  readonly leaveGateClosed?: boolean;
}

/**
 * Build an entry for the fixture's recorded subject.
 * @param key - Idempotency key, unique to the test.
 */
function entry(key: string): RecordEntryInput {
  return { subject, payload: key, key };
}

/**
 * Start a real extension with its journal capability and an independent database reader.
 * @param database - Migrated isolation unit from the storage harness.
 * @param options - Startup and account resolution controls for a scenario.
 */
async function setup(database: StorageDatabaseContext, options: FixtureOptions = {}) {
  const host = createHostDatabase(database.db);
  const transactions = vi.spyOn(host, 'transaction');
  const bus = createBusInstance();
  const gate = Promise.withResolvers<void>();
  let ownStart = false;
  const awaitOpen = vi.fn(() => gate.promise);
  let writer: StartupTools | undefined;
  const coordinator = new ExtensionCoordinator(bus, {
    db: database.db,
    extensionContextBase: {
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'journal-writer-test',
      tryImport: async () => null,
      /**
       * @param context - Shared context assembled by the coordinator.
       * @returns Full context bound to the carrier and database used in the suite.
       */
      constructContext: (context) => ({
        ...context,
        database: host,
        journal: createJournalCapability({
          extension,
          bus: context.bus,
          host,
          subjects,
          contributions,
          isActive: () => context.hasExtension(extension),
          startGate: { awaitOpen, isOwnStartRunning: (owner) => owner === extension && ownStart },
        }),
      }),
    },
  });
  const subjects = new SubjectDirectory(bus, coordinator);
  onTestFinished(async () => {
    try {
      await coordinator.shutdown();
    } finally {
      await subjects.destroy();
    }
  });
  await subjects.init();
  const contributions = new JournalContributionProcessor(subjects);
  coordinator.registerContributionProcessor(contributions);
  const { resolve } = options;
  coordinator.load([
    {
      name: extension,
      displayName: extension,
      version: '1.0.0',
      critical: true,
      namespaces: [namespace],
      edges: [{ edge: edgeName, description: 'Receive changes', subjects: [subject, nullableSubject] }],
      ...(resolve === undefined
        ? {}
        : { accountResolver: { resolver: `${extension}.accounts`, description: 'Map accounts', resolve } }),
      create: ({ bus: carrier, database: host, journal }) => {
        writer = { bus: carrier, host, journal };
        const destroy = carrier.on(namespace.subjects.store, async ({ call, payload, setResult }) => {
          const outcome = await host.transaction((tx) => journal.record(call, { tx, entries: [entry(payload.key)] }));
          setResult({ stored: outcome[0]?.status === 'recorded' });
        });
        return {
          destroy,
          init: async () => {
            ownStart = true;
            try {
              await options.duringInit?.({ journal, host, bus: carrier });
            } finally {
              ownStart = false;
            }
          },
        };
      },
    },
  ]);
  await coordinator.startAll();
  if (writer === undefined) throw new Error('The journal writer did not start.');
  const { bus: extensionBus, journal } = writer;
  const edge = journal.edge(edgeName);
  if (!options.leaveGateClosed) gate.resolve();
  const reader = await database.createSiblingClient();
  onTestFinished(() => reader.close());
  /** @param key - Read this entry from the independent connection. */
  const rows = (key: string) => {
    const { journalEntries } = resolveSchema(reader.db, journalStorageSchema);
    return reader.db.select().from(journalEntries).where(eq(journalEntries.key, key));
  };
  return { host, extensionBus, bus, journal, edge, rows, transactions, awaitOpen, openGate: gate.resolve };
}

/**
 * Verify the extension-bound record operation against migrated storage.
 * @param getDatabase - Accessor for the current test's database.
 */
function testRecord(getDatabase: () => StorageDatabaseContext): void {
  it('stores provenance from a call received by an extension handler', async () => {
    const { bus, rows } = await setup(getDatabase());
    const key = 'received';
    const call = createTestCall({ principal, attestedBy });
    await expect(bus.request(call, namespace.subjects.store, { key })).resolves.toEqual({ stored: true });
    await expect(bus.request(call, namespace.subjects.store, { key })).resolves.toEqual({ stored: false });
    expect(await rows(key)).toMatchObject([{ origin: { extension, caller, principal, attestedBy } }]);
  });

  it('marks the caller transaction rollback-only when record is caught in init', async () => {
    await setup(getDatabase(), {
      duringInit: async ({ journal, host, bus }) => {
        // ORIGIN: This is extension startup work, with no received call.
        const call = bus.own('start');
        const transaction = host.transaction(async (tx) => {
          await expect(journal.record(call, { tx, entries: [entry('before-active')] })).rejects.toMatchObject({
            code: 'record-before-active',
          });
        });
        await expect(transaction).rejects.toMatchObject({ code: 'record-before-active' });
      },
    });
  });

  it('rejects an own context from a foreign bus and a token from a foreign host', async () => {
    const database = getDatabase();
    const { bus, extensionBus, host, journal, rows } = await setup(database);
    // ORIGIN: Attempt a host's unrelated own work through the extension capability.
    const foreignCall = bus.own('root');
    // ORIGIN: The extension originates a journal entry without a received call.
    const call = extensionBus.own('root');
    const key = 'foreign';
    const entries = [entry(key)];
    await expect(host.transaction((tx) => journal.record(foreignCall, { tx, entries }))).rejects.toBeInstanceOf(
      ForeignOwnContextError,
    );
    await expect(
      createHostDatabase(database.db).transaction((tx) => journal.record(call, { tx, entries })),
    ).rejects.toMatchObject({ code: 'foreign-transaction' });
    expect(await rows(key)).toEqual([]);
  });

  it('rolls back the owning facade when a foreign transaction rejection is caught', async () => {
    const database = getDatabase();
    const { extensionBus, journal, rows } = await setup(database);
    const foreignHost = createHostDatabase(database.db);
    const { kv } = resolveSchema(database.db, fixtureKv);
    const dialect = database.dialect;
    await database.executor.run(sql.raw(fixtureKvDdl(dialect)));
    // ORIGIN: The extension originates this record on an unrelated host database facade.
    const call = extensionBus.own('root');
    const key = 'foreign-store';
    const caught = vi.fn();
    const transaction = foreignHost.transaction(async (tx) => {
      await getTransactionQueryContext(tx).insert(kv).values({ id: key });
      await journal.record(call, { tx, entries: [entry(key)] }).catch(caught);
    });
    const [result] = await Promise.allSettled([transaction]);
    expect(await database.db.select().from(kv).where(eq(kv.id, key))).toEqual([]);
    expect(await rows(key)).toEqual([]);
    expect(caught).toHaveBeenCalledExactlyOnceWith(expect.any(JournalError));
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'foreign-transaction' } });
  });

  it('reports a typed error for a finished transaction without masking the cause', async () => {
    const { extensionBus, host, journal } = await setup(getDatabase());
    const tx = await host.transaction(async (token) => token);
    // ORIGIN: The extension originates a record after its transaction finished.
    const result = journal.record(extensionBus.own('root'), { tx, entries: [entry('finished')] });
    await expect(result).rejects.toBeInstanceOf(JournalError);
    await expect(result).rejects.toMatchObject({ code: 'transaction-finished' });
  });

  it('refuses an unknown edge and a subject not admitted on the edge', async () => {
    const { extensionBus, host, journal, edge } = await setup(getDatabase());
    // ORIGIN: The extension originates a journal entry without a received call.
    const call = extensionBus.own('root');
    const unknown = { ...entry('unknown-edge'), edge: `${extension}.unknown` };
    const unknownEdge = journal.edge(unknown.edge);
    await expect(unknownEdge.getEdgeCursors([partition])).rejects.toMatchObject({ code: 'edge-unknown' });
    await expect(unknownEdge.accept({ entries: [] })).rejects.toMatchObject({ code: 'edge-unknown' });
    await expect(host.transaction((tx) => journal.record(call, { tx, entries: [unknown] }))).rejects.toMatchObject({
      code: 'edge-unknown',
    });
    await expect(
      edge.accept({ entries: [{ ...entry('unlisted-subject'), subject: `${extension}.unlisted` }] }),
    ).rejects.toMatchObject({ code: 'edge-unknown' });
  });

  it('does not persist witnessed accounts supplied as extra record fields', async () => {
    const { extensionBus, host, journal, rows } = await setup(getDatabase());
    const key = 'record-extra-witness';
    const entries = [{ ...entry(key), witnessed }];
    // ORIGIN: An ordinary extension write does not attest a witnessed account.
    const call = extensionBus.own('root');
    await host.transaction((tx) => journal.record(call, { tx, entries }));
    expect((await rows(key))[0]?.origin).toEqual({ extension, caller, principal: caller });
  });
}

/**
 * Verify the start gate, staged reads and account resolution against migrated storage.
 * @param getDatabase - Accessor for the current test's database.
 */
function testEdgeLifecycle(getDatabase: () => StorageDatabaseContext): void {
  it('rejects own-start acceptance before waiting for the gate or opening a transaction', async () => {
    const cursorReads: unknown[] = [];
    const { awaitOpen, transactions } = await setup(getDatabase(), {
      duringInit: async ({ journal }) => {
        const edge = journal.edge(edgeName);
        await expect(
          Promise.race([edge.accept({ entries: [] }), Promise.resolve('still waiting')]),
        ).rejects.toMatchObject({ code: 'accept-during-own-start', message: expect.stringContaining(extension) });
        cursorReads.push(await edge.getEdgeCursors([partition]));
      },
    });
    expect(awaitOpen).not.toHaveBeenCalled();
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(cursorReads).toEqual([[{ partition, value: null }]]);
  });

  it('waits for the gate before accepting work from outside startup', async () => {
    const { edge, transactions, awaitOpen, openGate, rows } = await setup(getDatabase(), { leaveGateClosed: true });
    const pending = edge.accept({ entries: [entry('wait-for-gate')] });
    try {
      await Promise.resolve();
      expect(awaitOpen).toHaveBeenCalledOnce();
      expect(transactions).not.toHaveBeenCalled();
    } finally {
      openGate();
      await pending;
    }
    expect(await rows('wait-for-gate')).toMatchObject([{ origin: { caller, principal: caller, edge: edgeName } }]);
  });

  it('resolves accounts before opening the transaction and writes nothing when resolution fails', async () => {
    const failure = new Error('Account resolution failed');
    const resolve = vi.fn(async () => {
      throw failure;
    });
    const { edge, transactions, rows } = await setup(getDatabase(), { resolve });
    const delivery = {
      entries: [{ ...entry('resolver-failure'), witnessed }],
      cursor: { partition: 'failure', from: null, to: 'next' },
    };
    await expect(edge.accept(delivery)).rejects.toBe(failure);
    expect(resolve).toHaveBeenCalledWith(witnessed);
    expect(transactions).not.toHaveBeenCalled();
    expect(await rows('resolver-failure')).toEqual([]);
    expect(await edge.getEdgeCursors(['failure'])).toEqual([{ partition: 'failure', value: null }]);
  });

  it('validates witnessed ownership and stores mapped and unmapped account principals', async () => {
    const unmapped = { ...witnessed, accountId: 'unmapped' };
    const resolve: AccountResolverContribution['resolve'] = async (account) =>
      account.accountId === witnessed.accountId ? principal : null;
    const { edge, rows, transactions } = await setup(getDatabase(), { resolve });
    await expect(
      edge.accept({ entries: [{ ...entry('foreign-account'), witnessed: { ...witnessed, extension: 'other' } }] }),
    ).rejects.toMatchObject({ code: 'witnessed-not-owned' });
    expect(transactions).not.toHaveBeenCalled();
    await edge.accept({
      entries: [
        { ...entry('mapped'), witnessed },
        { ...entry('unmapped'), witnessed: unmapped },
      ],
    });
    expect(await rows('mapped')).toMatchObject([{ origin: { caller, principal, attestedBy: caller, witnessed } }]);
    expect(await rows('unmapped')).toMatchObject([
      {
        origin: {
          caller,
          attestedBy: caller,
          witnessed: unmapped,
          principal: { kind: 'makaio.witnessed-account', id: `${extension}/site/unmapped` },
        },
      },
    ]);
  });
}

/**
 * Verify atomic cursor movement, rollback and replay against a second connection.
 * @param getDatabase - Accessor for the current test's database.
 */
function testEdgeAtomicity(getDatabase: () => StorageDatabaseContext): void {
  it('rolls back appended rows when the cursor CAS is stale', async () => {
    const { edge, rows } = await setup(getDatabase());
    const cursor = { partition: 'stale', from: null, to: 'first' };
    await edge.accept({ entries: [entry('first-cursor')], cursor });
    await expect(
      edge.accept({ entries: [entry('stale-cursor')], cursor: { ...cursor, to: 'second' } }),
    ).rejects.toMatchObject({ code: 'cursor-moved' });
    expect(await rows('stale-cursor')).toEqual([]);
    expect(await edge.getEdgeCursors([cursor.partition])).toEqual([{ partition: cursor.partition, value: 'first' }]);
  });

  it('commits before returning and moves the cursor for an all-known batch', async () => {
    const { edge, rows } = await setup(getDatabase());
    const key = 'replayed';
    const initial = await edge.accept({
      entries: [entry(key)],
      cursor: { partition: 'replay', from: null, to: 'first' },
    });
    expect(initial).toEqual([{ status: 'recorded', entryId: expect.any(String) }]);
    expect(await rows(key)).toMatchObject([{ key, entryId: initial[0]?.entryId }]);
    expect(
      await edge.accept({
        entries: [{ ...entry(key), payload: 'different' }],
        cursor: { partition: 'replay', from: 'first', to: 'second' },
      }),
    ).toEqual([{ status: 'known', entryId: initial[0]?.entryId }]);
    expect(await edge.getEdgeCursors(['replay'])).toEqual([{ partition: 'replay', value: 'second' }]);
    expect(await rows(key)).toMatchObject([{ payload: key }]);
  });

  it('rejects a key used for a different subject and persists valid JSON null', async () => {
    const { edge, rows } = await setup(getDatabase());
    const key = 'subject-bound';
    await edge.accept({ entries: [entry(key)] });
    await expect(edge.accept({ entries: [{ key, subject: nullableSubject, payload: null }] })).rejects.toMatchObject({
      code: 'key-subject-mismatch',
    });
    expect(await rows(key)).toMatchObject([{ subject, payload: key }]);

    const nullKey = 'json-null';
    await expect(
      edge.accept({ entries: [{ key: nullKey, subject: nullableSubject, payload: false }] }),
    ).rejects.toMatchObject({ code: 'payload-invalid' });
    expect(await rows(nullKey)).toEqual([]);
    await expect(
      edge.accept({ entries: [{ key: nullKey, subject: nullableSubject, payload: null }] }),
    ).resolves.toMatchObject([{ status: 'recorded' }]);
    expect(await rows(nullKey)).toMatchObject([{ subject: nullableSubject, payload: null }]);
  });
}

describeStorageConformance('extension journal writes', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  testRecord(getDatabase);
  testEdgeLifecycle(getDatabase);
  testEdgeAtomicity(getDatabase);
});
