/**
 * Observed continuations reopen the session they continue — end to end.
 *
 * The ingestion service, the ownership authority and the in-memory session
 * storage are all real; only the log-import seams, contributed by another
 * package at runtime, are stubbed. What is under test is the wiring: a rebind
 * that succeeds is *evidence the conversation is still in use*, and the row it
 * lands on is the lineage root, never a synthesized compress child.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, SessionSubjects, type ClientSessionStarted, type IMakaioSession } from '@makaio/contracts';
import { LogImportTriggerSubjects } from '../log-import-trigger-subjects.js';
import { ObservedSessionIngestionService } from '../observed-session-ingestion.js';
import { registerSessionOwnershipAuthority } from '../ownership/index.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';

/** Client id advertised by the stubbed importer registration. */
const CLIENT_ID = 'continuation-client';
/** Importer adapter name — the `source` identity imports register under. */
const ADAPTER_NAME = 'continuation-cli';
/** External session id shared by every observation in this suite. */
const EXTERNAL_ID = 'ext-continuation';

describe('ObservedSessionIngestionService - continuation reopen', () => {
  let bus: IMakaioBus;
  let service: ObservedSessionIngestionService;
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    bus = createBusInstance();
    cleanups = [
      registerMemorySessionStorage(bus),
      registerSessionOwnershipAuthority({ bus, machineId: 'continuation-machine', topology: 'shared-machine' }),
      bus.on(LogImportTriggerSubjects.listImporters, (ctx) => {
        ctx.setResult({ importers: [{ adapterName: ADAPTER_NAME, clientId: CLIENT_ID }] });
      }),
      bus.on(LogImportTriggerSubjects.importFile, (ctx) => {
        ctx.setResult({ status: 'imported', sessionId: 'imported', messageCount: 0, turnCount: 0 });
      }),
      bus.on(LogImportTriggerSubjects.importSession, (ctx) => {
        ctx.setResult({ sessionId: 'imported', messageCount: 0 });
      }),
    ];
    service = new ObservedSessionIngestionService(bus);
  });

  afterEach(() => {
    service.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Emit a `client.session.started` observation.
   * @param overrides - Payload field overrides
   */
  async function emitSessionStarted(overrides?: Partial<ClientSessionStarted>): Promise<void> {
    await bus.emit(ClientSubjects.session.started, {
      clientId: CLIENT_ID,
      source: 'native-hook',
      observedAt: 1_000,
      adapterSessionId: EXTERNAL_ID,
      ...overrides,
    });
  }

  /**
   * Import a root session so a continuation has something to rebind onto.
   * @param externalSessionId - External identity of the imported row
   * @returns The Makaio session id of the created row
   */
  async function importRoot(externalSessionId: string): Promise<string> {
    const { sessionId } = await bus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId,
      source: ADAPTER_NAME,
      cwd: '/repo',
      startedAt: 500,
    });
    return sessionId;
  }

  /**
   * Read one session row by its Makaio id.
   * @param sessionId - Row to read
   * @returns The stored row, or null
   */
  async function readSession(sessionId: string): Promise<IMakaioSession | null> {
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
    return session;
  }

  it('reopens a closed session and announces the change when a resume is observed', async () => {
    // Case 49. A resume is direct evidence the conversation is still in use,
    // which a `closed` row contradicts.
    const sessionId = await importRoot(EXTERNAL_ID);
    await bus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

    const updates: string[][] = [];
    cleanups.push(
      bus.on(SessionSubjects.updated, (ctx) => {
        if (ctx.payload.sessionId === sessionId) updates.push(ctx.payload.changedProperties);
      }),
    );

    await emitSessionStarted({ startMode: 'resume', cwd: '/worktree' });

    const reopened = await readSession(sessionId);
    expect(reopened?.status).toBe('active');
    // The rebind's own effect still lands: locality follows the continuing
    // runtime, and reopening does not replace that.
    expect(reopened?.targetWorkingDirectory).toBe('/worktree');
    // The rebind announces its own locality change first; the reopen follows.
    expect(updates).toContainEqual(['status']);
  });

  it('leaves an archived session archived', async () => {
    // Case 50. Archiving is a deliberate user act with its own restore path,
    // and an observation must not undo a decision.
    const sessionId = await importRoot(EXTERNAL_ID);
    await bus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });
    await bus.request(SessionStorageSubjects.update, { sessionId, status: 'archived' });

    await emitSessionStarted({ startMode: 'resume' });

    expect((await readSession(sessionId))?.status).toBe('archived');
  });

  it('acts on the lineage root when a compaction is observed on a compress child', async () => {
    // Case 51. Compaction is in place — same provider session, same transcript
    // — so the rebind resolves to the row that carries the provider identity,
    // and the synthesized compress children carry no currency at all.
    const rootId = await importRoot(EXTERNAL_ID);
    await bus.request(SessionStorageSubjects.update, { sessionId: rootId, status: 'closed' });

    const childId = 'compress-child';
    await bus.request(SessionStorageSubjects.set, {
      sessionId: childId,
      session: {
        sessionId: childId,
        createdAt: 900,
        lastActivityAt: 900,
        agents: [],
        status: 'closed',
        branchKind: 'compress',
        parentSessionId: rootId,
        rootSessionId: rootId,
      },
    });

    const continuation = await bus.request(SessionSubjects.ownership.continuation, {
      sessionId: childId,
      startMode: 'compact',
    });

    expect(continuation).toEqual({ outcome: 'reopened', sessionId: rootId });
    expect((await readSession(rootId))?.status).toBe('active');
    // Untouched: the child is a view of a conversation that lives on its root.
    const child = await readSession(childId);
    expect(child?.status).toBe('closed');
    expect(child?.adapterSessionId).toBeUndefined();
  });

  it('reports nothing to the authority when the rebind finds no row', async () => {
    // A continuation of a session storage has never seen creates nothing, so
    // there is no row for the authority to act on either.
    const reported: string[] = [];
    const spy = bus.on(
      SessionSubjects.ownership.continuation,
      (ctx) => {
        reported.push(ctx.payload.sessionId);
      },
      { priority: 100 },
    );
    try {
      await emitSessionStarted({ startMode: 'resume', adapterSessionId: 'never-seen' });
    } finally {
      spy();
    }

    const { session } = await bus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'never-seen',
      source: ADAPTER_NAME,
    });
    expect(session).toBeNull();
    // The assertion the absent row cannot make on its own: the authority was
    // never asked, so nothing could have been acted on anywhere.
    expect(reported).toEqual([]);
  });

  it('keeps the rebind when the authority throws', async () => {
    // The continuation is advisory. The rebind is the durable act, and the
    // tracking-stub reconciliation runs after this call — a propagated failure
    // would skip both over a status refresh that is allowed to fail.
    const rootId = await importRoot(EXTERNAL_ID);
    await bus.request(SessionStorageSubjects.update, { sessionId: rootId, status: 'closed' });
    const failing = bus.on(
      SessionSubjects.ownership.continuation,
      () => {
        throw new Error('authority exploded');
      },
      { priority: 100 },
    );
    try {
      await emitSessionStarted({ startMode: 'resume', cwd: '/moved/cwd' });
    } finally {
      failing();
    }

    // The rebind landed despite the refusal, and the row is left as the failed
    // reopen found it.
    const stored = await readSession(rootId);
    expect(stored?.targetWorkingDirectory).toBe('/moved/cwd');
    expect(stored?.status).toBe('closed');
  });
});
