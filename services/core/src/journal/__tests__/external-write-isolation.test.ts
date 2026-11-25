import { sql } from 'drizzle-orm';
import type { HostTransaction, WriteParticipantContribution } from '@makaio/contracts';
import {
  describeStorageConformance,
  fixtureKv,
  fixtureKvDdl,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { expect, it } from 'vitest';
import { parent, participantName, useExternalEndpoint, useWriteHost, writeRequest } from './external-write-fixture.js';

/**
 * Create one participant that acquires the same binding locks as its counterpart.
 * @param keys - Incoming lock keys, in operation order.
 * @param onLocked - Work to run while the transaction holds the locks.
 * @returns Participant using a consistent ordering for all keys.
 */
function bindingParticipant(
  keys: string[],
  onLocked: (tx: HostTransaction) => Promise<void>,
): WriteParticipantContribution {
  return {
    name: participantName,
    prepare: async (_call, change) => ({
      /**
       * @param tx - Live transaction of the journal state change.
       */
      async commit(tx) {
        if (change.to !== 'intended') return;
        const q = getTransactionQueryContext(tx);
        const { kv } = resolveSchema(q, fixtureKv);
        for (const id of [...keys].sort()) {
          await q
            .insert(kv)
            .values({ id, label: change.intentId })
            .onConflictDoUpdate({ target: kv.id, set: { label: change.intentId } });
        }
        await onLocked(tx);
      },
    }),
  };
}

describeStorageConformance('external write journal transaction isolation', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  const start = useWriteHost(getDatabase);

  it('admits only one of two callers that read the same unused key', async () => {
    const db = getDatabase();
    const sibling = config.dialect === 'postgres' ? await db.createSiblingClient() : undefined;
    const external = await useExternalEndpoint();
    const bothReady = Promise.withResolvers<void>();
    let ready = 0;
    const beforeCredential = async () => {
      if (++ready === 2) bothReady.resolve();
      await bothReady.promise;
    };
    const first = await start(external, { beforeCredential });
    const second = await start(external, { beforeCredential, database: sibling?.db });
    const request = writeRequest();
    const results = await Promise.all([
      first.client.writes.write(first.client.call, request),
      second.denied.writes.write(second.denied.call, request),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'written' }),
        { error: 'transient', reason: 'in-progress' },
      ]),
    );
    expect(external.mutations).toBe(1);
    expect(external.writes).toBe(1);
  });

  it('commits two independent participants that acquire the same locks in the same order', async () => {
    const db = getDatabase();
    await db.executor.run(sql.raw(fixtureKvDdl(db.dialect)));
    const request = writeRequest({ participant: { name: participantName, data: null } });
    const external = await useExternalEndpoint();
    const first = await start(external, { participant: bindingParticipant(['child', 'parent'], async () => {}) });
    // SQLite's driver queue coordinates writes on a shared handle. PostgreSQL proves the lock
    // order with independently pinned connections to the same schema.
    const sibling = config.dialect === 'postgres' ? await db.createSiblingClient() : undefined;
    const second = await start(external, {
      database: sibling?.db,
      participant: bindingParticipant(['parent', 'child'], async () => {}),
    });
    const calls = [
      first.client.writes.write(first.client.call, request),
      second.client.writes.write(second.client.call, { ...request, key: crypto.randomUUID() }),
    ];
    const results = await Promise.all(calls);
    expect(results).toMatchObject([{ outcome: 'written' }, { outcome: 'written' }]);
    expect(external.mutations).toBe(2);
  });

  if (config.dialect === 'postgres') {
    it('exposes the pending intent to its participant and only after commit to a READ COMMITTED sibling', async () => {
      const db = getDatabase();
      await db.executor.run(sql.raw(fixtureKvDdl(db.dialect)));
      const sibling = await db.createSiblingClient({
        postgresSettings: { default_transaction_isolation: 'read committed' },
      });
      const allowIntent = Promise.withResolvers<void>();
      const allowWriter = Promise.withResolvers<void>();
      const seenIntent = Promise.withResolvers<string>();
      const writerStarted = Promise.withResolvers<void>();
      const external = await useExternalEndpoint({
        beforeMutation: async () => {
          writerStarted.resolve();
          await allowWriter.promise;
        },
      });
      const byObject = { ...parent, externalId: 'read-committed-case' };
      const request = writeRequest({
        target: { create: { site: parent.site, objectType: 'child', parent: byObject } },
        participant: { name: participantName, data: null },
      });
      const first = await start(external, {
        participant: bindingParticipant(['child', 'parent'], async (tx) => {
          try {
            const page = await first.client.writes.readWrites(first.client.call, { byObject, tx });
            expect(page.writes).toMatchObject([{ key: request.key, state: 'intended', object: null }]);
            seenIntent.resolve(page.writes[0]!.writeRecordId);
            await allowIntent.promise;
          } catch (error) {
            seenIntent.reject(error);
            throw error;
          }
        }),
      });
      const second = await start(external, { database: sibling.db });
      const write = first.client.writes.write(first.client.call, request);
      try {
        const writeRecordId = await Promise.race([
          seenIntent.promise,
          write.then(() => {
            throw new Error('Write settled before the participant barrier.');
          }),
        ]);
        await second.host.transaction(async (tx) => {
          expect(await second.client.writes.readWrites(second.client.call, { byObject, tx })).toEqual({ writes: [] });
          allowIntent.resolve();
          await Promise.race([
            writerStarted.promise,
            write.then(() => {
              throw new Error('Write settled before reaching the external endpoint.');
            }),
          ]);
          expect(await second.client.writes.readWrites(second.client.call, { byObject, tx })).toMatchObject({
            writes: [{ writeRecordId, state: 'intended', object: null }],
          });
        });
      } finally {
        allowIntent.resolve();
        allowWriter.resolve();
        await write;
      }
      expect(await write).toMatchObject({ outcome: 'written' });
    });
  }
});
