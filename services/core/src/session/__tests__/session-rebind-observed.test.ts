/**
 * Cross-backend tests for `storage:session.rebindObserved` — the write a
 * *continuation* of an already known external session produces.
 *
 * Covers:
 * - locality refresh: working directory, transcript path and owning machine
 *   follow the runtime that continued the session.
 * - everything an import owns survives a rebind: origin identity, lineage,
 *   importStatus, lifecycle status, createdAt and metadata.
 * - absent locality fields leave stored values untouched (no NULL erasure).
 * - `'not-found'` is a modeled outcome: no row is invented for an unknown
 *   `(source, externalSessionId)` identity.
 * - a rebind that changed something emits `session.updated`, never
 *   `session.created`.
 *
 * Runs against BOTH storage backends (in-memory handlers and Drizzle over a
 * temp SQLite database) to pin behavioral parity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { createTestDb } from '../storage/__tests__/shared.js';

/** Root-lineage identity fields shared by all importUpsert calls in this suite. */
const ROOT_LINEAGE = {
  kind: 'root',
  parentAdapterSessionId: null,
  forkPointMessageId: null,
} as const;

/** Source identity every session in this suite is imported under. */
const SOURCE = 'claude-code-cli';

interface BackendHarness {
  name: string;
  setup: () => Promise<() => void>;
}

const backends: BackendHarness[] = [
  {
    name: 'memory',
    setup: async () => registerMemorySessionStorage(MakaioBus),
  },
  {
    name: 'drizzle (sqlite)',
    setup: async () => (await createTestDb()).cleanup,
  },
];

describe.each(backends)('session.rebindObserved [$name]', ({ setup }) => {
  let cleanup: () => void;

  beforeEach(async () => {
    cleanup = await setup();
  });

  afterEach(() => cleanup());

  /**
   * Register a tracked observed session to rebind against.
   * @param externalSessionId - External session id to register
   * @returns The generated Makaio session id
   */
  async function registerObserved(externalSessionId: string): Promise<string> {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId,
      source: SOURCE,
      clientId: 'claude-code',
      cwd: '/repo/main',
      logFilePath: `/logs/main/${externalSessionId}.jsonl`,
      machineId: 'machine-a',
      startedAt: 1_000,
      metadata: { keep: true },
      importStatus: 'tracking',
      activation: 'live',
    });
    return sessionId;
  }

  it('refreshes locality and leaves everything an import owns untouched', async () => {
    const sessionId = await registerObserved('ext-rebind');

    const result = await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-rebind',
      source: SOURCE,
      cwd: '/repo/worktree',
      logFilePath: '/logs/worktree/ext-rebind.jsonl',
      machineId: 'machine-b',
    });
    expect(result).toEqual({ outcome: 'rebound', sessionId });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    // Locality follows the continuing runtime …
    expect(session?.targetWorkingDirectory).toBe('/repo/worktree');
    expect(session?.logFilePath).toBe('/logs/worktree/ext-rebind.jsonl');
    expect(session?.machineId).toBe('machine-b');
    // … while origin, lineage, import lifecycle and content stay put.
    expect(session?.source).toBe(SOURCE);
    expect(session?.adapterSessionId).toBe('ext-rebind');
    expect(session?.branchKind).toBeUndefined();
    expect(session?.parentExternalSessionId).toBeUndefined();
    expect(session?.isImported).toBe(true);
    expect(session?.importStatus).toBe('tracking');
    expect(session?.status).toBe('active');
    expect(session?.createdAt).toBe(1_000);
    expect(session?.metadata).toEqual({ keep: true });
  });

  it('leaves stored locality untouched for fields the continuation does not report', async () => {
    const sessionId = await registerObserved('ext-partial');

    const result = await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-partial',
      source: SOURCE,
      cwd: '/repo/worktree',
    });
    expect(result).toEqual({ outcome: 'rebound', sessionId });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.targetWorkingDirectory).toBe('/repo/worktree');
    expect(session?.logFilePath).toBe('/logs/main/ext-partial.jsonl');
    expect(session?.machineId).toBe('machine-a');
  });

  it('reports the identity without writing when no locality evidence is supplied', async () => {
    const sessionId = await registerObserved('ext-evidenceless');

    const result = await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-evidenceless',
      source: SOURCE,
    });
    expect(result).toEqual({ outcome: 'rebound', sessionId });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.targetWorkingDirectory).toBe('/repo/main');
    expect(session?.machineId).toBe('machine-a');
  });

  it('relinquishes machine ownership when the continuation clears it', async () => {
    const sessionId = await registerObserved('ext-unowned');

    await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-unowned',
      source: SOURCE,
      machineId: null,
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.machineId).toBeUndefined();
  });

  it('reports not-found for an unknown identity without creating a row', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-unknown',
      source: SOURCE,
      cwd: '/repo/worktree',
    });
    expect(result).toEqual({ outcome: 'not-found' });

    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, { source: SOURCE });
    expect(sessions).toEqual([]);
  });

  it('does not cross the source boundary of the import identity', async () => {
    await registerObserved('ext-scoped');

    const result = await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
      externalSessionId: 'ext-scoped',
      source: 'other-cli',
      cwd: '/elsewhere',
    });
    expect(result).toEqual({ outcome: 'not-found' });

    const stored = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'ext-scoped',
      source: SOURCE,
    });
    expect(stored.session?.targetWorkingDirectory).toBe('/repo/main');
  });

  it('emits session.updated naming the reported locality and never session.created', async () => {
    const createdEvents: string[] = [];
    const updatedEvents: Array<{ sessionId: string; changedProperties: string[] }> = [];
    const sessionId = await registerObserved('ext-events');

    const offCreated = MakaioBus.on(SessionSubjects.created, (ctx) => {
      createdEvents.push(ctx.payload.sessionId);
    });
    const offUpdated = MakaioBus.on(SessionSubjects.updated, (ctx) => {
      updatedEvents.push({ sessionId: ctx.payload.sessionId, changedProperties: ctx.payload.changedProperties });
    });

    try {
      await MakaioBus.request(SessionStorageSubjects.rebindObserved, {
        externalSessionId: 'ext-events',
        source: SOURCE,
        cwd: '/repo/worktree',
      });

      await vi.waitFor(() => {
        expect(updatedEvents).toEqual([{ sessionId, changedProperties: ['targetWorkingDirectory'] }]);
      });
      expect(createdEvents).toEqual([]);
    } finally {
      offUpdated();
      offCreated();
    }
  });
});
