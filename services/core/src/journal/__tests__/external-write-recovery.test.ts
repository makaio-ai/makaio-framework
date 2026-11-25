import { setTimeout } from 'node:timers/promises';
import { JournalSubjects, type WriteRequest } from '@makaio/contracts/journal';
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

const object = { extension: connector, site: parent.site, objectType: 'child', externalId: 'recovery-target', parent };
const expired = { error: 'transient', reason: 'write-deadline-expired' };

/**
 * Wait until the host's real deadline passes.
 * @param deadline - Epoch milliseconds supplied by the host.
 */
async function waitForDeadline(deadline: number): Promise<void> {
  while (Date.now() < deadline) await setTimeout(deadline - Date.now());
}

describeStorageConformance('external write journal recovery', (config) => {
  const getDatabase = useSuiteDatabaseContext(config);
  const start = useWriteHost(getDatabase);

  /**
   * Interrupt a completion and let its lease expire before starting a new host.
   * @param external - External writer and its endpoint.
   * @param request - First request, with a participant that refuses completion.
   */
  async function interrupt(
    external: Awaited<ReturnType<typeof useExternalEndpoint>>,
    request: WriteRequest,
  ): Promise<void> {
    let deadline = 0;
    const first = await start(external, {
      deadline: () => (deadline = Date.now() + 500),
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            if (change.to !== 'intended') throw new Error('Completion was interrupted');
          },
        }),
      },
    });
    expect(await first.client.writes.write(first.client.call, request)).toMatchObject({ error: 'transient' });
    expect(await readRecord(first.client, request)).toMatchObject({ state: 'intended' });
    await first.close();
    await waitForDeadline(deadline);
  }

  for (const scenario of ['same', 'new', 'undecidable'] as const) {
    it(`recovers a persisted write before answering a ${scenario} retry`, async () => {
      const external = await useExternalEndpoint({
        object,
        ...(scenario === 'undecidable' && { lookup: 'undecidable' }),
      });
      const request = writeRequest({
        checksum: 'first',
        order: 10,
        participant: { name: participantName, data: 'original' },
      });
      await interrupt(external, request);
      expect(external.mutations).toBe(1);

      const transitions: string[] = [];
      const { client, bus } = await start(external, {
        participant: {
          name: participantName,
          prepare: async (_call, change) => ({
            commit: async () => {
              transitions.push(`${change.to}:${String(change.data)}`);
            },
          }),
        },
      });
      const retry =
        scenario === 'same'
          ? request
          : {
              ...request,
              content: 'different body',
              checksum: 'next',
              order: 11,
              participant: { name: participantName, data: 'replacement' },
            };
      const result = await client.writes.write(client.call, retry);
      if (scenario === 'new') {
        expect(result).toMatchObject({ outcome: 'written', object });
        expect(transitions).toEqual(['written:original', 'intended:replacement', 'written:replacement']);
        expect(await readRecord(client, request)).toMatchObject({ checksum: 'next', appliedOrder: 11 });
        expect(external.mutations).toBe(2);
      } else if (scenario === 'same') {
        expect(result).toMatchObject({ outcome: 'unchanged', object });
        expect(transitions).toEqual(['written:original']);
        expect(external.mutations).toBe(1);
      } else {
        expect(result).toMatchObject({ error: 'unresolved' });
        expect(transitions).toEqual(['unresolved:original']);
        const row = await readRecord(client, request);
        expect(row.state).toBe('unresolved');
        expect(
          await bus.request(JournalSubjects['resolve-write'], {
            writeRecordId: row.writeRecordId,
            intentId: row.intentId,
            resolution: { notWritten: true },
          }),
        ).toMatchObject({ success: true, record: { state: 'released' } });
        expect(transitions).toEqual(['unresolved:original', 'released:original']);
        expect(external.mutations).toBe(1);
      }
    });
  }

  it('blocks applied shortcuts while a follow-up intent is pending or unresolved', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const external = await useExternalEndpoint({
      object,
      lookup: 'undecidable',
      beforeMutation: async ({ mode }) => {
        if (mode === 'create') return;
        entered.resolve();
        await finish.promise;
        return { unknown: 'Write could not be confirmed' };
      },
    });
    const { client, bus } = await start(external);
    const original = writeRequest({ checksum: 'first', order: 10 });
    const older = { ...original, order: 9 };
    expect(await client.writes.write(client.call, original)).toEqual({ outcome: 'written', object });

    const pending = client.writes.write(client.call, {
      ...original,
      content: 'next body',
      checksum: 'next',
      order: 11,
    });
    try {
      await Promise.race([entered.promise, pending]);
      const row = await readRecord(client, original);
      expect(row).toMatchObject({ state: 'intended', checksum: 'first' });
      expect(
        await bus.request(JournalSubjects['resolve-write'], {
          writeRecordId: row.writeRecordId,
          intentId: row.intentId,
          resolution: { notWritten: true },
        }),
      ).toEqual({ success: false, code: 'not-unresolved' });
      for (const retry of [original, older]) {
        expect(await client.writes.write(client.call, retry)).toEqual({ error: 'transient', reason: 'in-progress' });
      }
    } finally {
      finish.resolve();
      await pending;
    }

    const row = await readRecord(client, original);
    expect(row).toMatchObject({ state: 'unresolved', checksum: 'first', appliedOrder: 10 });
    const unresolved = { error: 'unresolved', writeRecordId: row.writeRecordId };
    expect(await pending).toEqual(unresolved);
    for (const retry of [original, older]) expect(await client.writes.write(client.call, retry)).toEqual(unresolved);
    expect(external.writes).toBe(2);
  });

  it.each([
    'resolved',
    'released',
  ] as const)('manually marks an expired intent as %s after repeated lookup failures', async (state) => {
    let refuse = state === 'released';
    const external = await useExternalEndpoint({
      object,
      beforeMutation: async () =>
        refuse ? { notWritten: { code: 'busy', reason: 'Try later', retryable: true } } : undefined,
      afterLookup: async () => {
        throw new Error('Lookup unavailable');
      },
    });
    const request = writeRequest({ checksum: 'first', participant: { name: participantName, data: null } });
    await interrupt(external, request);
    refuse = false;
    const committed: string[] = [];
    const { client, bus } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async (tx) => {
            const { writes } = await client.writes.readWrites(client.call, {
              byKey: { writer: request.writer, key: request.key },
              tx,
            });
            expect(writes[0]?.state).toBe(change.to);
            committed.push(change.to);
          },
        }),
      },
    });
    const before = await readRecord(client, request);
    for (let retry = 0; retry < 2; retry += 1) {
      expect(await client.writes.write(client.call, request)).toEqual({
        error: 'transient',
        reason: 'write-lookup-failed',
      });
      expect(await readRecord(client, request)).toEqual(before);
    }
    expect(
      await bus.request(JournalSubjects['resolve-write'], {
        writeRecordId: before.writeRecordId,
        intentId: before.intentId,
        resolution: state === 'resolved' ? { found: object } : { notWritten: true },
      }),
    ).toMatchObject({ success: true, record: { state } });
    expect(await readRecord(client, request)).toMatchObject({ state });
    expect(committed).toEqual([state]);
    expect(await client.writes.write(client.call, request)).toEqual({
      outcome: state === 'resolved' ? 'unchanged' : 'written',
      object,
    });
    expect(external.lookups).toBe(2);
    expect(external.mutations).toBe(1);
  });

  it('commits only one transition when manual resolution races recovery', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const external = await useExternalEndpoint({
      object,
      afterLookup: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    const request = writeRequest({ participant: { name: participantName, data: null } });
    await interrupt(external, request);
    const committed: string[] = [];
    const { client, bus } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            committed.push(change.to);
          },
        }),
      },
    });
    const before = await readRecord(client, request);
    const recovering = client.writes.write(client.call, request);
    try {
      await Promise.race([entered.promise, recovering]);
      expect(external.lookups).toBe(1);
      expect(
        await bus.request(JournalSubjects['resolve-write'], {
          writeRecordId: before.writeRecordId,
          intentId: before.intentId,
          resolution: { found: object },
        }),
      ).toMatchObject({ success: true, record: { state: 'resolved', object } });
    } finally {
      finish.resolve();
      await recovering;
    }
    expect(await recovering).toEqual({ error: 'transient', reason: 'in-progress' });
    expect(await readRecord(client, request)).toMatchObject({ state: 'resolved', object });
    expect(committed).toEqual(['resolved']);
    expect(external.mutations).toBe(1);
  });

  it('rejects manual decisions for a released intent after recovery starts a new attempt', async () => {
    const external = await useExternalEndpoint({
      object,
      beforeMutation: async ({ content }) =>
        content === 'first' ? { notWritten: { code: 'busy', reason: 'Try later', retryable: true } } : undefined,
    });
    const original = writeRequest({ content: 'first', participant: { name: participantName, data: null } });
    await interrupt(external, original);
    const committed: string[] = [];
    const { client, bus } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            if (change.to === 'written') throw new Error('Binding conflict');
            committed.push(change.to);
          },
        }),
      },
    });
    const first = await readRecord(client, original);
    const { writeRecordId } = first;
    expect(await client.writes.write(client.call, { ...original, content: 'next' })).toEqual({
      error: 'unresolved',
      writeRecordId,
    });
    const next = await readRecord(client, original);
    expect(next).toMatchObject({ writeRecordId, state: 'unresolved', object });
    expect(next.intentId).not.toBe(first.intentId);
    expect(
      await bus.request(JournalSubjects['resolve-write'], {
        writeRecordId,
        intentId: first.intentId,
        resolution: { notWritten: true },
      }),
    ).toEqual({ success: false, code: 'stale-intent' });
    expect(await readRecord(client, original)).toEqual(next);
    expect(committed).toEqual(['released', 'intended', 'unresolved']);
    expect(
      await bus.request(JournalSubjects['resolve-write'], {
        writeRecordId,
        intentId: next.intentId,
        resolution: { found: object },
      }),
    ).toMatchObject({ success: true, record: { state: 'resolved', object, intentId: next.intentId } });
    expect(committed).toEqual(['released', 'intended', 'unresolved', 'resolved']);
    expect(external.mutations).toBe(1);
  });

  it('returns credential-unavailable when the credential resolver throws during recovery', async () => {
    const external = await useExternalEndpoint({ object });
    const request = writeRequest({ participant: { name: participantName, data: null } });
    await interrupt(external, request);
    const { client } = await start(external, {
      participant: { name: participantName, prepare: async () => ({ commit: async () => {} }) },
      beforeCredential: async () => {
        throw new Error('Credential source unavailable');
      },
    });
    const before = await readRecord(client, request);
    expect(await client.writes.write(client.call, request)).toEqual({
      error: 'transient',
      reason: 'credential-unavailable',
    });
    expect(await readRecord(client, request)).toEqual(before);
    expect(external.lookups).toBe(0);
    expect(external.writes).toBe(1);
  });

  it.each(['absent', 'found'] as const)('admits changed participant data after %s', async (lookup) => {
    let refuse = lookup === 'absent';
    const external = await useExternalEndpoint({
      object,
      beforeMutation: async () =>
        refuse ? { notWritten: { code: 'busy', reason: 'Try later', retryable: true } } : undefined,
    });
    const request = writeRequest({ participant: { name: participantName, data: 'original' } });
    await interrupt(external, request);
    refuse = false;

    const transitions: string[] = [];
    const { client } = await start(external, {
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            transitions.push(`${change.to}:${String(change.data)}`);
          },
        }),
      },
    });
    const next = { ...request, participant: { name: participantName, data: 'replacement' } };
    expect(await client.writes.write(client.call, next)).toEqual({ outcome: 'written', object });
    expect(transitions).toEqual([
      `${lookup === 'found' ? 'written' : 'released'}:original`,
      'intended:replacement',
      'written:replacement',
    ]);
    expect(external.lookups).toBe(1);
    expect(external.writes).toBe(2);
  });

  it.each(['target', 'purpose', 'content'] as const)('admits changed %s after an absent intent', async (field) => {
    let refuse = true;
    const external = await useExternalEndpoint({
      object,
      beforeMutation: async () =>
        refuse ? { notWritten: { code: 'busy', reason: 'Try later', retryable: true } } : undefined,
    });
    const request = writeRequest({ checksum: 'first', participant: { name: participantName, data: null } });
    await interrupt(external, request);
    refuse = false;
    const { client } = await start(external, {
      participant: { name: participantName, prepare: async () => ({ commit: async () => {} }) },
    });
    const next = {
      ...request,
      ...(field === 'target' && { credential: { ...request.credential, target: { scope: 'other' } } }),
      ...(field === 'purpose' && { credential: { purpose: 'example.other' } }),
      ...(field === 'content' && { content: 'different body' }),
    };
    const result = await client.writes.write(client.call, next);
    if (field === 'purpose') {
      expect(result).toEqual({ error: 'transient', reason: 'credential-unavailable' });
      expect(await readRecord(client, request)).toMatchObject({ state: 'released' });
      expect(external.writes).toBe(1);
    } else {
      expect(result).toEqual({ outcome: 'written', object });
      expect(external.writes).toBe(2);
    }
    expect(external.lookups).toBe(1);
  });

  it.each(['found', 'undecidable'] as const)('records a late %s lookup result', async (lookup) => {
    const external = await useExternalEndpoint({
      object,
      lookup: lookup === 'undecidable' ? lookup : undefined,
      afterLookup: async ({ deadline }) => waitForDeadline(Date.parse(deadline)),
    });
    const request = writeRequest({ participant: { name: participantName, data: null } });
    await interrupt(external, request);
    const { client } = await start(external, {
      deadline: () => Date.now() + 500,
      participant: { name: participantName, prepare: async () => ({ commit: async () => {} }) },
    });
    const result = await client.writes.write(client.call, request);
    const row = await readRecord(client, request);
    if (lookup === 'found') {
      expect(result).toEqual({ outcome: 'unchanged', object });
      expect(row).toMatchObject({ state: 'written', object });
    } else {
      expect(result).toEqual({ error: 'unresolved', writeRecordId: row.writeRecordId });
      expect(row).toMatchObject({ state: 'unresolved' });
    }
    expect(external.lookups).toBe(1);
    expect(external.writes).toBe(1);
  });

  it('records a late written response', async () => {
    const external = await useExternalEndpoint({
      object,
      afterMutation: async ({ deadline }) => waitForDeadline(Date.parse(deadline)),
    });
    const { client } = await start(external, { deadline: () => Date.now() + 500 });
    const request = writeRequest();
    expect(await client.writes.write(client.call, request)).toEqual({ outcome: 'written', object });
    expect(await readRecord(client, request)).toMatchObject({ state: 'written', object });
    expect(external.mutations).toBe(1);
    expect(external.lookups).toBe(0);
  });

  it.each([
    { retryable: false, state: 'not-written', result: { error: 'not-written', code: 'refused', reason: 'Refused' } },
    { retryable: true, state: 'released', result: { error: 'transient', reason: 'Refused' } },
  ])('records late notWritten as $state', async ({ retryable, state, result }) => {
    const external = await useExternalEndpoint({
      beforeMutation: async ({ deadline }) => {
        await waitForDeadline(Date.parse(deadline));
        return { notWritten: { code: 'refused', reason: 'Refused', retryable } };
      },
    });
    const { client } = await start(external, { deadline: () => Date.now() + 500 });
    const request = writeRequest();
    expect(await client.writes.write(client.call, request)).toEqual(result);
    expect(await readRecord(client, request)).toMatchObject({ state });
    expect(external.mutations).toBe(0);
    expect(external.lookups).toBe(0);
  });

  it.each(['unknown', 'throws'] as const)('keeps the intent open when a late write %s', async (result) => {
    const external = await useExternalEndpoint({
      object,
      beforeMutation: async ({ deadline }) => {
        await waitForDeadline(Date.parse(deadline));
        if (result === 'throws') throw new Error('Writer interrupted');
        return { unknown: 'Write could not be confirmed' };
      },
    });
    const first = await start(external, { deadline: () => Date.now() + 500 });
    const request = writeRequest();
    expect(await first.client.writes.write(first.client.call, request)).toEqual(expired);
    expect(await readRecord(first.client, request)).toMatchObject({ state: 'intended' });
    expect(external.lookups).toBe(0);

    const { client } = await start(external);
    expect(await client.writes.write(client.call, request)).toEqual({ error: 'transient', reason: 'write-not-found' });
    expect(await readRecord(client, request)).toMatchObject({ state: 'released' });
    expect(external.lookups).toBe(1);
    expect(external.writes).toBe(1);
    expect(external.mutations).toBe(0);
  });

  it('rejects a different target without recovering the old intent', async () => {
    const external = await useExternalEndpoint({ object });
    const request = writeRequest({ participant: { name: participantName, data: null } });
    await interrupt(external, request);
    const { client } = await start(external);
    const before = await readRecord(client, request);
    const other = { ...parent, externalId: 'other-parent' };
    expect(
      await client.writes.write(client.call, {
        ...request,
        target: { create: { site: parent.site, objectType: 'child', parent: other } },
      }),
    ).toEqual({ error: 'invalid-request', reason: 'key-target-mismatch' });
    expect(await readRecord(client, request)).toEqual(before);
    expect(external.lookups).toBe(0);
    expect(external.mutations).toBe(1);
  });

  for (const lookup of [
    'absent',
    'contradictory',
    'throws',
    'aborted',
    'late',
    'late-release',
    'credential-expired',
  ] as const) {
    it(`handles ${lookup} while recovering an intent with no external write`, async () => {
      let refuse = true;
      let interruptLookup = true;
      const external = await useExternalEndpoint({
        lookup: lookup === 'contradictory' ? lookup : undefined,
        beforeMutation: async () =>
          refuse
            ? {
                notWritten: { code: 'busy', reason: 'Try later', retryable: true },
              }
            : undefined,
        afterLookup: async ({ deadline }) => {
          if (!interruptLookup) return;
          if (lookup === 'late' || lookup === 'aborted') await waitForDeadline(Date.parse(deadline));
          if (lookup === 'throws') throw new Error('Lookup interrupted');
          if (lookup === 'aborted') throw new DOMException('Lookup aborted', 'AbortError');
        },
      });
      const request = writeRequest({ checksum: 'first', participant: { name: participantName, data: null } });
      await interrupt(external, request);
      expect(external.mutations).toBe(0);
      refuse = false;

      let deadline = 0;
      const participant = {
        name: participantName,
        prepare: async () => ({ commit: async () => {} }),
      };
      const { client } = await start(external, {
        deadline: () => (deadline = Date.now() + 500),
        beforeCredential: async () => {
          if (lookup === 'credential-expired') await waitForDeadline(deadline);
        },
        participant:
          lookup === 'late-release'
            ? {
                name: participantName,
                prepare: async (_call, change) => ({
                  commit: async () => {
                    if (change.to === 'released') await waitForDeadline(deadline);
                  },
                }),
              }
            : participant,
      });
      const next = { ...request, checksum: 'next', content: 'replacement body' };
      const before = await readRecord(client, request);
      const result = await client.writes.write(client.call, next);
      if (lookup === 'absent') {
        expect(external.lookups).toBe(1);
        expect(result).toMatchObject({ outcome: 'written' });
        expect(external.mutations).toBe(1);
      } else if (lookup !== 'contradictory') {
        expect(result).toEqual(lookup === 'throws' ? { error: 'transient', reason: 'write-lookup-failed' } : expired);
        expect(await readRecord(client, request)).toEqual(before);
        expect(external.lookups).toBe(lookup === 'credential-expired' ? 0 : 1);
        expect(external.mutations).toBe(0);
        if (lookup === 'late' || lookup === 'throws' || lookup === 'aborted') {
          interruptLookup = false;
          const fresh = await start(external, { participant });
          expect(await fresh.client.writes.write(fresh.client.call, next)).toMatchObject({ outcome: 'written' });
          expect(external.lookups).toBe(2);
          expect(external.mutations).toBe(1);
        }
      } else {
        expect(result).toMatchObject({ error: 'unresolved' });
        expect(await readRecord(client, request)).toMatchObject({ state: 'unresolved' });
        expect(external.lookups).toBe(1);
        expect(external.mutations).toBe(0);
      }
    });
  }

  it('releases an intent when its deadline passes before the writer is called', async () => {
    let deadline = 0;
    const external = await useExternalEndpoint();
    const request = writeRequest({ participant: { name: participantName, data: null } });
    const { client } = await start(external, {
      deadline: () => (deadline = Date.now() + 500),
      participant: {
        name: participantName,
        prepare: async (_call, change) => ({
          commit: async () => {
            if (change.to === 'intended') await waitForDeadline(deadline);
          },
        }),
      },
    });
    expect(await client.writes.write(client.call, request)).toEqual(expired);
    expect(await readRecord(client, request)).toMatchObject({ state: 'released' });
    expect(external.lookups).toBe(0);
    expect(external.writes).toBe(0);
    expect(external.mutations).toBe(0);
  });
});
