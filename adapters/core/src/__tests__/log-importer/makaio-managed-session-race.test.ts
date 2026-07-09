/**
 * Invariant tests for the hook-first ingestion race repair.
 *
 * The repair consists of three cooperating mechanisms:
 *
 * 1. **Runtime-truth skip predicate** — `createDefaultCheckMakaioManaged(clientId)`
 *    queries `client.runtime.isAdapterManaged` so the importer skips
 *    adapter-managed sessions even when the DB only has a tracking stub.
 *
 * 2. **Stub reconciliation** — `ObservedSessionIngestionService.handleRuntimeStarted`
 *    deletes the racy tracking stub when `client.runtime.started` arrives.
 *
 * 3. **Cache invalidation** — `MakaioManagedSessionCache.invalidate()` evicts
 *    a stale false-negative verdict so the next `isSkipped` call re-evaluates.
 *
 * All tests exercise REAL memory storage handlers and REAL predicates — no
 * mocks. The `client.runtime.isAdapterManaged` handler is a minimal in-test
 * registration that mirrors the runtime registry's lookup (production handler
 * lives in `ClientRuntimeService`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects, MessageStorageSubjects, SessionSubjects, type IMakaioSession } from '@makaio/contracts';
import type { ClientRuntimeSourceLayer } from '@makaio/contracts/client';
import { SessionStorageSubjects } from '@makaio/services-core/session';
import { registerMemorySessionStorage, registerMemoryMessageStorage } from '@makaio/services-core/session';
import {
  createDefaultCheckMakaioManaged,
  MakaioManagedSessionCache,
} from '../../log-importer/makaio-managed-session.js';
import {
  ObservedSessionIngestionService,
  LogImportTriggerSubjects,
  isTrackingStub,
} from '@makaio/services-core/session';

/** Adapter session ID shared between hook and importer paths. */
const ADAPTER_SESSION_ID = 'race-session-ext-1';
/** Source identity used by the importer / hook ingestion. */
const SOURCE = 'claude-code';
/** Client id reported by the observed hook events. */
const CLIENT_ID = 'claude-code';

/**
 * In-test set of adapter session IDs considered "runtime-managed".
 *
 * Mirrors the `byAdapterSessionClientId` index in the real
 * `ClientRuntimeRegistry` — the production handler delegates to
 * `runtimeRegistry.hasAdapterSession()`.
 */
const runtimeManagedSessions = new Set<string>();

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
 * Register a minimal `client.runtime.isAdapterManaged` handler backed
 * by the in-test `runtimeManagedSessions` set.
 * @returns Cleanup function
 */
function registerRuntimeIsAdapterManagedHandler(): () => void {
  return MakaioBus.on(ClientSubjects.runtime.isAdapterManaged, (ctx) => {
    const key = `${ctx.payload.adapterSessionId} ${ctx.payload.clientId}`;
    const managed = runtimeManagedSessions.has(key);
    ctx.setResult({ managed });
  });
}

/**
 * Register the hook-first stub exactly as
 * `ObservedSessionIngestionService.handleSessionStarted` does when the
 * suppression gate has not been populated yet.
 * @param adapterSessionId - External adapter session id for the stub
 * @param options - Optional configuration; `activation: 'live'` sets lifecycle activation intent
 */
async function registerHookFirstStub(
  adapterSessionId: string,
  options?: {
    activation?: 'live';
  },
): Promise<void> {
  const upsertResult = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
    kind: 'root',
    parentAdapterSessionId: null,
    forkPointMessageId: null,
    externalSessionId: adapterSessionId,
    source: SOURCE,
    clientId: CLIENT_ID,
    cwd: '/workspace',
    startedAt: Date.now(),
    importStatus: 'tracking',
    activation: options?.activation,
  });
  expect(upsertResult.created).toBe(true);
}

/**
 * Append a single imported history message to a session.
 *
 * Used to simulate externally observed content that should prevent
 * reconciliation from deleting the tracking stub.
 * @param sessionId - Internal session ID to append the message to
 */
async function appendImportedHistoryMessage(sessionId: string): Promise<void> {
  await MakaioBus.request(MessageStorageSubjects.append, {
    message: {
      sessionId,
      turnId: null,
      role: 'user',
      contentText: 'imported history message',
      blocks: [{ type: 'text', content: 'imported history message' }],
      timestamp: Date.now(),
    },
    emitEvent: false,
  });
}

/**
 * Mark an adapter session as runtime-managed in the in-test registry.
 * @param adapterSessionId - External adapter session ID
 * @param clientId - Client identity
 */
function markRuntimeManaged(adapterSessionId: string, clientId: string): void {
  runtimeManagedSessions.add(`${adapterSessionId} ${clientId}`);
}

describe('hook-first importUpsert race — repaired invariant', () => {
  let cleanupStorage: () => void;
  let cleanupMessageStorage: () => void;
  let cleanupCrud: () => void;
  let cleanupRuntimeHandler: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    runtimeManagedSessions.clear();
    cleanupStorage = registerMemorySessionStorage(MakaioBus);
    cleanupMessageStorage = registerMemoryMessageStorage(MakaioBus);
    cleanupCrud = registerCrudGetByAdapterSessionIdPassthrough();
    cleanupRuntimeHandler = registerRuntimeIsAdapterManagedHandler();
  });

  afterEach(() => {
    cleanupRuntimeHandler();
    cleanupCrud();
    cleanupMessageStorage();
    cleanupStorage();
    MakaioBus.__resetHandlers?.();
    runtimeManagedSessions.clear();
  });

  // ── Runtime-truth skip predicate ────────────────────────────────────────

  it('skip-check with runtime truth recognises an adapter-managed session despite the tracking stub', async () => {
    await registerHookFirstStub(ADAPTER_SESSION_ID);

    // Verify the stub has the racy fingerprint.
    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: ADAPTER_SESSION_ID,
      source: SOURCE,
    });
    expect(session).not.toBeNull();
    expect(isTrackingStub(session!)).toBe(true);

    // Mark the session as runtime-managed (simulates client.runtime.observe
    // having registered the runtime record).
    markRuntimeManaged(ADAPTER_SESSION_ID, CLIENT_ID);

    // The runtime-truth-aware check recognises it as managed.
    const checkManaged = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await checkManaged(ADAPTER_SESSION_ID)).toBe(true);
  });

  it('externally observed sessions (no runtime record) MUST stay importable', async () => {
    // An external terminal session observed via hooks produces the identical
    // storage fingerprint. It does NOT have a runtime record because
    // external sessions are never registered via client.runtime.observe.
    await registerHookFirstStub('external-observed-session-1');

    // No runtime record → runtime-truth returns false → storage truth
    // sees isImported=true → result is "not managed" → importable.
    const checkManaged = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await checkManaged('external-observed-session-1')).toBe(false);
  });

  it('does NOT skip a discovery-scan session (no clientId, importStatus discovered)', async () => {
    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId: 'scan-session-1',
      source: SOURCE,
      cwd: '/workspace',
      startedAt: Date.now(),
      importStatus: 'discovered',
    });

    const checkManaged = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await checkManaged('scan-session-1')).toBe(false);
  });

  it('still skips a runtime-created session (isImported false)', async () => {
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

    const checkManaged = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await checkManaged('runtime-ext-1')).toBe(true);
  });

  // ── Cache invalidation ─────────────────────────────────────────────────

  it('cache delivers correct verdict after invalidation', async () => {
    await registerHookFirstStub(ADAPTER_SESSION_ID);

    const cache = new MakaioManagedSessionCache();
    const skipped: string[] = [];

    // Phase 1: no runtime record → "not managed" → cached as false.
    const checkNoRuntime = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await cache.isSkipped(ADAPTER_SESSION_ID, checkNoRuntime, (id) => skipped.push(id))).toBe(false);
    expect(skipped).toHaveLength(0);

    // Phase 2: runtime record arrives → invalidate cache → re-evaluate.
    markRuntimeManaged(ADAPTER_SESSION_ID, CLIENT_ID);
    cache.invalidate(ADAPTER_SESSION_ID);

    const checkWithRuntime = createDefaultCheckMakaioManaged(CLIENT_ID);
    expect(await cache.isSkipped(ADAPTER_SESSION_ID, checkWithRuntime, (id) => skipped.push(id))).toBe(true);
    expect(skipped).toContain(ADAPTER_SESSION_ID);
  });

  it('invalidation mid-flight causes awaiting caller to re-evaluate with fresh result', async () => {
    const cache = new MakaioManagedSessionCache();
    const skipped: string[] = [];

    // Track how many times the check function is called to verify
    // re-evaluation actually happens.
    let checkCallCount = 0;

    // A check whose resolution we control — simulates a storage-truth check
    // that started before the runtime registered.
    let resolveStaleCheck: (isManaged: boolean) => void = () => {};
    const staleCheck = (): Promise<boolean> => {
      checkCallCount += 1;
      if (checkCallCount === 1) {
        // First call: returns a controllable promise (the stale check).
        return new Promise((r) => (resolveStaleCheck = r));
      }
      // Re-evaluation call: runtime is now registered, so return true.
      return Promise.resolve(true);
    };

    const firstCall = cache.isSkipped(ADAPTER_SESSION_ID, staleCheck, (id) => skipped.push(id));

    // runtime.started arrives mid-flight → invalidate evicts the pending
    // entry AND bumps the generation so the stale verdict is not persisted.
    cache.invalidate(ADAPTER_SESSION_ID);
    resolveStaleCheck(false);

    // The first caller now detects the generation mismatch and
    // re-evaluates — receiving the FRESH result (true), not the stale one.
    expect(await firstCall).toBe(true);
    expect(checkCallCount).toBe(2);
    expect(skipped).toContain(ADAPTER_SESSION_ID);
  });

  // ── Stub reconciliation on client.runtime.started ──────────────────────

  describe('stub reconciliation via ObservedSessionIngestionService', () => {
    let ingestionService: ObservedSessionIngestionService;
    let cleanupImporterListing: () => void;

    /**
     * Look up a tracking stub by adapter session ID.
     * @param adapterSessionId - Adapter session ID to look up
     * @returns The session record or null if not found
     */
    async function getStub(adapterSessionId: string): Promise<IMakaioSession | null> {
      const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId,
        source: SOURCE,
      });
      return session;
    }

    /**
     * Emit a `client.runtime.started` event with sensible defaults.
     *
     * Centralises the boilerplate payload so tests read as intent, not
     * bus-wiring details.
     * @param overrides - Fields to override on the default payload
     */
    async function emitRuntimeStarted(
      overrides: Partial<{
        clientRuntimeId: string;
        clientId: string;
        adapterSessionId: string;
        layer: ClientRuntimeSourceLayer;
        producer: string;
      }> = {},
    ): Promise<void> {
      await MakaioBus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: overrides.clientRuntimeId ?? 'rt-default',
        clientId: overrides.clientId ?? CLIENT_ID,
        status: 'started',
        source: {
          layer: overrides.layer ?? 'adapter',
          producer: overrides.producer ?? 'claude-code-adapter',
        },
        observedAt: Date.now(),
        adapterSessionId: overrides.adapterSessionId ?? ADAPTER_SESSION_ID,
      });
    }

    /**
     * Assert that a tracking stub has been deleted from storage.
     * @param adapterSessionId - Adapter session ID to look up
     */
    async function expectStubDeleted(adapterSessionId: string): Promise<void> {
      const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId,
        source: SOURCE,
      });
      expect(session).toBeNull();
    }

    /**
     * Assert that a tracking stub still exists in storage.
     * @param adapterSessionId - Adapter session ID to look up
     */
    async function expectStubExists(adapterSessionId: string): Promise<void> {
      const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId,
        source: SOURCE,
      });
      expect(session).not.toBeNull();
      expect(isTrackingStub(session!)).toBe(true);
    }

    beforeEach(() => {
      // Register a minimal log-import.listImporters handler so the ingestion
      // service can resolve CLIENT_ID → SOURCE (adapter name).
      cleanupImporterListing = MakaioBus.on(LogImportTriggerSubjects.listImporters, (ctx) => {
        ctx.setResult({
          importers: [{ adapterName: SOURCE, clientId: CLIENT_ID }],
        });
      });

      ingestionService = new ObservedSessionIngestionService(MakaioBus);
    });

    afterEach(() => {
      ingestionService.destroy();
      cleanupImporterListing();
    });

    it('deletes a tracking stub when client.runtime.started fires for its adapterSessionId', async () => {
      await registerHookFirstStub(ADAPTER_SESSION_ID);
      await expectStubExists(ADAPTER_SESSION_ID);

      await emitRuntimeStarted({ clientRuntimeId: 'rt-1' });

      // Wait for the async handler to reconcile the stub.
      await vi.waitFor(() => expectStubDeleted(ADAPTER_SESSION_ID));
    });

    it('does NOT delete a stub for an externally observed session (no runtime.started)', async () => {
      // An externally observed session gets a tracking stub via the same
      // path (client.session.started → importUpsert). It never triggers
      // client.runtime.started for its adapterSessionId, so the stub must
      // persist and remain importable.
      await registerHookFirstStub('external-observed-session-2');

      // Emit runtime.started for a DIFFERENT adapterSessionId.
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-2',
        adapterSessionId: 'some-other-managed-session',
      });

      await expectStubExists('external-observed-session-2');
    });

    it('preserves a tracking stub that carries imported messages (native takeover)', async () => {
      const stubAdapterSessionId = 'takeover-session-1';
      await registerHookFirstStub(stubAdapterSessionId);

      // Look up the stub to get its internal sessionId.
      const stub = await getStub(stubAdapterSessionId);
      expect(stub).not.toBeNull();
      expect(isTrackingStub(stub!)).toBe(true);

      // Attach a message to the stub — simulates imported history from an
      // externally observed terminal session that shares the adapterSessionId
      // with a later native --resume.
      await appendImportedHistoryMessage(stub!.sessionId);

      await emitRuntimeStarted({
        clientRuntimeId: 'rt-takeover',
        adapterSessionId: stubAdapterSessionId,
      });

      // Negative case: stub MUST survive because it carries content.
      await expectStubExists(stubAdapterSessionId);

      // Messages must still be attached.
      const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, {
        sessionId: stub!.sessionId,
        limit: 10,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.contentText).toBe('imported history message');
    });

    it('reconciles active hook-first tracking stubs when runtime truth proves adapter management', async () => {
      await registerHookFirstStub(ADAPTER_SESSION_ID, { activation: 'live' });
      const stub = await getStub(ADAPTER_SESSION_ID);
      expect(stub?.status).toBe('active');
      expect(isTrackingStub(stub!)).toBe(true);

      await emitRuntimeStarted({ clientRuntimeId: 'rt-active-stub' });

      await vi.waitFor(() => expectStubDeleted(ADAPTER_SESSION_ID));
    });

    it('preserves active tracking stubs that carry imported messages', async () => {
      const stubAdapterSessionId = 'active-takeover-session-1';
      await registerHookFirstStub(stubAdapterSessionId, { activation: 'live' });

      const stub = await getStub(stubAdapterSessionId);
      expect(stub).not.toBeNull();
      expect(stub?.status).toBe('active');
      expect(isTrackingStub(stub!)).toBe(true);

      await appendImportedHistoryMessage(stub!.sessionId);

      await emitRuntimeStarted({
        clientRuntimeId: 'rt-active-takeover',
        adapterSessionId: stubAdapterSessionId,
      });

      await expectStubExists(stubAdapterSessionId);

      const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, {
        sessionId: stub!.sessionId,
        limit: 10,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.contentText).toBe('imported history message');
    });

    it('ignores non-adapter source layers (supervisor, statusline)', async () => {
      await registerHookFirstStub(ADAPTER_SESSION_ID);

      await emitRuntimeStarted({
        clientRuntimeId: 'rt-3',
        layer: 'statusline',
        producer: 'status-watcher',
      });

      // Negative case: non-adapter layers must not trigger reconciliation.
      await expectStubExists(ADAPTER_SESSION_ID);
    });

    it('post-upsert double-check reconciles a hook-side stub when the managed gate flips during importUpsert', async () => {
      const interleavedAdapterSessionId = 'post-upsert-interleaved-session-1';
      let observedRealUpsert = false;
      let populatedGateDuringUpsert = false;
      let wrapperAssertionError: unknown;

      const cleanupImportUpsertWrapper = MakaioBus.on(
        SessionStorageSubjects.importUpsert,
        async (ctx) => {
          if (ctx.payload.externalSessionId !== interleavedAdapterSessionId) {
            await ctx.next();
            return;
          }

          await ctx.next();
          observedRealUpsert = true;

          try {
            const stubAfterRealUpsert = await getStub(interleavedAdapterSessionId);
            expect(stubAfterRealUpsert?.status).toBe('active');
            expect(isTrackingStub(stubAfterRealUpsert!)).toBe(true);
          } catch (error) {
            wrapperAssertionError ??= error;
            return;
          }

          await emitRuntimeStarted({
            clientRuntimeId: 'rt-post-upsert-interleaving',
            clientId: 'unmapped-runtime-client',
            adapterSessionId: interleavedAdapterSessionId,
          });
          populatedGateDuringUpsert = true;

          // The runtime-side handler has populated the managed gate, but its
          // client id has no importer mapping. If this stub is deleted, the
          // test is no longer isolating the hook-side post-upsert branch.
          try {
            await expectStubExists(interleavedAdapterSessionId);
          } catch (error) {
            wrapperAssertionError ??= error;
          }
        },
        { priority: 100 },
      );

      try {
        await MakaioBus.emit(ClientSubjects.session.started, {
          clientId: CLIENT_ID,
          adapterSessionId: interleavedAdapterSessionId,
          source: 'session-start',
          observedAt: Date.now(),
        });

        expect(observedRealUpsert).toBe(true);
        expect(populatedGateDuringUpsert).toBe(true);
        if (wrapperAssertionError !== undefined) {
          throw wrapperAssertionError;
        }
        await expectStubDeleted(interleavedAdapterSessionId);
      } finally {
        cleanupImportUpsertWrapper();
      }
    });
  });

  // ── isTrackingStub predicate ───────────────────────────────────────────

  describe('isTrackingStub', () => {
    it('returns true for a hook-first tracking stub', () => {
      expect(
        isTrackingStub({
          isImported: true,
          importStatus: 'tracking',
          clientId: CLIENT_ID,
        }),
      ).toBe(true);
    });

    it('returns false for a discovery-scan session', () => {
      expect(
        isTrackingStub({
          isImported: true,
          importStatus: 'discovered',
          clientId: undefined,
        }),
      ).toBe(false);
    });

    it('returns false for a native session', () => {
      expect(
        isTrackingStub({
          isImported: false,
          importStatus: undefined,
          clientId: undefined,
        }),
      ).toBe(false);
    });
  });
});
