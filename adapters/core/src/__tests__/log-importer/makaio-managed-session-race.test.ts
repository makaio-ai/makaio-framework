/**
 * Proof tests for the hook-first import-upsert race in the managed-session
 * skip predicate — documenting CURRENT behaviour, not the desired invariant.
 *
 * Scenario: An adapter-managed session starts and the CLI-process SessionStart
 * hook fires BEFORE `client.runtime.started` populates the in-memory
 * suppression gate. `ObservedSessionIngestionService.handleSessionStarted`
 * then creates a stub row via `importUpsert` with `isImported: true` and
 * `importStatus: 'tracking'`. When the log importer later calls
 * `createDefaultCheckMakaioManaged()` (predicate: `!session.isImported`),
 * the stub does not match — the importer proceeds and writes transcript
 * turns on top of the live turns from the SessionBridge.
 *
 * Why this is NOT fixed here by widening the predicate: the stub's storage
 * fingerprint (`isImported: true`, `importStatus: 'tracking'`, `clientId`
 * set) is byte-identical to the registration of an EXTERNALLY observed
 * terminal session, whose transcript content the importer MUST import.
 * A fingerprint-based skip would silently disable the observed-sessions
 * feature. The real fix needs a runtime-truth contract ("is this
 * adapterSessionId currently adapter-managed?") or must prevent the
 * identity-forking stub at its source — tracked as a dedicated
 * ingestion-seam invariant issue.
 *
 * These tests exercise the REAL memory storage handlers and the REAL
 * `createDefaultCheckMakaioManaged` predicate — no mocks. If a test here
 * starts failing, the skip seam's semantics changed: re-evaluate both the
 * race and the observed-sessions import path together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '@makaio/services-core/session';
import { registerMemorySessionStorage } from '@makaio/services-core/session';
import {
  createDefaultCheckMakaioManaged,
  MakaioManagedSessionCache,
} from '../../log-importer/makaio-managed-session.js';

/** Adapter session ID shared between hook and importer paths. */
const ADAPTER_SESSION_ID = 'race-session-ext-1';
/** Source identity used by the importer / hook ingestion. */
const SOURCE = 'claude-code';
/** Client id reported by the observed hook events. */
const CLIENT_ID = 'claude-code';

/**
 * Bridge `SessionSubjects.getByAdapterSessionId` (CRUD level) to
 * `SessionStorageSubjects.getByAdapterSessionId` (storage level).
 *
 * In production the host session service registers this handler; for this
 * integration test we register a minimal passthrough that mirrors the real
 * delegation pattern.
 * @returns Cleanup function
 */
function registerCrudGetByAdapterSessionIdPassthrough(): () => void {
  return MakaioBus.on(SessionSubjects.getByAdapterSessionId, async (ctx) => {
    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: ctx.payload.adapterSessionId,
    });
    ctx.setResult({ session });
  });
}

/**
 * Register the hook-first stub exactly as
 * `ObservedSessionIngestionService.handleSessionStarted` does when the
 * suppression gate has not been populated yet (observed-session-ingestion.ts).
 * @param adapterSessionId - External adapter session id for the stub
 */
async function registerHookFirstStub(adapterSessionId: string): Promise<void> {
  const upsertResult = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
    kind: 'root',
    parentAdapterSessionId: null,
    forkPointMessageId: null,
    externalSessionId: adapterSessionId,
    source: SOURCE,
    clientId: CLIENT_ID,
    cwd: '/workspace',
    startedAt: Date.now(),
    // importStatus 'tracking' is what decideImportStatus returns by default
    // when no policy provider restricts to 'discovered'.
    importStatus: 'tracking',
  });
  expect(upsertResult.created).toBe(true);
}

describe('hook-first importUpsert race vs. managed-session skip', () => {
  let cleanupStorage: () => void;
  let cleanupCrud: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupStorage = registerMemorySessionStorage(MakaioBus);
    cleanupCrud = registerCrudGetByAdapterSessionIdPassthrough();
  });

  afterEach(() => {
    cleanupCrud();
    cleanupStorage();
    MakaioBus.__resetHandlers?.();
  });

  it('KNOWN RACE: a hook-first tracking stub is NOT recognised as managed — the importer would double-write', async () => {
    await registerHookFirstStub(ADAPTER_SESSION_ID);

    // Verify the stub carries the racy fingerprint.
    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: ADAPTER_SESSION_ID,
      source: SOURCE,
    });
    expect(session).not.toBeNull();
    expect(session!.isImported).toBe(true);
    expect(session!.importStatus).toBe('tracking');
    expect(session!.clientId).toBe(CLIENT_ID);

    const checkManaged = createDefaultCheckMakaioManaged();

    // CURRENT behaviour: the predicate only checks `!isImported`, so the
    // adapter-managed session raced by its own SessionStart hook is treated
    // as importable. This is the documented double-ingestion gap; the fix
    // lives at the ingestion seam, not in this predicate (see file header).
    expect(await checkManaged(ADAPTER_SESSION_ID)).toBe(false);
  });

  it('externally observed sessions share the exact stub fingerprint and MUST stay importable', async () => {
    // An external terminal session observed via hooks produces the identical
    // registration — same clientId, same importStatus 'tracking'. Its
    // transcript content is imported through the very path the skip check
    // guards, so ANY fingerprint-based skip would break observed-session
    // content import. This is the invariant that rejected the naive fix.
    await registerHookFirstStub('external-observed-session-1');

    const checkManaged = createDefaultCheckMakaioManaged();
    expect(await checkManaged('external-observed-session-1')).toBe(false);
  });

  it('does NOT skip a discovery-scan session (no clientId, importStatus discovered)', async () => {
    // Pure watcher-discovered session — importable, never skipped.
    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId: 'scan-session-1',
      source: SOURCE,
      cwd: '/workspace',
      startedAt: Date.now(),
      importStatus: 'discovered',
      // No clientId — watcher discovery does not set it
    });

    const checkManaged = createDefaultCheckMakaioManaged();
    expect(await checkManaged('scan-session-1')).toBe(false);
  });

  it('still skips a runtime-created session (isImported false)', async () => {
    // Runtime-managed session created via session.set (not importUpsert).
    // This is the existing happy path that must remain correct.
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'runtime-session-1',
      session: {
        sessionId: 'runtime-session-1',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        isImported: false,
        adapterSessionId: 'runtime-ext-1',
        adapterName: 'claude-code',
      },
    });

    const checkManaged = createDefaultCheckMakaioManaged();
    expect(await checkManaged('runtime-ext-1')).toBe(true);
  });

  it('KNOWN RACE: the cache pins the racy verdict permanently', async () => {
    await registerHookFirstStub(ADAPTER_SESSION_ID);

    const cache = new MakaioManagedSessionCache();
    const checkManaged = createDefaultCheckMakaioManaged();
    const skipped: string[] = [];

    // First evaluation returns the racy 'not managed' verdict …
    expect(await cache.isSkipped(ADAPTER_SESSION_ID, checkManaged, (id) => skipped.push(id))).toBe(false);
    expect(skipped).toHaveLength(0);

    // … and the cache keeps returning it even if the runtime gate would be
    // populated by now — the second consequence of the race: a later,
    // correct verdict can never overrule the cached one.
    expect(await cache.isSkipped(ADAPTER_SESSION_ID, checkManaged, (id) => skipped.push(id))).toBe(false);
  });
});
