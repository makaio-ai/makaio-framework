import { JournalSubjects, type ExternalObjectRef } from '@makaio/contracts/journal';
import { describeStorageConformance, useSuiteDatabaseContext } from '@makaio/storage-conformance';
import { expect, it } from 'vitest';
import {
  connector,
  parent,
  participantName,
  readRecord,
  useExternalEndpoint,
  useWriteHost,
  writeRequest,
} from './external-write-fixture.js';

describeStorageConformance('external write journal release', (config) => {
  const start = useWriteHost(useSuiteDatabaseContext(config));

  it.each([
    'create',
    'applied update',
    'direct update',
  ] as const)('restores the object before a rejected %s when the write is released', async (scenario) => {
    const reported = { extension: connector, site: parent.site, objectType: 'child', externalId: 'result', parent };
    const previous = scenario === 'create' ? null : { ...reported, url: '/objects/result' };
    const original = writeRequest({
      target:
        scenario === 'direct update' && previous
          ? { existing: previous }
          : { create: { site: reported.site, objectType: reported.objectType } },
      checksum: 'original',
      order: 10,
    });
    if (scenario === 'applied update' && previous) {
      const first = await start(await useExternalEndpoint({ object: previous }));
      expect(await first.client.writes.write(first.client.call, original)).toEqual({
        outcome: 'written',
        object: previous,
      });
      await first.close();
    }

    const targets: (ExternalObjectRef | null)[] = [];
    const unresolvedObjects: (ExternalObjectRef | null)[] = [];
    const external = await useExternalEndpoint({
      object: reported,
      beforeMutation: async (input) => {
        targets.push(input.mode === 'update' ? input.object : null);
      },
    });
    const { client, bus } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            if (change.to === 'written') throw new Error('Binding conflict');
            if (change.to === 'unresolved') unresolvedObjects.push(change.record.object);
          },
        }),
      },
    });
    const request = {
      ...original,
      checksum: 'next',
      order: 11,
      participant: { name: participantName, data: null },
    };
    const result = await client.writes.write(client.call, request);
    if (!('error' in result) || result.error !== 'unresolved') throw new Error('Expected an unresolved intent.');
    expect(unresolvedObjects).toEqual([reported]);
    const { intentId } = await readRecord(client, request);
    expect(
      await bus.request(JournalSubjects['resolve-write'], {
        writeRecordId: result.writeRecordId,
        intentId,
        resolution: { notWritten: true },
      }),
    ).toMatchObject({ success: true, record: { state: 'released', object: previous } });
    expect(
      await client.writes.readWrites(client.call, { byKey: { writer: request.writer, key: request.key } }),
    ).toMatchObject({ writes: [{ state: 'released', object: previous, parent: previous?.parent ?? null }] });
    if (!previous) {
      expect(await client.writes.readWrites(client.call, { byObject: reported })).toEqual({ writes: [] });
      expect(await client.writes.readWrites(client.call, { byObject: parent })).toEqual({ writes: [] });
    }
    expect(await client.writes.write(client.call, { ...original, checksum: 'retry', order: 12 })).toEqual({
      outcome: 'written',
      object: reported,
    });
    expect(targets).toEqual([previous, previous]);
  });
});
