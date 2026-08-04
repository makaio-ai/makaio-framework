/**
 * Tests for the observed-session ingestion component — the first production
 * subscriber to `client.session.*`.
 *
 * The service under test is real and runs against the real bus with the
 * in-memory session storage handlers. Only the EXTERNAL seams are stubbed:
 * the log-import service (`listImporters`, `importFile`, `importSession`),
 * which is contributed by a different package at runtime.
 *
 * Covers:
 * - hook-first registration through `storage:session.importUpsert`
 *   (source = importer adapter name, importStatus 'tracking', metadata,
 *   cwd/logFilePath enrichment, idempotency on repeat)
 * - continuations (`startMode` resume/compact) rebind through
 *   `storage:session.rebindObserved` instead: locality follows the continuing
 *   runtime, import data stays put, and an unknown session is left for the
 *   transcript import to create — unless a metadata-only policy means no
 *   import will ever come, in which case it degrades to registration
 * - targeted import trigger on `client.session.turn.completed`
 *   (importFile + 'live' marker, importSession fallback without a path)
 * - AC8: adapter-managed sessions are suppressed; non-adapter runtime
 *   observations are not
 * - graceful absence: no log-import service / no matching importer
 * - metadata validation (non-JSON-safe metadata is dropped, AC14)
 * - FIFO cap eviction of the managed-session gate
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  ClientSubjects,
  type ClientSessionStarted,
  type ClientSessionTurnCompleted,
  type IMakaioSession,
} from '@makaio/contracts';
import type { ClientRuntimeSourceLayer } from '@makaio/contracts/client';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { LogImportTriggerSubjects } from '../log-import-trigger-subjects.js';
import { MANAGED_SESSION_CAP, ObservedSessionIngestionService } from '../observed-session-ingestion.js';
import {
  registerObservedSessionIngestionPolicyProvider,
  type IObservedSessionIngestionPolicyProvider,
} from '../observed-session-ingestion-policy.js';
import { resetBusHandlers } from './shared.js';

/** Client id advertised by the stubbed importer registration. */
const CLIENT_ID = 'test-client';
/** Importer adapter name — the `source` identity imports register under. */
const ADAPTER_NAME = 'test-cli';

/** Captured `log-import.importFile` request payloads. */
interface ImportFileRequest {
  filePath: string;
  adapterName: string;
  ingestionMarker?: 'live' | 'backfill';
}

/** Captured `log-import.importSession` request payloads. */
interface ImportSessionRequest {
  adapterSessionId: string;
  adapterName: string;
  ingestionMarker?: 'live' | 'backfill';
}

/**
 * Stub the external log-import seams (importer registry + import triggers).
 * @param options - Stub behavior overrides: `importerClientId` sets the
 *   `clientId` advertised by the registered importer; `importSessionThrows`
 *   makes the importSession stub throw (no discovery stub exists)
 * @returns Captured request payloads per subject
 */
function stubLogImportSeams(options?: { importerClientId?: string; importSessionThrows?: boolean }): {
  importFileRequests: ImportFileRequest[];
  importSessionRequests: ImportSessionRequest[];
  listImportersRequests: number[];
} {
  const importFileRequests: ImportFileRequest[] = [];
  const importSessionRequests: ImportSessionRequest[] = [];
  const listImportersRequests: number[] = [];

  MakaioBus.on(LogImportTriggerSubjects.listImporters, (ctx) => {
    listImportersRequests.push(Date.now());
    ctx.setResult({
      importers: [{ adapterName: ADAPTER_NAME, clientId: options?.importerClientId ?? CLIENT_ID }],
    });
  });
  MakaioBus.on(LogImportTriggerSubjects.importFile, (ctx) => {
    importFileRequests.push(ctx.payload);
    ctx.setResult({ status: 'imported', sessionId: 'imported-session', messageCount: 0, turnCount: 0 });
  });
  MakaioBus.on(LogImportTriggerSubjects.importSession, (ctx) => {
    importSessionRequests.push(ctx.payload);
    if (options?.importSessionThrows === true) {
      throw new Error(`No discovered session found: ${ctx.payload.adapterSessionId}`);
    }
    ctx.setResult({ sessionId: 'imported-session', messageCount: 0 });
  });

  return { importFileRequests, importSessionRequests, listImportersRequests };
}

/**
 * Emit a `client.session.started` observation.
 * @param overrides - Payload field overrides
 */
async function emitSessionStarted(overrides?: Partial<ClientSessionStarted>): Promise<void> {
  await MakaioBus.emit(ClientSubjects.session.started, {
    clientId: CLIENT_ID,
    source: 'native-hook',
    observedAt: 1_000,
    adapterSessionId: 'ext-1',
    ...overrides,
  });
}

/**
 * Emit a `client.session.turn.completed` observation.
 * @param overrides - Payload field overrides
 */
async function emitTurnCompleted(overrides?: Partial<ClientSessionTurnCompleted>): Promise<void> {
  await MakaioBus.emit(ClientSubjects.session.turn.completed, {
    clientId: CLIENT_ID,
    source: 'native-hook',
    observedAt: 2_000,
    adapterSessionId: 'ext-1',
    ...overrides,
  });
}

/**
 * Emit a `client.runtime.started` observation feeding the managed gate.
 * @param adapterSessionId - Adapter session id carried as runtime evidence
 * @param layer - Source layer of the observation
 */
async function emitRuntimeStarted(adapterSessionId: string, layer: ClientRuntimeSourceLayer): Promise<void> {
  await MakaioBus.emit(ClientSubjects.runtime.started, {
    clientRuntimeId: `rt-${adapterSessionId}`,
    clientId: CLIENT_ID,
    status: 'started',
    source: { layer, producer: 'test-producer' },
    observedAt: 500,
    adapterSessionId,
  });
}

/**
 * Load the persisted observed session for an adapter session id.
 * @param adapterSessionId - External session id to look up
 * @returns The stored session, or null
 */
async function getObservedSession(adapterSessionId: string): Promise<IMakaioSession | null> {
  const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
    adapterSessionId,
    source: ADAPTER_NAME,
  });
  return session;
}

describe('ObservedSessionIngestionService', () => {
  let service: ObservedSessionIngestionService;
  let storageCleanup: () => void;

  beforeEach(() => {
    storageCleanup = registerMemorySessionStorage(MakaioBus);
    service = new ObservedSessionIngestionService(MakaioBus);
  });

  afterEach(() => {
    service.destroy();
    storageCleanup();
    resetBusHandlers();
  });

  it('registers an observed session with importer-name source, tracking status, and hook payload enrichment', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      transcriptPath: '/logs/ext-1.jsonl',
      cwd: '/repo',
      metadata: { hookVersion: 1, keep: true },
    });

    const session = await getObservedSession('ext-1');
    expect(session).not.toBeNull();
    expect(session?.source).toBe(ADAPTER_NAME);
    expect(session?.clientId).toBe(CLIENT_ID);
    expect(session?.importStatus).toBe('tracking');
    expect(session?.status).toBe('active');
    expect(session?.metadata).toEqual({ hookVersion: 1, keep: true });
    expect(session?.logFilePath).toBe('/logs/ext-1.jsonl');
    expect(session?.targetWorkingDirectory).toBe('/repo');
    expect(session?.createdAt).toBe(1_000);

    // Second started event for the same session is idempotent (created=false path).
    await emitSessionStarted({ cwd: '/repo' });
    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, { source: ADAPTER_NAME });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(session?.sessionId);
  });

  it('persists caller-supplied machineId on the observed session registration', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      transcriptPath: '/logs/ext-1.jsonl',
      cwd: '/repo',
      machineId: 'machine-abc-123',
    });

    const session = await getObservedSession('ext-1');
    expect(session).not.toBeNull();
    expect(session?.machineId).toBe('machine-abc-123');
  });

  it("triggers log-import.importFile with the importer adapter name and 'live' marker on turn.completed", async () => {
    const { importFileRequests, importSessionRequests } = stubLogImportSeams();

    await emitTurnCompleted({ transcriptPath: '/logs/ext-1.jsonl' });

    expect(importFileRequests).toEqual([
      { filePath: '/logs/ext-1.jsonl', adapterName: ADAPTER_NAME, ingestionMarker: 'live' },
    ]);
    expect(importSessionRequests).toEqual([]);
  });

  it('registers policy-discovered observed sessions without triggering content import', async () => {
    const { importFileRequests, importSessionRequests } = stubLogImportSeams();
    const decisions: Array<Parameters<IObservedSessionIngestionPolicyProvider['decideObservedSessionIngestion']>[0]> =
      [];

    await registerObservedSessionIngestionPolicyProvider(MakaioBus, {
      id: 'test-policy',
      displayName: 'Test policy',
      decideObservedSessionIngestion(input) {
        decisions.push(input);
        return { importStatus: 'discovered' };
      },
    });

    await emitSessionStarted({
      transcriptPath: '/logs/ext-1.jsonl',
      cwd: '/private',
      metadata: { title: 'metadata only' },
    });
    await emitTurnCompleted({ transcriptPath: '/logs/ext-1.jsonl' });
    await emitTurnCompleted({ transcriptPath: undefined });

    const session = await getObservedSession('ext-1');
    expect(session).not.toBeNull();
    expect(session?.status).toBe('discovered');
    expect(session?.importStatus).toBe('discovered');
    expect(session?.clientId).toBe(CLIENT_ID);
    expect(session?.targetWorkingDirectory).toBe('/private');
    expect(importFileRequests).toEqual([]);
    expect(importSessionRequests).toEqual([]);
    expect(decisions).toEqual([
      expect.objectContaining({
        adapterName: ADAPTER_NAME,
        adapterSessionId: 'ext-1',
        clientId: CLIENT_ID,
        cwd: '/private',
        source: 'native-hook',
        transcriptPath: '/logs/ext-1.jsonl',
      }),
    ]);
  });

  it('re-checks policy before importing content for discovery stubs without client identity', async () => {
    const { importFileRequests, importSessionRequests } = stubLogImportSeams();
    const decisions: Array<Parameters<IObservedSessionIngestionPolicyProvider['decideObservedSessionIngestion']>[0]> =
      [];

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId: 'ext-1',
      source: ADAPTER_NAME,
      cwd: '/repo',
      logFilePath: '/logs/ext-1.jsonl',
      startedAt: 500,
    });
    await registerObservedSessionIngestionPolicyProvider(MakaioBus, {
      id: 'test-policy',
      displayName: 'Test policy',
      decideObservedSessionIngestion(input) {
        decisions.push(input);
        return { importStatus: 'discovered' };
      },
    });

    await emitTurnCompleted({ transcriptPath: '/logs/ext-1.jsonl' });

    expect(importFileRequests).toEqual([]);
    expect(importSessionRequests).toEqual([]);
    expect(decisions).toEqual([
      expect.objectContaining({
        adapterName: ADAPTER_NAME,
        adapterSessionId: 'ext-1',
        clientId: CLIENT_ID,
        source: 'native-hook',
        transcriptPath: '/logs/ext-1.jsonl',
      }),
    ]);
  });

  it('suppresses registration and import for adapter-managed sessions but not for statusline observations (AC8)', async () => {
    const { importFileRequests } = stubLogImportSeams();

    // Managed by the orchestration path: adapter-layer runtime evidence.
    await emitRuntimeStarted('managed-1', 'adapter');
    await emitSessionStarted({ adapterSessionId: 'managed-1' });
    await emitTurnCompleted({ adapterSessionId: 'managed-1', transcriptPath: '/logs/managed-1.jsonl' });

    expect(await getObservedSession('managed-1')).toBeNull();
    expect(importFileRequests).toEqual([]);

    // Non-adapter source layers must NOT suppress observed ingestion.
    await emitRuntimeStarted('observed-1', 'statusline');
    await emitSessionStarted({ adapterSessionId: 'observed-1' });
    await emitTurnCompleted({ adapterSessionId: 'observed-1', transcriptPath: '/logs/observed-1.jsonl' });

    expect(await getObservedSession('observed-1')).not.toBeNull();
    expect(importFileRequests).toEqual([
      { filePath: '/logs/observed-1.jsonl', adapterName: ADAPTER_NAME, ingestionMarker: 'live' },
    ]);
  });

  it('skips silently when no log-import service is registered (framework-only mode)', async () => {
    // No listImporters handler at all: requestOptional resolves unhandled.
    await emitSessionStarted();
    await emitTurnCompleted({ transcriptPath: '/logs/ext-1.jsonl' });

    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, {});
    expect(sessions).toEqual([]);
  });

  it('skips when no registered importer matches the observed clientId', async () => {
    const { listImportersRequests } = stubLogImportSeams({ importerClientId: 'some-other-client' });

    await emitSessionStarted();
    await emitTurnCompleted({ transcriptPath: '/logs/ext-1.jsonl' });

    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, {});
    expect(sessions).toEqual([]);
    expect(listImportersRequests).toHaveLength(1);
  });

  it('drops non-JSON-safe hook metadata but still registers the session (AC14)', async () => {
    stubLogImportSeams();

    await emitSessionStarted({ metadata: { callback: () => 'not json' } });

    const session = await getObservedSession('ext-1');
    expect(session).not.toBeNull();
    expect(session?.metadata).toBeUndefined();
    expect(session?.importStatus).toBe('tracking');
  });

  it('falls back to importSession when the turn payload carries no transcript path and tolerates its throw', async () => {
    const { importFileRequests, importSessionRequests } = stubLogImportSeams({ importSessionThrows: true });

    await emitTurnCompleted();

    expect(importFileRequests).toEqual([]);
    expect(importSessionRequests).toEqual([
      { adapterSessionId: 'ext-1', adapterName: ADAPTER_NAME, ingestionMarker: 'live' },
    ]);
  });

  it('evicts the oldest managed session id once the FIFO cap is reached', async () => {
    const { importFileRequests } = stubLogImportSeams();

    await emitRuntimeStarted('managed-first', 'adapter');
    // Fill the gate past the cap so 'managed-first' is evicted FIFO.
    for (let index = 0; index < MANAGED_SESSION_CAP; index += 1) {
      await emitRuntimeStarted(`managed-${index}`, 'adapter');
    }

    // Evicted id is no longer suppressed …
    await emitTurnCompleted({ adapterSessionId: 'managed-first', transcriptPath: '/logs/managed-first.jsonl' });
    expect(importFileRequests).toHaveLength(1);

    // … while a still-tracked id remains suppressed.
    const lastTracked = `managed-${MANAGED_SESSION_CAP - 1}`;
    await emitTurnCompleted({ adapterSessionId: lastTracked, transcriptPath: `/logs/${lastTracked}.jsonl` });
    expect(importFileRequests).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Fork lineage registration at SessionStart
  // -------------------------------------------------------------------------

  it('registers a fork child with fork lineage when startMode is fork', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'fork-child-1',
      startMode: 'fork',
      parentAdapterSessionId: 'parent-ext-1',
      cwd: '/repo',
    });

    const session = await getObservedSession('fork-child-1');
    expect(session).not.toBeNull();
    expect(session?.branchKind).toBe('fork');
    expect(session?.parentExternalSessionId).toBe('parent-ext-1');
  });

  it('registers as root when startMode is absent (observed-only, no fork signal)', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'observed-root-1',
      cwd: '/repo',
    });

    const session = await getObservedSession('observed-root-1');
    expect(session).not.toBeNull();
    expect(session?.branchKind).toBeUndefined();
    expect(session?.parentExternalSessionId).toBeUndefined();
  });

  it('registers as root when startMode is fresh', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'fresh-root-1',
      startMode: 'fresh',
      cwd: '/repo',
    });

    const session = await getObservedSession('fresh-root-1');
    expect(session).not.toBeNull();
    expect(session?.branchKind).toBeUndefined();
    expect(session?.parentExternalSessionId).toBeUndefined();
  });

  it('registers as root when startMode is clear', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'clear-root-1',
      startMode: 'clear',
      cwd: '/repo',
    });

    const session = await getObservedSession('clear-root-1');
    expect(session).not.toBeNull();
    // Clear does not create fork lineage
    expect(session?.branchKind).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Continuations (resume / compact) rebind instead of registering
  // -------------------------------------------------------------------------

  it.each([
    'resume',
    'compact',
  ] as const)('rebinds locality without touching import data when startMode is %s', async (startMode) => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'continued-1',
      startMode: 'fresh',
      cwd: '/repo',
      transcriptPath: '/logs/repo/continued-1.jsonl',
      machineId: 'machine-a',
      metadata: { keep: true },
    });
    const registered = await getObservedSession('continued-1');
    expect(registered?.importStatus).toBe('tracking');

    await emitSessionStarted({
      adapterSessionId: 'continued-1',
      startMode,
      observedAt: 9_000,
      cwd: '/worktree',
      transcriptPath: '/logs/worktree/continued-1.jsonl',
      machineId: 'machine-b',
      metadata: { keep: false, added: 1 },
    });

    const continued = await getObservedSession('continued-1');
    expect(continued?.sessionId).toBe(registered?.sessionId);
    // Locality follows the continuing runtime …
    expect(continued?.targetWorkingDirectory).toBe('/worktree');
    expect(continued?.logFilePath).toBe('/logs/worktree/continued-1.jsonl');
    expect(continued?.machineId).toBe('machine-b');
    // … while origin, lineage, import lifecycle, creation time and content
    // stay owned by the registration/import path.
    expect(continued?.createdAt).toBe(1_000);
    expect(continued?.branchKind).toBeUndefined();
    expect(continued?.parentExternalSessionId).toBeUndefined();
    expect(continued?.importStatus).toBe('tracking');
    expect(continued?.metadata).toEqual({ keep: true });
  });

  it.each([
    'resume',
    'compact',
  ] as const)('does not register a session for a %s of an unknown external session', async (startMode) => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'unknown-continued-1',
      startMode,
      cwd: '/repo',
      transcriptPath: '/logs/unknown-continued-1.jsonl',
    });

    expect(await getObservedSession('unknown-continued-1')).toBeNull();
    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, {});
    expect(sessions).toEqual([]);
  });

  it('leaves an unknown continuation to the transcript import when policy tracks content', async () => {
    stubLogImportSeams();
    await registerObservedSessionIngestionPolicyProvider(MakaioBus, {
      id: 'tracking-policy',
      displayName: 'Tracking policy',
      decideObservedSessionIngestion: () => ({ importStatus: 'tracking' }),
    });

    await emitSessionStarted({
      adapterSessionId: 'tracked-continued-1',
      startMode: 'resume',
      cwd: '/repo',
      transcriptPath: '/logs/tracked-continued-1.jsonl',
    });

    expect(await getObservedSession('tracked-continued-1')).toBeNull();
    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, {});
    expect(sessions).toEqual([]);
  });

  it('registers an unknown continuation as metadata-only when policy never imports its content', async () => {
    const { importFileRequests, importSessionRequests } = stubLogImportSeams();
    await registerObservedSessionIngestionPolicyProvider(MakaioBus, {
      id: 'discovered-policy',
      displayName: 'Discovered policy',
      decideObservedSessionIngestion: () => ({ importStatus: 'discovered' }),
    });

    await emitSessionStarted({
      adapterSessionId: 'private-continued-1',
      startMode: 'resume',
      observedAt: 7_000,
      cwd: '/private',
      transcriptPath: '/logs/private-continued-1.jsonl',
      machineId: 'machine-a',
      metadata: { title: 'metadata only' },
    });

    // Without the policy consultation this session would vanish entirely: the
    // rebind finds nothing and the metadata-only policy stops every later
    // content import from creating the row.
    const session = await getObservedSession('private-continued-1');
    expect(session).not.toBeNull();
    expect(session?.importStatus).toBe('discovered');
    expect(session?.status).toBe('discovered');
    expect(session?.clientId).toBe(CLIENT_ID);
    expect(session?.targetWorkingDirectory).toBe('/private');
    expect(session?.logFilePath).toBe('/logs/private-continued-1.jsonl');
    expect(session?.machineId).toBe('machine-a');
    expect(session?.metadata).toEqual({ title: 'metadata only' });
    expect(session?.branchKind).toBeUndefined();

    // Still metadata-only: no content import is triggered for it.
    await emitTurnCompleted({
      adapterSessionId: 'private-continued-1',
      transcriptPath: '/logs/private-continued-1.jsonl',
    });
    expect(importFileRequests).toEqual([]);
    expect(importSessionRequests).toEqual([]);
  });

  it('does not promote a watcher-discovered session to tracking on resume', async () => {
    stubLogImportSeams();

    // Watcher discovery: no client identity, plain 'discovered' import status.
    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId: 'discovered-1',
      source: ADAPTER_NAME,
      cwd: '/repo',
      startedAt: 500,
    });

    await emitSessionStarted({
      adapterSessionId: 'discovered-1',
      startMode: 'resume',
      cwd: '/worktree',
    });

    const session = await getObservedSession('discovered-1');
    expect(session?.sessionId).toBe(sessionId);
    expect(session?.targetWorkingDirectory).toBe('/worktree');
    // A continuation carries no import verdict: it neither claims the row for
    // hook-observed policy (clientId) nor promotes its lifecycle.
    expect(session?.clientId).toBeUndefined();
    expect(session?.importStatus).toBe('discovered');
    expect(session?.status).toBe('discovered');
    expect(session?.createdAt).toBe(500);
  });

  it('does not reactivate a closed observed session on repeated live start observations', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      transcriptPath: '/logs/ext-1.jsonl',
      cwd: '/repo',
    });

    const first = await getObservedSession('ext-1');
    expect(first).not.toBeNull();
    expect(first?.status).toBe('active');

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: first!.sessionId,
      status: 'closed',
    });

    await emitSessionStarted({
      transcriptPath: '/logs/ext-1.jsonl',
      cwd: '/repo-again',
    });

    const second = await getObservedSession('ext-1');
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.status).toBe('closed');
    expect(second?.targetWorkingDirectory).toBe('/repo-again');
  });

  it('does not register as fork when startMode is fork but parentAdapterSessionId is absent', async () => {
    stubLogImportSeams();

    await emitSessionStarted({
      adapterSessionId: 'fork-no-parent-1',
      startMode: 'fork',
      // parentAdapterSessionId deliberately omitted
      cwd: '/repo',
    });

    const session = await getObservedSession('fork-no-parent-1');
    expect(session).not.toBeNull();
    // Falls back to root since parent is missing
    expect(session?.branchKind).toBeUndefined();
  });
});
