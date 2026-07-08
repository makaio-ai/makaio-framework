/**
 * Cross-backend tests for the unified registration seam on
 * `storage:session.importUpsert` (hook-first registration + import enrichment).
 *
 * Covers:
 * - AC14: metadata supplied at hook-first registration is preserved; later
 *   import enrichment merges (existing keys win) instead of overwriting.
 * - importStatus is never downgraded ('tracking' survives 'discovered' enrichment).
 * - isSidechain enrichment: defined incoming values win, absent input keeps stored.
 * - Idempotency on the (source, externalSessionId) key across hook-first and
 *   watcher-style calls.
 * - updateImportStatus 'imported' still promotes lifecycle status
 *   discovered → active (tracking → imported parity).
 * - live activation creates or promotes live observed sessions to active.
 * - closed and archived imported rows are never resurrected by importUpsert.
 *
 * Runs against BOTH storage backends (in-memory handlers and Drizzle over a
 * temp SQLite database) to pin behavioral parity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type ClientIdentityObservation } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { createTestDb } from '../storage/__tests__/shared.js';

/** Root-lineage identity fields shared by all importUpsert calls in this suite. */
const ROOT_LINEAGE = {
  kind: 'root',
  parentAdapterSessionId: null,
  forkPointMessageId: null,
} as const;

const OBSERVATION: ClientIdentityObservation = {
  clientId: 'claude-code',
  source: 'hook',
  kind: 'session-start',
  observedAt: 1_000,
  payload: { user: 'test' },
};

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

describe.each(backends)('session.importUpsert unified registration seam [$name]', ({ setup }) => {
  let cleanup: () => void;

  beforeEach(async () => {
    cleanup = await setup();
  });

  afterEach(() => cleanup());

  it('preserves hook-first metadata and merges import enrichment with existing keys winning (AC14)', async () => {
    const updatedEvents: Array<{ sessionId: string }> = [];
    const createdEvents: Array<{ sessionId: string }> = [];
    const offUpdated = MakaioBus.on(SessionSubjects.updated, (ctx) => {
      updatedEvents.push({ sessionId: ctx.payload.sessionId });
    });
    const offCreated = MakaioBus.on(SessionSubjects.created, (ctx) => {
      createdEvents.push({ sessionId: ctx.payload.sessionId });
    });

    try {
      // Hook-first registration: identity + metadata + live tracking status.
      const first = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        ...ROOT_LINEAGE,
        externalSessionId: 'ext-metadata',
        source: 'claude-code-cli',
        cwd: null,
        metadata: { a: 1, keep: true },
        importStatus: 'tracking',
        lastClientIdentityObservation: OBSERVATION,
      });
      expect(first.created).toBe(true);

      const registered = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
      expect(registered.session?.metadata).toEqual({ a: 1, keep: true });
      expect(registered.session?.importStatus).toBe('tracking');
      expect(registered.session?.status).toBe('discovered');
      expect(registered.session?.lastClientIdentityObservation).toEqual(OBSERVATION);

      // Import enrichment: colliding key `a` must NOT overwrite; new key `b` merges in.
      const second = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        ...ROOT_LINEAGE,
        externalSessionId: 'ext-metadata',
        source: 'claude-code-cli',
        cwd: '/repo',
        logFilePath: '/logs/ext-metadata.jsonl',
        startedAt: 5_000,
        metadata: { a: 2, b: 3 },
      });
      expect(second).toEqual({ sessionId: first.sessionId, created: false });

      const enriched = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
      expect(enriched.session?.metadata).toEqual({ a: 1, keep: true, b: 3 });
      expect(enriched.session?.importStatus).toBe('tracking');
      expect(enriched.session?.logFilePath).toBe('/logs/ext-metadata.jsonl');

      // Enrichment emits session.updated (fire-and-forget), never a second session.created.
      await vi.waitFor(() => {
        expect(updatedEvents).toContainEqual({ sessionId: first.sessionId });
      });
      expect(createdEvents).toEqual([{ sessionId: first.sessionId }]);
    } finally {
      offUpdated();
      offCreated();
    }
  });

  it('preserves null-valued and structured metadata values across enrichment (backend parity)', async () => {
    // JsonValue includes null: a stored `{ key: null }` is data, not a
    // deletion sentinel. This pins the SQLite merge expression against the
    // RFC 7386 json_patch semantics that would drop null-valued keys, and
    // exercises every JSON value class through the reassembly.
    const stored = {
      nullKey: null,
      flag: false,
      truthy: true,
      num: 1.5,
      str: '$ref ."weird" key value',
      nested: { x: [1, 's', true, null] },
    };

    const first = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-null-metadata',
      source: 'claude-code-cli',
      cwd: null,
      metadata: stored,
      importStatus: 'tracking',
    });
    expect(first.created).toBe(true);

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-null-metadata',
      source: 'claude-code-cli',
      cwd: '/repo',
      metadata: { nullKey: 'must-not-win', flag: 'must-not-win', addedNull: null, added: [2, { y: null }] },
    });

    const enriched = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
    expect(enriched.session?.metadata).toEqual({
      ...stored,
      addedNull: null,
      added: [2, { y: null }],
    });
  });

  it('enriches isSidechain with defined incoming values and keeps the stored flag otherwise', async () => {
    const first = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-sidechain',
      source: 'claude-code-cli',
      cwd: null,
    });
    const initial = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
    expect(initial.session?.isSidechain).toBeUndefined();

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-sidechain',
      source: 'claude-code-cli',
      cwd: null,
      isSidechain: true,
    });
    const flagged = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
    expect(flagged.session?.isSidechain).toBe(true);

    // Re-enrichment without the field keeps the stored value.
    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-sidechain',
      source: 'claude-code-cli',
      cwd: null,
    });
    const kept = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: first.sessionId });
    expect(kept.session?.isSidechain).toBe(true);
  });

  it('dedupes hook-first and watcher-style calls on the (source, externalSessionId) idempotency key', async () => {
    const hookFirst = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-dedupe',
      source: 'x-cli',
      cwd: null,
      importStatus: 'tracking',
    });
    expect(hookFirst.created).toBe(true);

    const watcher = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-dedupe',
      source: 'x-cli',
      cwd: '/repo',
      logFilePath: '/logs/ext-dedupe.jsonl',
      startedAt: 2_000,
    });
    expect(watcher).toEqual({ sessionId: hookFirst.sessionId, created: false });
  });

  it("promotes lifecycle status discovered → active when a tracking session transitions to 'imported'", async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-promote',
      source: 'claude-code-cli',
      cwd: null,
      importStatus: 'tracking',
    });

    const before = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(before.session?.status).toBe('discovered');
    expect(before.session?.importStatus).toBe('tracking');

    const { success } = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
      sessionId,
      importStatus: 'imported',
    });
    expect(success).toBe(true);

    const after = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(after.session?.status).toBe('active');
    expect(after.session?.importStatus).toBe('imported');
  });

  it("creates a live tracking import as lifecycle status 'active'", async () => {
    const { sessionId, created } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-create',
      source: 'claude-code-cli',
      cwd: '/repo',
      importStatus: 'tracking',
      activation: 'live',
    });

    expect(created).toBe(true);
    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.status).toBe('active');
    expect(session?.importStatus).toBe('tracking');
  });

  it('keeps an active live-created row active when a later no-activation call upgrades importStatus', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-active-import-status-upgrade',
      source: 'claude-code-cli',
      cwd: '/repo',
      activation: 'live',
    });

    const before = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(before.session?.status).toBe('active');
    expect(before.session?.importStatus).toBe('discovered');

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-active-import-status-upgrade',
      source: 'claude-code-cli',
      cwd: '/repo',
      importStatus: 'tracking',
    });

    const after = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(after.session?.status).toBe('active');
    expect(after.session?.importStatus).toBe('tracking');
  });

  it('keeps an active live-created row active during later discovery-only enrichment', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-active-discovery-enrichment',
      source: 'claude-code-cli',
      cwd: '/repo',
      activation: 'live',
    });

    const before = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(before.session?.status).toBe('active');
    expect(before.session?.importStatus).toBe('discovered');

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-active-discovery-enrichment',
      source: 'claude-code-cli',
      cwd: '/repo-again',
    });

    const after = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(after.session?.status).toBe('active');
    expect(after.session?.importStatus).toBe('discovered');
    expect(after.session?.targetWorkingDirectory).toBe('/repo-again');
  });

  it('promotes a discovered tracking import to active when live activation is observed', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-promote',
      source: 'claude-code-cli',
      cwd: null,
      importStatus: 'tracking',
    });

    const before = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(before.session?.status).toBe('discovered');
    expect(before.session?.importStatus).toBe('tracking');

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-promote',
      source: 'claude-code-cli',
      cwd: '/repo',
      importStatus: 'tracking',
      activation: 'live',
    });

    const after = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(after.session?.status).toBe('active');
    expect(after.session?.importStatus).toBe('tracking');
    expect(after.session?.targetWorkingDirectory).toBe('/repo');
  });

  it('does not resurrect closed discovered imports during import-upsert enrichment without activation', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-enrich-closed',
      source: 'claude-code-cli',
      cwd: null,
    });

    const initial = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(initial.session?.status).toBe('discovered');
    expect(initial.session?.importStatus).toBe('discovered');

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId,
      status: 'closed',
    });

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-enrich-closed',
      source: 'claude-code-cli',
      cwd: '/repo',
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.status).toBe('closed');
    expect(session?.importStatus).toBe('discovered');
    expect(session?.targetWorkingDirectory).toBe('/repo');
  });

  it('does not resurrect archived discovered imports during import-upsert enrichment without activation', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-enrich-archived',
      source: 'claude-code-cli',
      cwd: null,
    });

    const initial = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(initial.session?.status).toBe('discovered');
    expect(initial.session?.importStatus).toBe('discovered');

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId,
      status: 'archived',
    });

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-enrich-archived',
      source: 'claude-code-cli',
      cwd: '/repo',
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.status).toBe('archived');
    expect(session?.importStatus).toBe('discovered');
    expect(session?.targetWorkingDirectory).toBe('/repo');
  });

  it('does not resurrect closed imported sessions during import-upsert enrichment', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-closed',
      source: 'claude-code-cli',
      cwd: null,
      importStatus: 'tracking',
      activation: 'live',
    });

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId,
      status: 'closed',
    });

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-closed',
      source: 'claude-code-cli',
      cwd: '/repo',
      importStatus: 'tracking',
      activation: 'live',
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.status).toBe('closed');
    expect(session?.importStatus).toBe('tracking');
    expect(session?.targetWorkingDirectory).toBe('/repo');
  });

  it('does not resurrect archived imported sessions during import-upsert enrichment', async () => {
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-archived',
      source: 'claude-code-cli',
      cwd: null,
      importStatus: 'tracking',
      activation: 'live',
    });

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId,
      status: 'archived',
    });

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      ...ROOT_LINEAGE,
      externalSessionId: 'ext-live-archived',
      source: 'claude-code-cli',
      cwd: '/repo',
      importStatus: 'tracking',
      activation: 'live',
    });

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.status).toBe('archived');
    expect(session?.importStatus).toBe('tracking');
    expect(session?.targetWorkingDirectory).toBe('/repo');
  });
});
