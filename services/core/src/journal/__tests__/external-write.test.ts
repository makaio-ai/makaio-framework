import { JournalSubjects, type WriteRecordView } from '@makaio/contracts/journal';
import {
  describeStorageConformance,
  fixtureKv,
  fixtureKvDdl,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { externalIdentity } from '../storage/write-store.js';
import { journalStorageSchema } from '../storage/schema.variants.js';
import {
  connector,
  parent,
  participantName,
  readRecord,
  useExternalEndpoint,
  useWriteHost,
  writeRequest,
} from './external-write-fixture.js';

describeStorageConformance('external write journal', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  const start = useWriteHost(getDatabase);

  it('exposes the intended row inside the participant and rolls back both inserts', async () => {
    const database = getDatabase();
    await database.executor.run(sql.raw(fixtureKvDdl(database.dialect)));
    const external = await useExternalEndpoint();
    const request = writeRequest({ participant: { name: participantName, data: 'binding' } });
    const completed = writeRequest();
    let observed: WriteRecordView[] = [];
    const { client, host } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          async commit(tx) {
            const q = getTransactionQueryContext(tx);
            const { kv } = resolveSchema(q, fixtureKv);
            await q.insert(kv).values({ id: request.key, label: String(change.data) });
            const page = await client.writes.readWrites(client.call, { tx, byObject: parent });
            observed = page.writes;
            throw new Error('Participant rejected the intent');
          },
        }),
      },
    });
    expect(await client.writes.write(client.call, completed)).toMatchObject({ outcome: 'written' });
    expect(await client.writes.write(client.call, request)).toMatchObject({ error: 'transient' });
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: completed.key, state: 'written' }),
        expect.objectContaining({ key: request.key, state: 'intended', object: null, parent }),
      ]),
    );
    expect(observed).toHaveLength(2);
    expect(
      await client.writes.readWrites(client.call, { byKey: { writer: request.writer, key: request.key } }),
    ).toEqual({ writes: [] });
    expect(
      await host.transaction(async (tx) => {
        const q = getTransactionQueryContext(tx);
        const { kv } = resolveSchema(q, fixtureKv);
        const rows = await q.select().from(kv).where(eq(kv.id, request.key));
        return rows;
      }),
    ).toEqual([]);
    expect(external.mutations).toBe(1);
  });

  it('denies each operation before using the transaction, resolver or external writer', async () => {
    const external = await useExternalEndpoint();
    const { client, denied, host } = await start(external, { authorize: (call) => call.caller.id !== 'denied' });
    const request = writeRequest();
    const byKey = { writer: request.writer, key: request.key };
    await expect(denied.writes.write(denied.call, request)).rejects.toMatchObject({ code: 'forbidden' });
    expect(external.mutations).toBe(0);
    expect(await client.writes.readWrites(client.call, { byKey })).toEqual({ writes: [] });
    expect(await client.writes.write(client.call, request)).toMatchObject({ outcome: 'written' });
    await host.transaction(async (tx) => {
      await expect(denied.writes.readWrites(denied.call, { tx, byKey })).rejects.toMatchObject({ code: 'forbidden' });
      expect(await client.writes.readWrites(client.call, { tx, byKey })).toMatchObject({
        writes: [{ state: 'written' }],
      });
    });
  });

  it('returns credential-unavailable when the credential resolver throws before a write', async () => {
    const external = await useExternalEndpoint();
    const { client } = await start(external, {
      beforeCredential: async () => {
        throw new Error('Credential source unavailable');
      },
    });
    const request = writeRequest();
    expect(await client.writes.write(client.call, request)).toEqual({
      error: 'transient',
      reason: 'credential-unavailable',
    });
    expect(
      await client.writes.readWrites(client.call, { byKey: { writer: request.writer, key: request.key } }),
    ).toEqual({ writes: [] });
    expect(external.writes).toBe(0);
    expect(external.lookups).toBe(0);
  });

  it('matches object and parent identity, independently of site collisions and metadata', async () => {
    const object = { extension: connector, site: parent.site, objectType: 'child', externalId: 'same-id', parent };
    const other = { ...object, site: 'other-site', parent: { ...parent, site: 'other-site' } };
    const request = writeRequest({ target: { existing: object } });
    const first = await start(await useExternalEndpoint({ object }));
    const second = await start(await useExternalEndpoint({ object: other }));
    expect(await first.client.writes.write(first.client.call, request)).toMatchObject({ outcome: 'written' });
    expect(
      await second.client.writes.write(second.client.call, writeRequest({ target: { existing: other } })),
    ).toMatchObject({ outcome: 'written' });
    const { client } = first;
    const sameObject = writeRequest({ target: { existing: object } });
    expect(await client.writes.write(client.call, sameObject)).toMatchObject({ outcome: 'written' });
    const byObject = { ...object, url: 'https://example.invalid/', parent: other.parent };
    const firstPage = await client.writes.readWrites(client.call, { byObject, limit: 1 });
    expect(firstPage.nextCursor).toBeDefined();
    const lastPage = await client.writes.readWrites(client.call, { byObject, cursor: firstPage.nextCursor, limit: 1 });
    expect(lastPage.nextCursor).toBeUndefined();
    const writes = [...firstPage.writes, ...lastPage.writes];
    expect(writes).toHaveLength(2);
    expect(writes).toEqual(
      expect.arrayContaining(
        [request.key, sameObject.key].map((key) => expect.objectContaining({ key, object, parent, state: 'written' })),
      ),
    );
    expect(await client.writes.readWrites(client.call, { byObject: { ...object, site: 'another' } })).toEqual({
      writes: [],
    });
    expect(await client.writes.readWrites(client.call, { byObject: parent })).toMatchObject({
      writes: expect.arrayContaining(writes),
    });
  });

  it('uses creation time and record ID as a stable page order', async () => {
    const external = await useExternalEndpoint();
    const { host, client } = await start(external);
    const keys = new Set<string>();
    for (let i = 0; i < 51; i += 1) {
      const request = writeRequest({
        target: { create: { site: parent.site, objectType: 'child', parent: { ...parent, externalId: 'pages' } } },
      });
      keys.add(request.key);
      const other = writeRequest();
      if (i === 25) expect(await client.writes.write(client.call, other)).toMatchObject({ outcome: 'written' });
      // The endpoint returns its own parent metadata. The intent's parent remains the journal's lookup key.
      expect(await client.writes.write(client.call, request)).toMatchObject({ outcome: 'written' });
    }
    const byObject = { ...parent, externalId: 'pages' };
    const snapshot = await client.writes.readWrites(client.call, { byObject, limit: 51 });
    expect(new Set(snapshot.writes.map((row) => row.key))).toEqual(keys);
    // Force a deterministic creation-time tie while retaining real intent and result rows.
    await host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const { journalWrites } = resolveSchema(q, journalStorageSchema);
      await q
        .update(journalWrites)
        .set({ createdAt: 1 })
        .where(eq(journalWrites.parentKey, externalIdentity(byObject)));
    });
    const expected = snapshot.writes.map((row) => row.writeRecordId).sort();
    const first = await client.writes.readWrites(client.call, { byObject });
    expect(first.writes.map((row) => row.writeRecordId)).toEqual(expected.slice(0, 50));
    expect(first.nextCursor).toBeDefined();
    const last = await client.writes.readWrites(client.call, { byObject, cursor: first.nextCursor });
    expect(last.writes.map((row) => row.writeRecordId)).toEqual(expected.slice(50));
    expect(last).not.toHaveProperty('nextCursor');
  });

  it('keeps the write key tied to its object and skips duplicate or outdated updates', async () => {
    const object = {
      extension: connector,
      site: parent.site,
      objectType: 'child',
      externalId: 'update-target',
      parent,
    };
    const external = await useExternalEndpoint({ object });
    const { client } = await start(external);
    const request = writeRequest({ checksum: 'first', order: 10 });
    expect(await client.writes.write(client.call, request)).toMatchObject({ outcome: 'written', object });
    expect(await client.writes.write(client.call, request)).toMatchObject({ outcome: 'unchanged', object });
    expect(await client.writes.write(client.call, { ...request, order: 9 })).toMatchObject({
      outcome: 'outdated',
      object,
    });
    expect(external.mutations).toBe(1);
    expect(await client.writes.write(client.call, { ...request, checksum: 'next' })).toMatchObject({
      outcome: 'written',
      object,
    });
    expect(await client.writes.readWrites(client.call, { byObject: object })).toMatchObject({
      writes: [{ state: 'written', checksum: 'next', appliedOrder: 10 }],
    });
    expect(external.mutations).toBe(2);
  });

  it('retains the confirmed object for manual resolution when the participant rejects the write', async () => {
    const object = { extension: connector, site: parent.site, objectType: 'child', externalId: 'conflict', parent };
    const external = await useExternalEndpoint({ object });
    const { client, bus } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            if (change.to === 'written') throw new Error('Binding conflict');
          },
        }),
      },
    });
    const request = writeRequest({
      checksum: 'confirmed',
      order: 10,
      participant: { name: participantName, data: null },
    });
    const result = await client.writes.write(client.call, request);
    if (!('error' in result) || result.error !== 'unresolved') throw new Error('Expected an unresolved intent.');
    expect(await client.writes.readWrites(client.call, { byObject: object })).toMatchObject({
      writes: [
        { writeRecordId: result.writeRecordId, state: 'unresolved', object, checksum: null, appliedOrder: null },
      ],
    });
    expect(await client.writes.write(client.call, request)).toEqual(result);
    const { intentId } = await readRecord(client, request);
    expect(
      await bus.request(JournalSubjects['resolve-write'], {
        writeRecordId: result.writeRecordId,
        intentId,
        resolution: { found: object },
      }),
    ).toMatchObject({ success: true, record: { state: 'resolved', object, checksum: 'confirmed', appliedOrder: 10 } });
    expect(external.mutations).toBe(1);
  });

  for (const retryable of [false, true]) {
    it(`retains the applied write after a ${retryable ? 'released' : 'definitively failed'} update`, async () => {
      const object = {
        extension: connector,
        site: parent.site,
        objectType: 'child',
        externalId: 'update-target',
        parent,
      };
      const external = await useExternalEndpoint({
        object,
        beforeMutation: async ({ content }) =>
          content === 'refused' ? { notWritten: { code: 'refused', reason: 'Rejected update', retryable } } : undefined,
      });
      const { client } = await start(external);
      const a = writeRequest({ checksum: 'first', order: 10 });
      const b = { ...a, content: 'refused', checksum: 'next' };
      expect(await client.writes.write(client.call, a)).toMatchObject({ outcome: 'written', object });
      expect(await client.writes.write(client.call, b)).toMatchObject({
        error: retryable ? 'transient' : 'not-written',
      });
      expect(await client.writes.readWrites(client.call, { byKey: { writer: a.writer, key: a.key } })).toMatchObject({
        writes: [{ state: retryable ? 'released' : 'not-written', object, checksum: 'first', appliedOrder: 10 }],
      });
      expect(await client.writes.write(client.call, a)).toEqual({ outcome: 'unchanged', object });
      expect(await client.writes.write(client.call, { ...a, order: 9 })).toEqual({ outcome: 'outdated', object });
      expect(external.mutations).toBe(1);
      expect(external.writes).toBe(2);
      expect(external.lookups).toBe(0);
    });
  }
});
