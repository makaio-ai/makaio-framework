import { JournalError, type HostDatabase, type HostTransaction, type JsonValue } from '@makaio/contracts';
import { journalStorageSchema } from '@makaio/services-core/journal/storage';
import {
  createHostDatabase,
  getDatabaseSignals,
  getHostDatabaseWake,
  getTransactionQueryContext,
  markTransactionWakeTopic,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  appendEntries,
  JOURNAL_ENTRIES_WAKE_TOPIC,
  type AppendEntriesInput,
  type AppendEntry,
  type AppendSubjectDeclaration,
} from '../../../../services/core/src/journal/storage/append-entries.js';
import type { StorageConformanceConfig, StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const extension = 'journal-append-suite';
const subject = 'journal-append-suite.event';
const otherSubject = 'journal-append-suite.other';
const jsonSubject = 'journal-append-suite.json';
const postgresSettings = { default_transaction_isolation: 'read committed', statement_timeout: '5000' };
const caller = { kind: 'makaio.extension', id: extension };
const principal = { kind: 'makaio.anonymous', id: 'journal-append-principal' };
const declaration: AppendSubjectDeclaration = {
  recorded: true,
  owner: extension,
  schemaVersion: '2',
  payloadSchema: z.string().transform((value) => value.toUpperCase()),
};
const declarations = new Map<string, AppendSubjectDeclaration>([
  [subject, declaration],
  [otherSubject, declaration],
  [jsonSubject, { ...declaration, payloadSchema: z.union([z.null(), z.string()]) }],
]);

/**
 * Prepare an entry for the append capability.
 * @param key - Deduplication key.
 * @param payload - Original, unparsed payload.
 * @param name - Canonical subject.
 * @returns The entry with caller and principal.
 */
function entry(key: string, payload: JsonValue = 'original', name = subject): AppendEntry {
  return { key, payload, subject: name, origin: { caller, principal } };
}

/**
 * Append within an already-open host transaction.
 * @param tx - The caller's transaction.
 * @param entries - Entries to record.
 * @param overrides - Other authority and provenance supplied by the capability.
 * @returns The outcomes before commit.
 */
function append(
  tx: HostTransaction,
  entries: readonly AppendEntry[],
  overrides: Partial<Pick<AppendEntriesInput, 'subjects' | 'edge' | 'extension'>> = {},
): ReturnType<typeof appendEntries> {
  return appendEntries(getTransactionQueryContext(tx), {
    tx,
    extension,
    subjects: { resolve: declarations.get.bind(declarations) },
    entries,
    ...overrides,
  });
}

/**
 * Observe a specific Postgres lock wait on an independent connection.
 * @param ctx - Isolated suite database.
 * @param pid - Backend PID of the transaction holding the journal counter.
 */
async function waitForBlockedWriter(ctx: StorageDatabaseContext, pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  do {
    const [wait] = await ctx.executor.all<{ blocked: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
    `);
    if (wait?.blocked) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('The second writer did not wait for the first transaction.');
}

/** Real database fixture shared by the append cases. */
type AppendFixture = ReturnType<typeof useAppendFixture>;

/**
 * Bind the migrated database and wake subscription to the suite lifecycle.
 * @param config - Dialect configuration from the conformance harness.
 * @returns Accessors for the active database, rows and wake count.
 */
function useAppendFixture(config: StorageConformanceConfig) {
  const getCtx = useSuiteDatabaseContext(config, { postgresSettings });
  let host: HostDatabase;
  let wakes = 0;
  let unsubscribe = (): void => undefined;

  beforeAll(async () => {
    host = createHostDatabase(getCtx().db);
    await getCtx().executor.run(sql.raw(fixtureKvDdl(config.dialect)));
  });

  beforeEach(async () => {
    wakes = 0;
    const wake = getHostDatabaseWake(host);
    unsubscribe = wake.subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, () => {
      wakes++;
    });
    await wake.ready();
  });

  afterEach(() => {
    unsubscribe();
  });

  /**
   * Read durable journal rows after a transaction has settled.
   * @param keys - Keys to read.
   * @returns Matching committed rows in position order.
   */
  async function readRows(...keys: string[]) {
    const { db } = getCtx();
    const { journalEntries: table } = resolveSchema(db, journalStorageSchema);
    return await db.select().from(table).where(inArray(table.key, keys)).orderBy(table.position);
  }

  /**
   * Check commit wakes after earlier Postgres notifications have been received.
   * @param commits - Expected journal-writing commits in the current case.
   */
  async function expectWakes(commits: number): Promise<void> {
    const signals = getDatabaseSignals(getCtx().db);
    if (signals.kind === 'database-notify') {
      // Listen directly for the fence so local delivery cannot resolve it.
      // PostgreSQL delivers notifications in commit order.
      const fence = randomUUID();
      const delivered = Promise.withResolvers<void>();
      const stop = signals.subscribe((event) => {
        if (event.kind === 'topic' && event.topic === fence) delivered.resolve();
      });
      const abort = new AbortController();
      try {
        await host.transaction(async (tx) => markTransactionWakeTopic(tx, fence));
        await Promise.race([
          delivered.promise,
          delay(2000, undefined, { signal: abort.signal }).then(() => {
            throw new Error('Postgres notification fence was not delivered.');
          }),
        ]);
      } finally {
        abort.abort();
        stop();
      }
      expect(wakes).toBe(commits * 2);
    } else {
      expect(wakes).toBe(commits);
    }
  }

  return {
    getCtx,
    expectWakes,
    get host() {
      return host;
    },
    get wakes() {
      return wakes;
    },
    readRows,
  };
}

/**
 * Register the replay and eligibility cases.
 * @param fixture - Active database and wake observation.
 */
function testReplay(fixture: AppendFixture): void {
  it('records the original payload and returns an unchanged row for a same-subject replay', async () => {
    const [created] = await fixture.host.transaction((tx) => append(tx, [entry('replay')]));
    expect(created).toMatchObject({
      status: 'recorded',
      row: {
        entryId: expect.any(String),
        subject,
        extension,
        key: 'replay',
        payload: 'original',
        origin: { caller, principal, extension },
        schemaVersion: '2',
      },
    });
    await fixture.expectWakes(1);
    const replay = await fixture.host.transaction((tx) => append(tx, [entry('replay', { invalidForSubject: true })]));
    expect(replay).toEqual([{ status: 'known', row: created?.row }]);
    expect(await fixture.readRows('replay')).toEqual([created?.row]);
    await fixture.expectWakes(1);
  });

  it('rejects a cross-subject key and rolls back earlier rows even when the caller catches the error', async () => {
    const key = 'private-deduplication-key';
    const [stored] = await fixture.host.transaction((tx) => append(tx, [entry(key, 'private-payload')]));
    expect(stored).toBeDefined();
    const error = new JournalError(
      'key-subject-mismatch',
      `Extension "${extension}" requested journal subject "${otherSubject}" but existing entry "${stored?.row.entryId}" has subject "${subject}".`,
    );
    await expect(
      fixture.host.transaction(async (tx) => {
        await expect(
          append(tx, [entry('discarded'), entry(key, 'private-payload', otherSubject)]),
        ).rejects.toMatchObject({
          code: error.code,
          message: error.message,
        });
      }),
    ).rejects.toMatchObject({ code: error.code, message: error.message });
    expect(await fixture.readRows(key, 'discarded')).toEqual([stored?.row]);
    await fixture.expectWakes(1);
  });

  it.each([
    { code: 'subject-unknown', resolved: undefined },
    { code: 'subject-not-recorded', resolved: { ...declaration, recorded: false, owner: 'other-extension' } },
    { code: 'name-not-owned', resolved: { ...declaration, owner: 'other-extension' } },
  ])('checks $code before returning a known key', async ({ code, resolved }) => {
    const key = `eligibility-${code}`;
    const [stored] = await fixture.host.transaction((tx) => append(tx, [entry(key)]));
    await expect(
      fixture.host.transaction((tx) => append(tx, [entry(key)], { subjects: { resolve: () => resolved } })),
    ).rejects.toMatchObject({ code });
    expect(await fixture.readRows(key)).toEqual([stored?.row]);
    await fixture.expectWakes(1);
  });

  it('scopes an identical key to its recording extension', async () => {
    const key = 'extension-scoped-key';
    const other = 'other-extension';
    const first = entry(key);
    const second = {
      ...entry(key, 'other payload', otherSubject),
      origin: { caller: { ...caller, id: other }, principal },
    };
    const [created] = await fixture.host.transaction((tx) => append(tx, [first]));
    const [alsoCreated] = await fixture.host.transaction((tx) =>
      append(tx, [second], { extension: other, subjects: { resolve: () => ({ ...declaration, owner: other }) } }),
    );
    expect(alsoCreated).toMatchObject({ status: 'recorded', row: { extension: other, subject: otherSubject } });
    expect(await fixture.readRows(key)).toEqual([created?.row, alsoCreated?.row]);
  });
}

/**
 * Register batch persistence and rollback cases.
 * @param fixture - Active database and wake observation.
 */
function testPersistence(fixture: AppendFixture): void {
  it('handles repeated batch keys in order without consuming extra positions', async () => {
    const outcomes = await fixture.host.transaction((tx) =>
      append(tx, [entry('batch-first'), entry('batch-first', 42), entry('batch-next')]),
    );
    const [first, replay, next] = outcomes;
    expect(outcomes.map(({ status }) => status)).toEqual(['recorded', 'known', 'recorded']);
    expect(replay?.row).toEqual(first?.row);
    expect(first?.row.payload).toBe('original');
    expect(next?.row.position).toBe(Number(first?.row.position) + 1);
    expect(await fixture.readRows('batch-first', 'batch-next')).toEqual([first?.row, next?.row]);
    await fixture.expectWakes(1);
  });

  it('round-trips JSON null and the string "null" with delivery provenance', async () => {
    const edge = 'journal-append-suite.inbound';
    const witnessed = { extension, site: 'delivery-site', accountId: 'delivery-account' };
    const delivered = {
      ...entry('json-null', null, jsonSubject),
      orderKey: 'delivery-order',
      origin: { caller, principal, attestedBy: caller },
      witnessed,
    };
    const outcomes = await fixture.host.transaction((tx) =>
      append(tx, [delivered, entry('json-string', 'null', jsonSubject)], { edge }),
    );
    const rows = await fixture.readRows('json-null', 'json-string');
    expect(outcomes.map(({ row }) => row)).toEqual(rows);
    expect(rows.map(({ payload }) => payload)).toEqual([null, 'null']);
    expect(rows[0]).toMatchObject({
      orderKey: 'delivery-order',
      origin: { caller, principal, extension, edge, attestedBy: caller, witnessed },
    });
  });

  it('rejects an invalid new payload in production and rolls back the batch', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        fixture.host.transaction((tx) => append(tx, [entry('before-invalid'), entry('invalid', { wrong: true })])),
      ).rejects.toMatchObject({ code: 'payload-invalid' });
      expect(await fixture.readRows('before-invalid', 'invalid')).toEqual([]);
      await fixture.expectWakes(0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('commits caller storage and journal together and exposes both only after a commit wake', async () => {
    const fault = new Error('Caller rolled back');
    const { db } = fixture.getCtx();
    const { kv } = resolveSchema(db, fixtureKv);
    const key = 'shared-transaction';
    const readState = () => Promise.all([db.select().from(kv).where(eq(kv.id, key)), fixture.readRows(key)]);
    let readAfterWake: ReturnType<typeof readState> | undefined;
    const stop = getHostDatabaseWake(fixture.host).subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, () => {
      readAfterWake ??= readState();
    });

    try {
      let rolledBackPosition: number | undefined;
      await expect(
        fixture.host.transaction(async (tx) => {
          await getTransactionQueryContext(tx).insert(kv).values({ id: key });
          const [rolledBack] = await append(tx, [entry(key)]);
          rolledBackPosition = rolledBack?.row.position;
          expect(fixture.wakes).toBe(0);
          throw fault;
        }),
      ).rejects.toBe(fault);
      expect(await readState()).toEqual([[], []]);
      await fixture.expectWakes(0);

      const [committed] = await fixture.host.transaction(async (tx) => {
        await getTransactionQueryContext(tx).insert(kv).values({ id: key });
        return append(tx, [entry(key)]);
      });
      expect(committed?.row.position).toBe(rolledBackPosition);
      await fixture.expectWakes(1);
      expect(await readAfterWake).toMatchObject([[{ id: key }], [{ key }]]);
    } finally {
      stop();
    }
  });
}

/**
 * Register lock contention cases on independent Postgres connections.
 * @param fixture - Active database and wake observation.
 */
function testPostgresContention(fixture: AppendFixture): void {
  it.each([
    { scenario: 'independent entries', domain: false, replay: false },
    { scenario: 'domain lock before appending', domain: true, replay: false },
    { scenario: 'same key with invalid replacement payload', domain: false, replay: true },
  ])('serializes concurrent writers with $scenario', async ({ domain, replay }) => {
    const ctx = fixture.getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const key = `contention-${domain}-${replay}`;
    const secondKey = replay ? key : `${key}-second`;
    if (domain) await ctx.db.insert(kv).values({ id: key });
    const sibling = await ctx.createSiblingClient({ postgresSettings });
    const rival = createHostDatabase(sibling.db);
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const first = fixture.host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      if (domain) await q.update(kv).set({ label: 'first writer' }).where(eq(kv.id, key));
      const outcomes = await append(tx, [entry(key)]);
      const [backend] = await q.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(SELECT 1) AS anchor`);
      if (backend === undefined) throw new Error('First writer has no backend PID.');
      locked.resolve(backend.pid);
      await release.promise;
      return outcomes;
    });
    const second = Promise.race([
      locked.promise,
      first.then(() => {
        throw new Error('First writer committed before releasing the latch.');
      }),
    ]).then(async (pid) => {
      const writing = rival.transaction((tx) => append(tx, [entry(secondKey, replay ? false : 'second')]));
      try {
        await waitForBlockedWriter(ctx, pid);
        expect(await fixture.readRows(key, secondKey)).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([writing]);
      }
      return await writing;
    });
    try {
      const [recorded, contender] = await Promise.all([first, second]);
      expect(recorded[0]?.status).toBe('recorded');
      if (replay) {
        expect(contender).toEqual([{ status: 'known', row: recorded[0]?.row }]);
        expect(await fixture.readRows(key)).toEqual([recorded[0]?.row]);
      } else {
        expect(contender[0]?.status).toBe('recorded');
        expect(contender[0]?.row.position).toBe(Number(recorded[0]?.row.position) + 1);
        expect(await fixture.readRows(key, secondKey)).toEqual([recorded[0]?.row, contender[0]?.row]);
      }
      if (domain) {
        expect(await ctx.db.select().from(kv).where(eq(kv.id, key))).toMatchObject([{ label: 'first writer' }]);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await sibling.close();
    }
  }, 10_000);
}

describeStorageConformance('journal append', (config) => {
  const fixture = useAppendFixture(config);
  testReplay(fixture);
  testPersistence(fixture);
  if (config.dialect === 'postgres') testPostgresContention(fixture);
});
