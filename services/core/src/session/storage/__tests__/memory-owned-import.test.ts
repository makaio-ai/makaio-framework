import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { ImportUpsertRequest } from '@makaio/contracts';
import { registerMemorySessionStorage } from '../memory-handler.js';
import { createSessionStorageMemoryState } from '../memory-store.js';
import { SessionStorageSubjects } from '../namespace.js';

const OWNER_A = 'principal-a';
const OWNER_B = 'principal-b';

/**
 * Build a root import request with a source-scoped external identity.
 * @param externalSessionId - Provider-native session ID.
 * @param title - Imported session title.
 * @param metadata - Imported session metadata.
 * @param activation - Optional initial lifecycle activation.
 * @returns Valid import request.
 */
function createImport(
  externalSessionId: string,
  title: string,
  metadata: ImportUpsertRequest['metadata'],
  activation?: 'live',
): ImportUpsertRequest {
  return {
    externalSessionId,
    source: 'claude-code',
    cwd: '/workspace',
    title,
    metadata,
    kind: 'root',
    parentAdapterSessionId: null,
    forkPointMessageId: null,
    ...(activation === undefined ? {} : { activation }),
  };
}

describe('memory principal-owned import storage', () => {
  let cleanup: () => void;
  let state: ReturnType<typeof createSessionStorageMemoryState>;

  beforeEach(() => {
    state = createSessionStorageMemoryState();
    cleanup = registerMemorySessionStorage(MakaioBus, state);
  });

  afterEach(() => {
    cleanup();
  });

  it('creates an owned row and recognizes a retry by its owner', async () => {
    const importRequest = createImport('owned-create', 'Original title', { origin: 'hook' });

    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: importRequest,
    });
    const retried = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: importRequest,
    });

    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') throw new Error('expected the first owned import to create a row');
    expect(retried).toEqual({ outcome: 'owned', sessionId: created.sessionId });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: created.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'owned',
    });
  });

  it('refuses a foreign registration without enriching or changing the existing row', async () => {
    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: createImport('foreign-conflict', 'Owner title', { origin: 'owner' }),
    });
    if (created.outcome !== 'created') throw new Error('expected the owner import to create a row');

    const before = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: created.sessionId });
    const foreign = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_B,
      import: createImport('foreign-conflict', 'Foreign title', { origin: 'foreign' }, 'live'),
    });
    const after = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: created.sessionId });

    expect(foreign).toEqual({ outcome: 'foreign' });
    expect(state.sessions.size).toBe(1);
    expect(after.session).toEqual(before.session);
    expect(after.session).toMatchObject({
      title: 'Owner title',
      metadata: { origin: 'owner' },
      status: 'discovered',
    });
  });

  it('leaves legacy imports unowned and reports every ownership relationship', async () => {
    const imported = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...createImport('legacy-import', 'Legacy title', { origin: 'watcher' }),
      startedAt: 1_000,
    });

    expect(state.sessionOwnerPrincipalIds.has(imported.sessionId)).toBe(false);
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: 'missing-session',
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'missing',
    });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: imported.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'unowned',
    });

    const owned = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: createImport('owned-verification', 'Owned title', { origin: 'owner' }),
    });
    if (owned.outcome !== 'created') throw new Error('expected the owned verification fixture to create a row');
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: owned.sessionId,
        ownerPrincipalId: OWNER_B,
      }),
    ).toEqual({
      outcome: 'foreign',
    });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: owned.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'owned',
    });
  });

  it('preserves ownership across ordinary import enrichment, update, and set', async () => {
    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: createImport('preserve-owner', 'Initial title', { initial: true }),
    });
    if (created.outcome !== 'created') throw new Error('expected the owned import to create a row');

    const enriched = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...createImport('preserve-owner', 'Enriched title', { enrichment: true }, 'live'),
      startedAt: 2_000,
    });
    expect(enriched).toEqual({ sessionId: created.sessionId, created: false });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: created.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'owned',
    });

    const update = await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: created.sessionId,
      title: 'Updated title',
    });
    expect(update.success).toBe(true);
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: created.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'owned',
    });

    const beforeSet = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: created.sessionId });
    if (beforeSet.session === null) throw new Error('expected the owned session before generic set');
    const set = await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: created.sessionId,
      session: { ...beforeSet.session, title: 'Set title' },
    });

    expect(set.success).toBe(true);
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: created.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'owned',
    });
  });

  it('clears ownership on delete so a reused import identity has no stale authority', async () => {
    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_A,
      import: createImport('reused-identity', 'Original owner title', { owner: 'a' }),
    });
    if (created.outcome !== 'created') throw new Error('expected the owned import to create a row');

    const deleted = await MakaioBus.request(SessionStorageSubjects.delete, { sessionId: created.sessionId });
    expect(deleted.success).toBe(true);

    const reused = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: OWNER_B,
      import: createImport('reused-identity', 'New owner title', { owner: 'b' }),
    });
    if (reused.outcome !== 'created') throw new Error('expected the reused identity to create a new owned row');

    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: reused.sessionId,
        ownerPrincipalId: OWNER_A,
      }),
    ).toEqual({
      outcome: 'foreign',
    });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: reused.sessionId,
        ownerPrincipalId: OWNER_B,
      }),
    ).toEqual({
      outcome: 'owned',
    });
  });
});
