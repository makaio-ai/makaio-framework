import { createBusInstance } from '@makaio/bus-core';
import { mintCallContext } from '@makaio/bus-core/kernel-api';
import type { HostTransaction, ReaderOutcome } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { JournalReaderStore, SubjectDirectory } from '@makaio/services-core/journal';
import { createHostDatabase, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { JournalReaderRun } from '../../../../services/core/src/journal/reader-run.js';
import { appendEntries } from '../../../../services/core/src/journal/storage/append-entries.js';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const extension = 'journal-settlement';
const party = { kind: 'makaio.extension', id: extension };
const leaseMs = 500;
const isCurrent = (): boolean => true;

/**
 * Record one entry and expose a second connection for checking committed effects.
 * @param database - Migrated conformance database.
 * @param key - Unique key for the entry.
 * @returns The host, observer and recorded entry identifier.
 */
async function setup(database: StorageDatabaseContext, key: string) {
  const subject = `${extension}.${key}`;
  const host = createHostDatabase(database.db);
  const [entry] = await host.transaction((tx) =>
    appendEntries(getTransactionQueryContext(tx), {
      tx,
      extension,
      subjects: {
        resolve: () => ({ recorded: true, owner: extension, schemaVersion: '1', payloadSchema: z.string() }),
      },
      entries: [{ key, subject, payload: key, origin: { caller: party, principal: party } }],
    }),
  );
  if (entry === undefined) throw new Error('Expected a recorded entry.');
  const { entryId } = entry.row;
  const sibling = await database.createSiblingClient();
  onTestFinished(() => sibling.close());
  const { kv } = resolveSchema(sibling.db, fixtureKv);
  return {
    host,
    subject,
    entryId,
    peer: new JournalReaderStore(createHostDatabase(sibling.db)),
    effects: () => sibling.db.select({ label: kv.label }).from(kv).where(eq(kv.id, entryId)),
  };
}

/**
 * Prepare an effect through the transaction supplied to the reader.
 * @param tx - The settlement transaction.
 * @param id - Entry to which the effect belongs.
 * @param label - The effect's value.
 * @returns An unexecuted transaction-bound write.
 */
function effect(tx: HostTransaction, id: string, label: string) {
  const query = getTransactionQueryContext(tx);
  const { kv } = resolveSchema(query, fixtureKv);
  return query.insert(kv).values({ id, label });
}

/** Use the real storage path with a short lease for the shutdown regression. */
class ShortLeaseStore extends JournalReaderStore {
  /**
   * @param reader - Reader acquiring work.
   * @param _leaseMs - Production lease requested by the run.
   * @param patterns - The reader's active patterns.
   * @param canSelect - Whether the run can still select work.
   * @param owner - Expected cursor owner.
   * @returns A real claim bounded by the test lease.
   */
  public override claim(
    reader: string,
    _leaseMs: number,
    patterns?: readonly string[],
    canSelect?: () => boolean,
    owner?: string,
  ) {
    return super.claim(reader, leaseMs, patterns, canSelect, owner);
  }
}

describeStorageConformance('journal reader settlement', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  beforeAll(async () => {
    await getDatabase().executor.run(sql.raw(fixtureKvDdl(config.dialect)));
  });

  it('stops after the commit lease expires, rejects escaped writes, and retries the entry', async () => {
    const { host, subject, entryId, peer, effects } = await setup(getDatabase(), 'hung');
    const reader = `${extension}.hung`;
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus);
    const directory = new SubjectDirectory(bus, coordinator);
    const resume = Promise.withResolvers<void>();
    const lateWrite = Promise.withResolvers<unknown>();
    let entered = false;
    let stopped = false;
    let commitSignal: AbortSignal | undefined;
    const store = new ShortLeaseStore(host);
    const [cursor] = await store.initialize(extension, [{ reader, startAt: 'beginning' }]);
    if (!cursor) throw new Error('Expected a reader cursor.');
    const run = new JournalReaderRun(
      {
        reader,
        startAt: 'beginning',
        description: 'Write an effect and wait through the commit deadline.',
        subjects: () => [subject],
        async handle(): Promise<ReaderOutcome> {
          return {
            state: 'done',
            async commit(tx, signal) {
              commitSignal = signal;
              const escaped = effect(tx, entryId, 'late');
              await effect(tx, entryId, 'rolled back');
              entered = true;
              await resume.promise;
              try {
                await escaped;
                lateWrite.resolve('write escaped its transaction');
              } catch (error) {
                lateWrite.resolve(error);
              }
            },
          };
        },
      },
      store,
      {
        directory,
        ...coordinator.hostRights,
        bindCall: (caller, { principal }) => mintCallContext({ caller, principal }),
      },
      { call: bus.own('schedule'), isActive: isCurrent, cursor },
    );
    run.wake();
    let close: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      close = run.close().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 2500 });
      expect(commitSignal?.aborted).toBe(true);
      expect(commitSignal?.reason).toMatchObject({ code: 'reader-deadline' });
      expect(await effects()).toEqual([]);
      expect(await peer.getReaderStates({ reader, entryId })).toMatchObject({
        states: [{ state: 'open', reason: 'reader-deadline', retries: 1, notBefore: expect.any(String) }],
      });

      resume.resolve();
      await expect(lateWrite.promise).resolves.toMatchObject({ code: 'transaction-finished' });
      expect(await effects()).toEqual([]);

      await vi.waitFor(
        async () => {
          const retry = await peer.claim(reader, leaseMs, [subject]);
          expect(retry?.entry.entryId).toBe(entryId);
          if (retry === undefined) throw new Error('Expected the retry claim.');
          await peer.settle(
            retry,
            {
              state: 'done',
              async commit(tx) {
                await effect(tx, entryId, 'retried');
              },
            },
            isCurrent,
          );
        },
        { timeout: 2500 },
      );
      expect(await effects()).toEqual([{ label: 'retried' }]);
      expect(await peer.getReaderStates({ reader, entryId })).toMatchObject({
        states: [{ state: 'done', retries: 1 }],
      });
    } finally {
      resume.resolve();
      await (close ?? run.close());
      await coordinator.shutdown();
    }
  });

  it('commits a completed effect when the final progress update crosses the lease deadline', async () => {
    const { subject, entryId, peer, effects } = await setup(getDatabase(), 'near-deadline');
    const reader = `${extension}.near-deadline`;
    await peer.initialize(extension, [{ reader, startAt: 'beginning' }]);
    await peer.admit(reader, [subject]);
    const claim = await peer.claim(reader, leaseMs, [subject]);
    if (claim === undefined) throw new Error('Expected a claim.');
    const due = await peer.nextDue(reader, [subject]);
    if (due === undefined) throw new Error('Expected a lease expiry.');
    let effectCompleted = false;
    let crossedDeadline = false;
    await peer.settle(
      claim,
      {
        state: 'done',
        async commit(tx) {
          await effect(tx, entryId, 'completed in time');
          effectCompleted = true;
        },
      },
      () => {
        if (effectCompleted && !crossedDeadline) {
          // Hold the first finalization check until the database clock has passed the lease.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, due + 25 - Date.now()));
          crossedDeadline = true;
        }
        return true;
      },
    );
    expect(crossedDeadline).toBe(true);
    expect(await effects()).toEqual([{ label: 'completed in time' }]);
    expect(await peer.getReaderStates({ reader, entryId })).toMatchObject({ states: [{ state: 'done', retries: 0 }] });
  });
});
