/**
 * Tests for adapter session event handlers.
 */
import { sql } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type BranchKind } from '@makaio/contracts';
import { AdapterSessionStorageSubjects, type CreateAndLinkMetadata } from '../namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerSessionDiscoveredHandler, createAndLinkImportedSession } from '../handlers.js';
import { createTestDb, type TestDbContext } from './shared.js';

type ImportedSessionMetadataOverrides =
  | {
      kind?: null;
      parentAdapterSessionId?: null;
      forkPointMessageId?: null;
      model?: string | null;
      cwd?: string | null;
      title?: string | null;
    }
  | {
      kind: 'fork';
      parentAdapterSessionId: string;
      forkPointMessageId?: string;
      model?: string | null;
      cwd?: string | null;
      title?: string | null;
    }
  | {
      kind: 'subagent';
      parentAdapterSessionId: string;
      forkPointMessageId?: null;
      model?: string | null;
      cwd?: string | null;
      title?: string | null;
    };

function makeImportedSessionMetadata(overrides: ImportedSessionMetadataOverrides = {}): CreateAndLinkMetadata {
  const shared = {
    model: overrides.model ?? null,
    cwd: overrides.cwd ?? null,
    title: overrides.title ?? null,
  };

  if (overrides.kind === 'fork') {
    return {
      ...shared,
      kind: 'fork',
      parentAdapterSessionId: overrides.parentAdapterSessionId,
      forkPointMessageId: overrides.forkPointMessageId ?? 'fork-point',
    };
  }

  if (overrides.kind === 'subagent') {
    return {
      ...shared,
      kind: 'subagent',
      parentAdapterSessionId: overrides.parentAdapterSessionId,
      forkPointMessageId: null,
    };
  }

  return {
    ...shared,
    kind: null,
    parentAdapterSessionId: null,
    forkPointMessageId: null,
  };
}

/** Shared optional fields present on all discovered-session variants. */
interface DiscoveredSessionOptionalFields {
  title?: string;
  logFilePath?: string | null;
  startedAt?: number;
}

type DiscoveredSessionPayload =
  | (DiscoveredSessionOptionalFields & {
      adapterId: string;
      adapterName: string;
      adapterSessionId: string;
      kind: 'root';
      parentAdapterSessionId: null;
      forkPointMessageId: null;
      model: string | null;
      cwd: string | null;
    })
  | (DiscoveredSessionOptionalFields & {
      adapterId: string;
      adapterName: string;
      adapterSessionId: string;
      kind: 'fork';
      parentAdapterSessionId: string;
      forkPointMessageId: string;
      model: string | null;
      cwd: string | null;
    })
  | (DiscoveredSessionOptionalFields & {
      adapterId: string;
      adapterName: string;
      adapterSessionId: string;
      kind: 'subagent';
      parentAdapterSessionId: string;
      forkPointMessageId: null;
      model: string | null;
      cwd: string | null;
    });

async function emitDiscoveredAndWaitLinked(payload: DiscoveredSessionPayload): Promise<string> {
  await MakaioBus.emit(AdapterSubjects.session.discovered, payload);

  await vi.waitFor(async () => {
    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: payload.adapterSessionId,
    });
    expect(result.session?.sessionId).not.toBeNull();
  });

  const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
    adapterSessionId: payload.adapterSessionId,
  });

  return session!.sessionId!;
}

describe('registerSessionDiscoveredHandler', () => {
  let cleanup: () => void;
  let handlerCleanup: () => void;

  beforeEach(async () => {
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;

    // Register the session discovered handler
    handlerCleanup = registerSessionDiscoveredHandler(MakaioBus);
  });

  afterEach(() => {
    handlerCleanup();
    cleanup();
  });

  it('should create adapter session record when session is discovered', async () => {
    // Emit session discovered event
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-discovered-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    // Wait for async handler to complete
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-discovered-1',
      });
      expect(result.session).not.toBeNull();
    });

    // Verify the session was created
    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-discovered-1',
    });

    expect(result.session?.adapterSessionId).toBe('cc-discovered-1');
    expect(result.session?.adapterName).toBe('claude-code');
    expect(result.session?.status).toBe('discovered');
    expect(result.session?.kind).toBe('root');
  });

  it('should create adapter session record with lineage info', async () => {
    // First create the parent session
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-parent-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: 'claude-3-opus',
      cwd: '/home/user/project',
    });

    // Wait for parent to be created
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-parent-1',
      });
      expect(result.session).not.toBeNull();
    });

    // Now create a forked session
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-forked-1',
      parentAdapterSessionId: 'cc-parent-1',
      forkPointMessageId: 'msg-fork-point-1',
      kind: 'fork',
      model: 'claude-3-opus',
      cwd: '/home/user/project',
    });

    // Wait for forked session to be created
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-forked-1',
      });
      expect(result.session).not.toBeNull();
    });

    // Verify the forked session has correct lineage
    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-forked-1',
    });

    expect(result.session?.parentAdapterSessionId).toBe('cc-parent-1');
    expect(result.session?.forkPointMessageId).toBe('msg-fork-point-1');
    expect(result.session?.kind).toBe('fork');
    expect(result.session?.model).toBe('claude-3-opus');
    expect(result.session?.cwd).toBe('/home/user/project');
  });

  it('should update existing adapter session on re-discovery', async () => {
    // First discovery
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-update-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-update-1',
      });
      expect(result.session).not.toBeNull();
    });

    // Re-discovery with updated lineage (e.g., fork detected later)
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-update-1',
      parentAdapterSessionId: 'cc-parent-new',
      forkPointMessageId: 'msg-new-fork',
      kind: 'fork',
      model: 'claude-3-sonnet',
      cwd: '/updated/path',
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-update-1',
      });
      expect(result.session?.parentAdapterSessionId).toBe('cc-parent-new');
    });

    // Verify the session was updated
    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-update-1',
    });

    expect(result.session?.parentAdapterSessionId).toBe('cc-parent-new');
    expect(result.session?.forkPointMessageId).toBe('msg-new-fork');
    expect(result.session?.kind).toBe('fork');
    expect(result.session?.model).toBe('claude-3-sonnet');
    expect(result.session?.cwd).toBe('/updated/path');
  });

  it('should handle discovery with only required fields', async () => {
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-minimal-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-minimal-1',
      });
      expect(result.session).not.toBeNull();
    });

    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-minimal-1',
    });

    expect(result.session?.adapterSessionId).toBe('cc-minimal-1');
    expect(result.session?.kind).toBe('root');
    expect(result.session?.model).toBeNull();
    expect(result.session?.cwd).toBeNull();
  });

  it('enriches an already-linked imported session with discovery metadata', async () => {
    const canonicalStartedAt = Date.parse('2026-03-08T09:00:00.000Z');
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-upload-first',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    const created = await createAndLinkImportedSession({
      bus: MakaioBus,
      adapterSessionId: 'cc-upload-first',
      adapterName: 'claude-code',
      adapterId: 'adapter-upload-first',
      metadata: makeImportedSessionMetadata(),
    });

    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-upload-first',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-upload-first',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: 'claude-3-7-sonnet',
      cwd: '/home/user/repo',
      title: 'Recovered Title',
      startedAt: canonicalStartedAt,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: created.sessionId,
      });
      expect(result.session?.title).toBe('Recovered Title');
      expect(result.session?.targetWorkingDirectory).toBe('/home/user/repo');
      expect(result.session?.createdAt).toBe(canonicalStartedAt);
      expect(result.session?.lastActivityAt).toBe(canonicalStartedAt);
    });
  });

  it('backfills createdAt without rewinding lastActivityAt after later imported activity', async () => {
    const canonicalStartedAt = Date.parse('2026-03-08T09:00:00.000Z');
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-upload-first-activity',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    const created = await createAndLinkImportedSession({
      bus: MakaioBus,
      adapterSessionId: 'cc-upload-first-activity',
      adapterName: 'claude-code',
      adapterId: 'adapter-upload-first',
      metadata: makeImportedSessionMetadata(),
    });

    const preservedLastActivityAt = Date.parse('2026-03-08T10:30:00.000Z');
    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: created.sessionId,
      lastActivityAt: preservedLastActivityAt,
    });

    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-upload-first',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-upload-first-activity',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: 'claude-3-7-sonnet',
      cwd: '/home/user/repo',
      title: 'Recovered Title',
      startedAt: canonicalStartedAt,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: created.sessionId,
      });
      expect(result.session?.createdAt).toBe(canonicalStartedAt);
      expect(result.session?.lastActivityAt).toBe(preservedLastActivityAt);
    });
  });

  it('should create a stub Makaio session linked to the adapter session', async () => {
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-stub-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-stub-session-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: 'claude-3-5-sonnet',
      cwd: '/home/user/myproject',
    });

    // Wait for the adapter session record to be linked (sessionId populated)
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-stub-session-1',
      });
      expect(result.session?.sessionId).not.toBeNull();
    });

    const adapterSession = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-stub-session-1',
    });

    expect(adapterSession.session?.sessionId).not.toBeNull();

    // Verify the Makaio stub session exists with correct fields
    const sessionId = adapterSession.session!.sessionId!;
    const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId,
    });

    expect(sessionResult.session).not.toBeNull();
    expect(sessionResult.session?.status).toBe('discovered');
    expect(sessionResult.session?.isImported).toBe(true);
    expect(sessionResult.session?.isOrchestrated).toBe(false);
    expect(sessionResult.session?.adapterSessionId).toBe('cc-stub-session-1');
    expect(sessionResult.session?.adapterName).toBe('claude-code');
    expect(sessionResult.session?.adapterId).toBe('adapter-stub-1');
    expect(sessionResult.session?.targetWorkingDirectory).toBe('/home/user/myproject');
  });

  it('should persist logFilePath in the adapter session record', async () => {
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-logpath-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
      logFilePath: '/home/user/.claude/projects/myproject/session-xyz.jsonl',
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-logpath-1',
      });
      expect(result.session).not.toBeNull();
    });

    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-logpath-1',
    });

    expect(result.session?.adapterSessionId).toBe('cc-logpath-1');
    expect(result.session?.logFilePath).toBe('/home/user/.claude/projects/myproject/session-xyz.jsonl');
  });

  it('should not overwrite existing Makaio session on re-discovery (ifAbsent idempotency)', async () => {
    // First discovery — creates the stub session
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-idempotent-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: '/home/user/project',
    });

    // Wait for the stub session to be created and linked
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-idempotent-1',
      });
      expect(result.session?.sessionId).not.toBeNull();
    });

    const firstResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-idempotent-1',
    });
    const firstSessionId = firstResult.session!.sessionId!;

    // Second discovery of the same adapter session
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-idempotent-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: 'claude-3-5-sonnet',
      cwd: '/home/user/project',
    });

    // Give the second handler time to complete
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-idempotent-1',
      });
      expect(result.session?.model).toBe('claude-3-5-sonnet');
    });

    // The sessionId must remain unchanged — ifAbsent prevents overwrite
    const secondResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-idempotent-1',
    });
    expect(secondResult.session?.sessionId).toBe(firstSessionId);
  });

  it('should persist startedAt from discovered event payload to adapter session record', async () => {
    const expectedStartedAt = Date.now() - 45_000;

    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-startedat-flow',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
      startedAt: expectedStartedAt,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-startedat-flow',
      });
      expect(result.session).not.toBeNull();
    });

    const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-startedat-flow',
    });

    expect(result.session?.startedAt).toBe(expectedStartedAt);
  });

  it('should gracefully handle missing cwd without project resolution', async () => {
    // No cwd — project resolution must be skipped, not fail
    await MakaioBus.emit(AdapterSubjects.session.discovered, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-nocwd-1',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-nocwd-1',
      });
      expect(result.session?.sessionId).not.toBeNull();
    });

    const adapterSession = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'cc-nocwd-1',
    });

    const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: adapterSession.session!.sessionId!,
    });

    expect(sessionResult.session?.status).toBe('discovered');
    // No targetWorkingDirectory when cwd is null
    expect(sessionResult.session?.targetWorkingDirectory).toBeUndefined();
  });

  it('should succeed when adapter is not configured in settings (discovery before adapter setup)', async () => {
    // Regression: discovery can fire before the user configures the adapter in settings.
    // The adapter.session.discovered handler must not crash when no adapter instance
    // row exists in the settings DB. Previously, resolveLinkedAdapterId threw
    // "No enabled adapter instance found" which propagated as an unhandled rejection.
    const linkedEvents: Array<{ adapterSessionId: string; sessionId: string }> = [];
    const unsubscribe = MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
      linkedEvents.push({
        adapterSessionId: ctx.payload.adapterSessionId,
        sessionId: ctx.payload.sessionId,
      });
    });

    try {
      // Use an adapter name that has NO corresponding row in the adapters settings table.
      // This reproduces the exact race: discovery enabled before adapter configured.
      await MakaioBus.emit(AdapterSubjects.session.discovered, {
        adapterId: 'unconfigured-runtime-id',
        adapterName: 'unconfigured-adapter',
        adapterSessionId: 'cc-unconfigured-1',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: 'claude-3-opus',
        cwd: '/home/user/project',
      });

      // The handler must complete without crashing — wait for the link to be established.
      await vi.waitFor(async () => {
        const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
          adapterSessionId: 'cc-unconfigured-1',
        });
        expect(result.session?.sessionId).not.toBeNull();
      });

      // Verify session was created and linked despite no adapter config
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-unconfigured-1',
      });
      expect(result.session?.adapterName).toBe('unconfigured-adapter');
      expect(result.session?.status).toBe('discovered');
      expect(result.session?.sessionId).not.toBeNull();

      // The adapter.session.linked event should still fire (without adapterId)
      expect(linkedEvents).toHaveLength(1);
      expect(linkedEvents[0].adapterSessionId).toBe('cc-unconfigured-1');
    } finally {
      unsubscribe();
    }
  });

  it('should handle multiple rapid discoveries without adapter config (bulk scan scenario)', async () => {
    // Regression: when discovery scans ~/.claude/projects/ on startup, it emits
    // adapter.session.discovered for every .jsonl file. All events arrive before
    // the adapter is configured, causing 10+ resolveId failures in rapid succession.
    const sessions = Array.from({ length: 5 }, (_, i) => `cc-bulk-${i}`);

    for (const adapterSessionId of sessions) {
      await MakaioBus.emit(AdapterSubjects.session.discovered, {
        adapterId: 'bulk-runtime-id',
        adapterName: 'unconfigured-bulk-adapter',
        adapterSessionId,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });
    }

    // All sessions must eventually be created and linked — no crashes, no orphans
    await vi.waitFor(async () => {
      for (const adapterSessionId of sessions) {
        const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, { adapterSessionId });
        expect(result.session?.sessionId).not.toBeNull();
      }
    });

    // Verify all 5 sessions exist with Makaio session links
    for (const adapterSessionId of sessions) {
      const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.get, { adapterSessionId });
      expect(session?.status).toBe('discovered');
      expect(session?.sessionId).toBeTruthy();
    }
  });
});

describe('createAndLinkImportedSession', () => {
  let cleanup: () => void;
  let db: TestDbContext['db'];

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('returns existing sessionId when adapter session is already linked (idempotent)', async () => {
    // First: upsert and link an adapter session via the discovered handler
    const handlerCleanup = registerSessionDiscoveredHandler(MakaioBus);
    try {
      const originalSessionId = await emitDiscoveredAndWaitLinked({
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'cc-idempotent-test',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        model: null,
        cwd: null,
      });

      // Call again — should return the existing sessionId without creating a new session
      const result = await createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-idempotent-test',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata(),
      });

      expect(result.sessionId).toBe(originalSessionId);
      expect(result.created).toBe(false);
    } finally {
      handlerCleanup();
    }
  });

  it('resolves parentSessionId from the parent adapter session when parent is already linked', async () => {
    // Set up parent: upsert and link it first via the discovered handler
    const handlerCleanup = registerSessionDiscoveredHandler(MakaioBus);
    try {
      const parentSessionId = await emitDiscoveredAndWaitLinked({
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'cc-parent-for-link',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        model: null,
        cwd: null,
      });

      // Upsert child adapter session so linkSession can find it
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-child-for-link',
        adapterName: 'claude-code',
        kind: 'subagent',
        parentAdapterSessionId: 'cc-parent-for-link',
        forkPointMessageId: null,
        model: null,
        cwd: null,
      });

      // Create child via unified helper
      const result = await createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-child-for-link',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata({
          parentAdapterSessionId: 'cc-parent-for-link',
          kind: 'subagent',
        }),
      });

      expect(result.created).toBe(true);

      // Verify the created session has the correct parentSessionId
      const { session: childSession } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: result.sessionId,
      });
      expect(childSession?.parentSessionId).toBe(parentSessionId);
      expect(childSession?.branchKind).toBe('subagent');
    } finally {
      handlerCleanup();
    }
  });

  it('sets parentSessionId to undefined when parent is not yet linked', async () => {
    // Upsert a parent adapter session but do NOT link it to a Makaio session
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-unlinked-parent',
      adapterName: 'claude-code',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      model: null,
      cwd: null,
    });

    // Upsert child adapter session so linkSession can find it
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-child-unlinked-parent',
      adapterName: 'claude-code',
      kind: 'subagent',
      parentAdapterSessionId: 'cc-unlinked-parent',
      forkPointMessageId: null,
      model: null,
      cwd: null,
    });

    // Create child — parent exists in adapter space but has no Makaio sessionId
    const result = await createAndLinkImportedSession({
      bus: MakaioBus,
      adapterSessionId: 'cc-child-unlinked-parent',
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      metadata: makeImportedSessionMetadata({
        parentAdapterSessionId: 'cc-unlinked-parent',
        kind: 'subagent',
      }),
    });

    expect(result.created).toBe(true);

    const { session: childSession } = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: result.sessionId,
    });
    // parentSessionId is not set — parent-resolver will backfill it later
    expect(childSession?.parentSessionId).toBeUndefined();
  });

  it('emits SessionSubjects.created with canonical createdAt, parentSessionId, and branchKind', async () => {
    const createdEvents: Array<{
      sessionId: string;
      createdAt: number;
      parentSessionId: string | null;
      branchKind: BranchKind | null;
    }> = [];
    const eventCleanup = MakaioBus.on(SessionSubjects.created, (ctx) => {
      createdEvents.push({
        sessionId: ctx.payload.sessionId,
        createdAt: ctx.payload.createdAt,
        parentSessionId: ctx.payload.parentSessionId,
        branchKind: ctx.payload.branchKind,
      });
    });

    // Set up parent first via the discovered handler
    const handlerCleanup = registerSessionDiscoveredHandler(MakaioBus);
    try {
      const parentSessionId = await emitDiscoveredAndWaitLinked({
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'cc-parent-for-event',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        model: null,
        cwd: null,
      });

      // Upsert child adapter session so linkSession can find it
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-child-for-event',
        adapterName: 'claude-code',
        kind: 'subagent',
        parentAdapterSessionId: 'cc-parent-for-event',
        forkPointMessageId: null,
        model: null,
        cwd: null,
        startedAt: 1_741_445_200_000,
      });

      const initialEventCount = createdEvents.length;

      // Create child
      const result = await createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-child-for-event',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata({
          parentAdapterSessionId: 'cc-parent-for-event',
          kind: 'subagent',
        }),
      });

      // Verify the event was emitted with the correct fields
      const childEvent = createdEvents.find((e) => e.sessionId === result.sessionId);
      expect(childEvent).toBeDefined();
      expect(childEvent?.createdAt).toBe(1_741_445_200_000);
      expect(childEvent?.parentSessionId).toBe(parentSessionId);
      expect(childEvent?.branchKind).toBe('subagent');
      expect(createdEvents.length).toBe(initialEventCount + 1);
    } finally {
      eventCleanup();
      handlerCleanup();
    }
  });

  it('returns the winning sessionId when another importer links first', async () => {
    const winningSessionId = 'makaio-race-winner';
    await db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, is_orchestrated, is_imported)
      VALUES (${winningSessionId}, 0, 0, 'active', 0, 0)
    `);
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-link-race-test',
      adapterName: 'claude-code',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      model: null,
      cwd: null,
    });

    const linkRaceCleanup = MakaioBus.on(
      AdapterSessionStorageSubjects.linkSession,
      async (ctx) => {
        if (ctx.payload.adapterSessionId !== 'cc-link-race-test') {
          await ctx.next();
          return;
        }

        await db.run(sql`
          UPDATE adapter_sessions
          SET session_id = ${winningSessionId}
          WHERE adapter_session_id = ${ctx.payload.adapterSessionId}
        `);
        ctx.setResult({ success: false });
      },
      { priority: 100 },
    );

    try {
      const result = await createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-link-race-test',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata(),
      });

      expect(result).toEqual({ sessionId: winningSessionId, created: false });
    } finally {
      linkRaceCleanup();
    }
  });

  it('deletes session and re-throws when an unexpected error occurs after session creation', async () => {
    // Upsert the child adapter session so linkSession can find it
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'cc-link-fail-test',
      adapterName: 'claude-code',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      model: null,
      cwd: null,
    });

    // Register a high-priority linkSession mock that throws to simulate an unexpected error.
    // High priority (100) ensures it runs before the real handler (priority 0) and throws.
    const linkFailCleanup = MakaioBus.on(
      AdapterSessionStorageSubjects.linkSession,
      (_ctx) => {
        throw new Error('Link intentionally failed');
      },
      { priority: 100 },
    );

    let thrownError: unknown;
    try {
      await createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-link-fail-test',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata(),
      });
    } catch (error) {
      thrownError = error;
    } finally {
      linkFailCleanup();
    }

    // The error must have been re-thrown (wrapped in RequestError by the bus)
    expect(thrownError).toBeInstanceOf(RequestError);
    if (thrownError instanceof RequestError) {
      expect(String(thrownError.cause)).toContain('Link intentionally failed');
    }
    // The created session must have been cleaned up from real storage
    const orphanedSessions = await db.all(
      sql`SELECT session_id FROM sessions WHERE adapter_session_id = ${'cc-link-fail-test'}`,
    );
    expect(orphanedSessions).toHaveLength(0);
  });

  it('fails fast when createAndLink is called for a missing adapter session', async () => {
    await expect(
      createAndLinkImportedSession({
        bus: MakaioBus,
        adapterSessionId: 'cc-missing-adapter-session',
        adapterName: 'claude-code',
        adapterId: 'adapter-1',
        metadata: makeImportedSessionMetadata(),
      }),
    ).rejects.toThrow('Adapter session not found for createAndLink: cc-missing-adapter-session');
  });
});
