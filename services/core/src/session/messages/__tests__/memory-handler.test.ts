import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectPayload } from '@makaio/core';
import { MessageStorageSubjects } from '../namespace.js';
import { registerMemoryMessageStorage } from '../memory-handler.js';

describe('registerMemoryMessageStorage', () => {
  let cleanup: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = registerMemoryMessageStorage(MakaioBus);
  });

  afterEach(() => {
    cleanup();
    MakaioBus.__resetHandlers?.();
  });

  it('scopes adapter-message upserts per session', async () => {
    const sharedAdapterMessageId = 'shared-ancestor-record';

    const first = await MakaioBus.request(
      MessageStorageSubjects.upsertByAdapterMessageId,
      makeUpsert('session-a', sharedAdapterMessageId),
    );
    const second = await MakaioBus.request(
      MessageStorageSubjects.upsertByAdapterMessageId,
      makeUpsert('session-b', sharedAdapterMessageId),
    );
    const duplicate = await MakaioBus.request(
      MessageStorageSubjects.upsertByAdapterMessageId,
      makeUpsert('session-a', sharedAdapterMessageId),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.messageId).not.toBe(first.messageId);
    expect(duplicate).toEqual({ messageId: first.messageId, created: false });

    const sessionA = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: 'session-a' });
    const sessionB = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: 'session-b' });
    expect(sessionA.messages.map((message) => message.messageId)).toEqual([first.messageId]);
    expect(sessionB.messages.map((message) => message.messageId)).toEqual([second.messageId]);
  });

  it('attaches an existing unassigned adapter message to a later imported turn', async () => {
    const first = await MakaioBus.request(
      MessageStorageSubjects.upsertByAdapterMessageId,
      makeUpsert('session-a', 'partial-user-record'),
    );
    const second = await MakaioBus.request(MessageStorageSubjects.upsertByAdapterMessageId, {
      ...makeUpsert('session-a', 'partial-user-record'),
      turnId: 'turn-1',
    });

    expect(second).toEqual({ messageId: first.messageId, created: false });
    const byTurn = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: 'turn-1' });
    expect(byTurn.messages.map((message) => message.messageId)).toEqual([first.messageId]);
  });
});

/**
 * Build a minimal adapter-message upsert payload for memory storage tests.
 * @param sessionId - Session that should own the message.
 * @param adapterMessageId - Adapter message identity to upsert.
 * @returns Message upsert request payload.
 */
function makeUpsert(
  sessionId: string,
  adapterMessageId: string,
): ExtractSubjectPayload<typeof MessageStorageSubjects.upsertByAdapterMessageId> {
  return {
    adapterMessageId,
    sessionId,
    turnId: null,
    role: 'user',
    contentText: `message for ${sessionId}`,
    blocks: [],
    timestamp: 1_000,
  };
}
