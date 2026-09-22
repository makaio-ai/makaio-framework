import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects, type ImportUpsertRequest } from '@makaio/contracts';
import type { SessionStorageRegisterOwnedImportResult } from '@makaio/contracts/session';
import { useDrizzleTestLifecycle } from './shared.js';

type RootImport = Extract<ImportUpsertRequest, { kind: 'root' }>;

function importPayload(externalSessionId: string, overrides: Partial<RootImport> = {}): RootImport {
  return {
    kind: 'root',
    externalSessionId,
    source: 'claude-code',
    parentAdapterSessionId: null,
    forkPointMessageId: null,
    cwd: '/initial',
    startedAt: 1_000,
    title: 'Initial import',
    metadata: { origin: 'initial' },
    ...overrides,
  };
}

function requireCreatedSessionId(result: SessionStorageRegisterOwnedImportResult): string {
  if (result.outcome !== 'created') {
    throw new Error(`Expected an owned import to be created, received ${result.outcome}`);
  }
  return result.sessionId;
}

describe('Drizzle owned import registration', () => {
  useDrizzleTestLifecycle();

  it('creates a fresh owned import, accepts the owner retry, and rejects a foreign principal', async () => {
    const importRequest = importPayload('owned-fresh');

    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-a',
      import: importRequest,
    });
    const retried = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-a',
      import: importPayload('owned-fresh', { title: 'Must not enrich' }),
    });
    const foreign = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-b',
      import: importPayload('owned-fresh', { title: 'Must not enrich' }),
    });

    expect(created).toMatchObject({ outcome: 'created' });
    expect(retried).toEqual({ outcome: 'owned', sessionId: requireCreatedSessionId(created) });
    expect(foreign).toEqual({ outcome: 'foreign' });
  });

  it('does not enrich an existing legacy unowned import during registration', async () => {
    const legacy = await MakaioBus.request(SessionStorageSubjects.importUpsert, importPayload('legacy-unowned'));

    const registration = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-a',
      import: importPayload('legacy-unowned', {
        cwd: '/attempted-overwrite',
        title: 'Attempted overwrite',
        metadata: { origin: 'attempted-overwrite' },
        startedAt: 9_000,
      }),
    });
    const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: legacy.sessionId });

    expect(registration).toEqual({ outcome: 'unowned' });
    expect(stored.session).toMatchObject({
      sessionId: legacy.sessionId,
      targetWorkingDirectory: '/initial',
      title: 'Initial import',
      metadata: { origin: 'initial' },
      createdAt: 1_000,
    });
  });

  it('reports ownership through read-only outcomes without exposing the stored principal', async () => {
    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-a',
      import: importPayload('verify-outcomes'),
    });
    const unowned = await MakaioBus.request(SessionStorageSubjects.importUpsert, importPayload('verify-unowned'));
    const sessionId = requireCreatedSessionId(created);

    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId,
        ownerPrincipalId: 'principal-a',
      }),
    ).toEqual({ outcome: 'owned' });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId,
        ownerPrincipalId: 'principal-b',
      }),
    ).toEqual({ outcome: 'foreign' });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: unowned.sessionId,
        ownerPrincipalId: 'principal-a',
      }),
    ).toEqual({ outcome: 'unowned' });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: 'missing-session',
        ownerPrincipalId: 'principal-a',
      }),
    ).toEqual({ outcome: 'missing' });
  });

  it('preserves a principal owner through ordinary import enrichment and session updates', async () => {
    const created = await MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
      ownerPrincipalId: 'principal-a',
      import: importPayload('owner-survives-writes'),
    });
    const sessionId = requireCreatedSessionId(created);

    await MakaioBus.request(
      SessionStorageSubjects.importUpsert,
      importPayload('owner-survives-writes', {
        cwd: '/enriched',
        title: 'Enriched import',
      }),
    );
    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId,
      title: 'Updated session',
    });

    const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(stored.session).toMatchObject({
      targetWorkingDirectory: '/enriched',
      title: 'Updated session',
    });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId,
        ownerPrincipalId: 'principal-a',
      }),
    ).toEqual({ outcome: 'owned' });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId,
        ownerPrincipalId: 'principal-b',
      }),
    ).toEqual({ outcome: 'foreign' });
  });

  it('never transfers ownership when principals concurrently register one import identity', async () => {
    const [first, second] = await Promise.all([
      MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
        ownerPrincipalId: 'principal-a',
        import: importPayload('concurrent-owned-import'),
      }),
      MakaioBus.request(SessionStorageSubjects.registerOwnedImport, {
        ownerPrincipalId: 'principal-b',
        import: importPayload('concurrent-owned-import'),
      }),
    ]);

    if (first.outcome === 'created') {
      expect(second).toEqual({ outcome: 'foreign' });
      expect(
        await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
          sessionId: first.sessionId,
          ownerPrincipalId: 'principal-a',
        }),
      ).toEqual({ outcome: 'owned' });
      expect(
        await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
          sessionId: first.sessionId,
          ownerPrincipalId: 'principal-b',
        }),
      ).toEqual({ outcome: 'foreign' });
      return;
    }

    expect(first).toEqual({ outcome: 'foreign' });
    expect(second.outcome).toBe('created');
    if (second.outcome !== 'created') {
      throw new Error('one concurrent owner registration must create the import');
    }
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: second.sessionId,
        ownerPrincipalId: 'principal-b',
      }),
    ).toEqual({ outcome: 'owned' });
    expect(
      await MakaioBus.request(SessionStorageSubjects.verifyOwner, {
        sessionId: second.sessionId,
        ownerPrincipalId: 'principal-a',
      }),
    ).toEqual({ outcome: 'foreign' });
  });
});
