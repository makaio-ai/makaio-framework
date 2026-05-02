/**
 * Integration tests for importFromFileContent and importSegmentTree.
 *
 * Verifies the production import path end-to-end:
 * - importer.processLogFile is called and its results are persisted
 * - MessageStorageSubjects.upsertByAdapterMessageId is called for each message payload
 * - AdapterSessionStorageSubjects.upsert receives the correct session metadata
 * - Zero message upserts occur when messagePayloads is empty
 * - Import cursor is written with sessionContext after a successful full import
 * - importSegmentTree derives startedAt from the first message timestamp (Path B)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { basename } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { ImportCursorStorageSubjects } from '@makaio/ai-adapters-core';
import { IMPORTER_REGISTRATIONS } from '@makaio/log-importers';
import { getOpenCodeFixtureDir } from '@makaio/extension-opencode/testing';
import { AdapterSubjects, type MakaioSessionEvent } from '@makaio/contracts';
import {
  AdapterSessionStorageSubjects,
  MessageStorageSubjects,
  SessionEventStorageSubjects,
  SessionStorageSubjects,
} from '@makaio/services-core/session';
import { importFromFileContent, importSegmentTree } from '../generic-import-handlers.js';
import { createOpenCodeFixtureSession } from './opencode-test-helpers.js';

const OPENCODE_FIXTURE_DIR = getOpenCodeFixtureDir();

// TODO: Tests using createClaudeCodeCliImporter should use a Claude adapter
// name, not 'plugin:opencode'. The adapter name is metadata that flows through
// the import pipeline — using the wrong one doesn't break the test but can
// hide adapter-name propagation bugs. Fix in a bulk pass when standardizing
// test adapter identities across the codebase.
const ADAPTER_NAME = 'plugin:opencode';

/** Minimal adapter session upsert response shape. */
interface AdapterSessionUpsertResponse {
  adapterSessionId: string;
  sessionId: string | null;
  created: boolean;
}

/** Captured payload from a upsertByAdapterMessageId bus call. */
interface CapturedMessageUpsert {
  sessionId: string;
  adapterMessageId: string;
  role: string;
  contentText: string;
  blocks: unknown[];
}

/** Captured cursor set payload. */
interface CapturedCursorSet {
  filePath: string;
  bytesRead: number;
  lastModified: string;
  sessionContext: {
    adapterSessionId: string;
    model: string | null;
    cwd: string | null;
    sessionEvent: unknown;
    startedEvent: unknown;
    state: unknown;
  } | null;
}

interface CapturedSessionUpdate {
  sessionId: string;
  status?: string;
}

/**
 * Create the canonical Claude Code CLI log importer from the host owner package.
 * @param config - Runtime adapter identity used by the importer instance
 * @returns Concrete importer instance for integration tests
 */
function createClaudeCodeCliImporter(config: { adapterId: string; adapterName: string }) {
  const registration = IMPORTER_REGISTRATIONS.get('claude-code-cli');
  if (!registration) {
    throw new Error('Claude Code CLI log import registration is not available');
  }

  return new registration.LogImporterClass({
    adapterId: config.adapterId,
    adapterName: config.adapterName,
    checkMakaioManaged: async () => false,
  });
}

describe('importFromFileContent (integration)', () => {
  const cleanups: Array<() => void> = [];
  const fixtureCleanups: Array<() => Promise<void>> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  afterEach(async () => {
    while (fixtureCleanups.length > 0) {
      await fixtureCleanups.pop()?.();
    }
  });

  /**
   * Register the minimal set of bus handlers required for importFromFileContent
   * to complete without errors. Returns the captured upsert payloads.
   */
  function registerStorageHandlers(): {
    adapterSessionUpserts: Array<Record<string, unknown>>;
    messageUpserts: CapturedMessageUpsert[];
    adapterSessionStatuses: Array<{ adapterSessionId: string; status: string }>;
    cursorSets: CapturedCursorSet[];
    sessionUpdates: CapturedSessionUpdate[];
    sessionEvents: MakaioSessionEvent[];
    linkedEvents: Array<{ adapterSessionId: string; sessionId: string; replay?: boolean }>;
  } {
    const adapterSessionUpserts: Array<Record<string, unknown>> = [];
    const messageUpserts: CapturedMessageUpsert[] = [];
    const adapterSessionStatuses: Array<{ adapterSessionId: string; status: string }> = [];
    const cursorSets: CapturedCursorSet[] = [];
    const sessionUpdates: CapturedSessionUpdate[] = [];
    const sessionEvents: MakaioSessionEvent[] = [];
    const linkedEvents: Array<{ adapterSessionId: string; sessionId: string; replay?: boolean }> = [];
    const sessionIdsByAdapterSession = new Map<string, string>();

    // AdapterSession.upsert — capture the payload and return created=true
    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.upsert, (ctx) => {
        adapterSessionUpserts.push({ ...ctx.payload });
        const response: AdapterSessionUpsertResponse = {
          adapterSessionId: ctx.payload.adapterSessionId,
          sessionId: null,
          created: true,
        };
        ctx.setResult(response);
      }),
    );

    // AdapterSession.createAndLink — create and link a Makaio session
    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.createAndLink, (ctx) => {
        const existingSessionId = sessionIdsByAdapterSession.get(ctx.payload.adapterSessionId);
        if (existingSessionId) {
          ctx.setResult({ sessionId: existingSessionId, created: false });
          return;
        }

        const sessionId = crypto.randomUUID();
        sessionIdsByAdapterSession.set(ctx.payload.adapterSessionId, sessionId);
        ctx.setResult({ sessionId, created: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionStorageSubjects.update, (ctx) => {
        sessionUpdates.push({
          sessionId: ctx.payload.sessionId,
          status: 'status' in ctx.payload ? ctx.payload.status : undefined,
        });
        ctx.setResult({ success: true });
      }),
    );

    // Message.upsertByAdapterMessageId — capture each message written
    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.upsertByAdapterMessageId, (ctx) => {
        messageUpserts.push({
          sessionId: ctx.payload.sessionId,
          adapterMessageId: ctx.payload.adapterMessageId,
          role: ctx.payload.role,
          contentText: ctx.payload.contentText,
          blocks: ctx.payload.blocks,
        });
        ctx.setResult({ messageId: crypto.randomUUID(), created: true });
      }),
    );

    // AdapterSession.updateStatus — capture status transitions
    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.updateStatus, (ctx) => {
        adapterSessionStatuses.push({
          adapterSessionId: ctx.payload.adapterSessionId,
          status: ctx.payload.status,
        });
        ctx.setResult({ success: true });
      }),
    );

    // ImportCursor.set — capture cursor writes for incremental read support
    cleanups.push(
      MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
        cursorSets.push({
          filePath: ctx.payload.filePath,
          bytesRead: ctx.payload.bytesRead,
          lastModified: ctx.payload.lastModified,
          sessionContext: ctx.payload.sessionContext ?? null,
        });
        ctx.setResult({ success: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.append, (ctx) => {
        sessionEvents.push(ctx.payload.event);
        ctx.setResult({ success: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
        const { sessionId, eventIds } = ctx.payload;
        const idSet = new Set(eventIds);
        ctx.setResult({
          events: sessionEvents.filter((event) => event.sessionId === sessionId && idSet.has(String(event.eventId))),
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        linkedEvents.push({
          adapterSessionId: ctx.payload.adapterSessionId,
          sessionId: ctx.payload.sessionId,
          replay: ctx.payload.replay,
        });
      }),
    );

    return {
      adapterSessionUpserts,
      messageUpserts,
      adapterSessionStatuses,
      cursorSets,
      sessionUpdates,
      sessionEvents,
      linkedEvents,
    };
  }

  it('persists each message payload via upsertByAdapterMessageId', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'adapter-instance-1',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { adapterSessionUpserts, messageUpserts, adapterSessionStatuses, sessionUpdates, linkedEvents } =
      registerStorageHandlers();

    const result = await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'adapter-instance-1',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: fixture.sessionFilePath,
    });

    // Two messages were written
    expect(result.messageCount).toBe(2);
    expect(messageUpserts).toHaveLength(2);

    // First message: user role with fixture content
    expect(messageUpserts[0].adapterMessageId).toBe('msg_bb815fae3001NfwSfS3QMC3yzU');
    expect(messageUpserts[0].role).toBe('user');
    expect(messageUpserts[0].contentText).toBe('Install the opencode-antigravity-auth plugin');

    // Second message: assistant role with fixture content
    expect(messageUpserts[1].adapterMessageId).toBe('msg_bbc7965ee0013MiAht130lgpXk');
    expect(messageUpserts[1].role).toBe('assistant');
    expect(messageUpserts[1].contentText).toContain("I'll help you install");

    // Each message has non-empty blocks
    expect(messageUpserts[0].blocks.length).toBeGreaterThan(0);

    // All messages share the same sessionId (the Makaio session ID)
    const uniqueSessionIds = new Set(messageUpserts.map((m) => m.sessionId));
    expect(uniqueSessionIds.size).toBe(1);
    // A fresh UUID is generated for the Makaio session — it must not equal the
    // adapter session ID (which may be a non-UUID synthetic ID like "ses_...").
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(result.sessionId).not.toBe(fixture.adapterSessionId);

    // Adapter session was upserted with correct metadata
    expect(adapterSessionUpserts).toHaveLength(1);
    expect(adapterSessionUpserts[0].adapterSessionId).toBe(fixture.adapterSessionId);
    expect(adapterSessionUpserts[0].adapterName).toBe(ADAPTER_NAME);
    expect(adapterSessionUpserts[0].model).toBeNull();
    expect(adapterSessionUpserts[0].cwd).toBeNull();
    expect(adapterSessionUpserts[0].logFilePath).toBe(fixture.sessionFilePath);

    // Status updated to 'imported' at the end
    expect(adapterSessionStatuses).toHaveLength(1);
    expect(adapterSessionStatuses[0].status).toBe('imported');
    expect(sessionUpdates).toContainEqual({ sessionId: result.sessionId, status: 'active' });
    expect(linkedEvents).toEqual([]);
  });

  it('performs zero message upserts when messagePayloads is empty', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'adapter-instance-2',
      adapterName: ADAPTER_NAME,
      includeMessages: false,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { messageUpserts, adapterSessionStatuses } = registerStorageHandlers();

    const result = await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'adapter-instance-2',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: fixture.sessionFilePath,
    });

    expect(result.messageCount).toBe(0);
    expect(messageUpserts).toHaveLength(0);

    // Status still updated to 'imported' even with no messages
    expect(adapterSessionStatuses).toHaveLength(1);
    expect(adapterSessionStatuses[0].status).toBe('imported');
  });

  it('upserts adapter session with correct metadata from sessionEvent', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-instance-1',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { adapterSessionUpserts } = registerStorageHandlers();

    await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'opencode-instance-1',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: fixture.sessionFilePath,
    });

    expect(adapterSessionUpserts).toHaveLength(1);
    const upserted = adapterSessionUpserts[0];
    expect(upserted.adapterSessionId).toBe(fixture.adapterSessionId);
    expect(upserted.adapterName).toBe(ADAPTER_NAME);
    expect(upserted.parentAdapterSessionId).toBeNull();
    expect(upserted.forkPointMessageId).toBeNull();
    expect(upserted.model).toBeNull();
    expect(upserted.cwd).toBeNull();
    expect(upserted.logFilePath).toBe(fixture.sessionFilePath);
  });

  it('writes import cursor with sessionContext after full import of an absolute path', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-cursor-test',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { cursorSets } = registerStorageHandlers();

    await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'opencode-cursor-test',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: fixture.sessionFilePath,
    });

    // Cursor should be written for the absolute file path
    expect(cursorSets).toHaveLength(1);
    const cursor = cursorSets[0];
    expect(cursor.filePath).toBe(fixture.sessionFilePath);
    expect(cursor.bytesRead).toBeGreaterThan(0);
    expect(cursor.lastModified).toBeTruthy();
    expect(cursor.sessionContext).toBeDefined();
    expect(cursor.sessionContext?.adapterSessionId).toBe(fixture.adapterSessionId);
    expect(cursor.sessionContext?.sessionEvent).toBeDefined();
    expect(cursor.sessionContext?.startedEvent).toBeDefined();
    expect(cursor.sessionContext?.state).toBeDefined();
  });

  it('normalizes persisted relative log paths before upsert and cursor persistence', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-relative-path-test',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { cursorSets, adapterSessionUpserts } = registerStorageHandlers();
    const relativeLogPath = basename(fixture.sessionFilePath);

    await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'opencode-relative-path-test',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: relativeLogPath,
    });

    expect(adapterSessionUpserts).toHaveLength(1);
    expect(adapterSessionUpserts[0].logFilePath).toBe(fixture.sessionFilePath);
    expect(cursorSets).toHaveLength(1);
    expect(cursorSets[0].filePath).toBe(fixture.sessionFilePath);
  });

  it('does not persist cursor or logFilePath for upload-style imports', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-no-cursor-test',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { cursorSets, adapterSessionUpserts } = registerStorageHandlers();

    await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'opencode-no-cursor-test',
      sourceFilePath: fixture.sessionFilePath,
    });

    expect(cursorSets).toHaveLength(0);
    expect(adapterSessionUpserts).toHaveLength(1);
    expect(adapterSessionUpserts[0].logFilePath).toBeUndefined();
  });

  it('imports nested compress children and emits compaction events for each segment', async () => {
    const rootSessionId = 'session-root';
    const childSessionId = 'session-child';
    const grandchildSessionId = 'session-grandchild';
    let createCount = 0;

    const {
      adapterSessionUpserts,
      messageUpserts,
      adapterSessionStatuses,
      sessionEvents,
      sessionUpdates,
      linkedEvents,
    } = registerStorageHandlers();

    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }

    cleanups.push(
      MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        linkedEvents.push({
          adapterSessionId: ctx.payload.adapterSessionId,
          sessionId: ctx.payload.sessionId,
          replay: ctx.payload.replay,
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.upsert, (ctx) => {
        adapterSessionUpserts.push({ ...ctx.payload });
        ctx.setResult({
          adapterSessionId: ctx.payload.adapterSessionId,
          sessionId: null,
          created: true,
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.createAndLink, (ctx) => {
        const sessionId = [rootSessionId, childSessionId, grandchildSessionId][createCount] ?? crypto.randomUUID();
        createCount += 1;
        ctx.setResult({ sessionId, created: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionStorageSubjects.update, (ctx) => {
        sessionUpdates.push({
          sessionId: ctx.payload.sessionId,
          status: 'status' in ctx.payload ? ctx.payload.status : undefined,
        });
        ctx.setResult({ success: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.upsertByAdapterMessageId, (ctx) => {
        messageUpserts.push({
          sessionId: ctx.payload.sessionId,
          adapterMessageId: ctx.payload.adapterMessageId,
          role: ctx.payload.role,
          contentText: ctx.payload.contentText,
          blocks: ctx.payload.blocks,
        });
        ctx.setResult({ messageId: crypto.randomUUID(), created: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.updateStatus, (ctx) => {
        adapterSessionStatuses.push({
          adapterSessionId: ctx.payload.adapterSessionId,
          status: ctx.payload.status,
        });
        ctx.setResult({ success: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.append, (ctx) => {
        sessionEvents.push(ctx.payload.event);
        ctx.setResult({ success: true });
      }),
    );

    cleanups.push(
      MakaioBus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
        const { sessionId, eventIds } = ctx.payload;
        const idSet = new Set(eventIds);
        ctx.setResult({
          events: sessionEvents.filter((event) => event.sessionId === sessionId && idSet.has(String(event.eventId))),
        });
      }),
    );

    const importer = createClaudeCodeCliImporter({
      adapterId: 'adapter-instance-nested',
      adapterName: ADAPTER_NAME,
    });

    const content = [
      {
        type: 'user',
        uuid: 'root-message',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:01.000Z',
        message: { role: 'user', content: 'Root' },
      },
      {
        type: 'assistant',
        uuid: 'root-reply',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:02.000Z',
        message: {
          id: 'msg-root-reply',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-opus',
          content: [{ type: 'text', text: 'Root reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        sessionId: 'adapter-root',
        uuid: 'boundary-child',
        timestamp: '2026-03-08T18:00:03.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 42 },
      },
      {
        type: 'user',
        uuid: 'child-summary',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:04.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'Child summary' },
      },
      {
        type: 'assistant',
        uuid: 'child-reply',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:05.000Z',
        message: {
          id: 'msg-child-reply',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-opus',
          content: [{ type: 'text', text: 'Child reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 101, output_tokens: 51 },
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        sessionId: 'adapter-root',
        uuid: 'boundary-grandchild',
        timestamp: '2026-03-08T18:00:06.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 84 },
      },
      {
        type: 'user',
        uuid: 'grandchild-summary',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:07.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'Grandchild summary' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
      .concat('\n');

    const result = await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'adapter-instance-nested',
    });

    expect(result.sessionId).toBe(rootSessionId);
    expect(result.messageCount).toBe(5);
    expect(messageUpserts.map((message) => message.sessionId)).toEqual([
      rootSessionId,
      rootSessionId,
      childSessionId,
      childSessionId,
      grandchildSessionId,
    ]);
    expect(adapterSessionStatuses.map((status) => status.adapterSessionId)).toEqual([
      'adapter-root:compress:boundary-grandchild',
      'adapter-root:compress:boundary-child',
      'adapter-root',
    ]);
    expect(sessionUpdates).toEqual([
      { sessionId: grandchildSessionId, status: 'active' },
      { sessionId: childSessionId, status: 'active' },
      { sessionId: rootSessionId, status: 'active' },
    ]);
    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0]).toMatchObject({
      sessionId: rootSessionId,
      type: 'session.compacted',
      payload: {
        trigger: 'manual',
        preTokens: 42,
        summary: 'Child summary',
        compressChildSessionId: childSessionId,
      },
    });
    expect(sessionEvents[1]).toMatchObject({
      sessionId: childSessionId,
      type: 'session.compacted',
      payload: {
        trigger: 'auto',
        preTokens: 84,
        summary: 'Grandchild summary',
        compressChildSessionId: grandchildSessionId,
      },
    });
    // Tree traversal order guarantees compress parents are persisted before their
    // post-compaction subagents, so resolveLineage finds the correct sessionId at
    // link time. No post-persist replay is emitted for compress segments on the
    // tree import path.
    expect(linkedEvents).toEqual([]);
  });

  // This test validates the import pipeline's startedAt derivation and the
  // payload shape sent to the storage handler. End-to-end persistence through
  // the real drizzle handler is covered by drizzle-handler.upsert.test.ts
  // (explicit insert, write-once, backfill, and default-to-now scenarios).
  it('sets startedAt on the adapter session upsert from the first message timestamp (Path B)', async () => {
    const STARTED_AT_MS = 1741449601000; // 2025-03-08T18:00:01.000Z
    const { adapterSessionUpserts } = registerStorageHandlers();

    const segment = {
      adapterSessionId: 'session-startedat-path-b',
      lineage: {
        kind: 'root' as const,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      },
      messages: [
        {
          adapterMessageId: 'msg-1',
          role: 'user' as const,
          contentText: 'Hello',
          blocks: [],
          agentId: 'main',
          adapterSessionId: 'session-startedat-path-b',
          timestamp: STARTED_AT_MS + 1000,
        },
        {
          adapterMessageId: 'msg-2',
          role: 'assistant' as const,
          contentText: 'World',
          blocks: [],
          agentId: 'main',
          adapterSessionId: 'session-startedat-path-b',
          timestamp: STARTED_AT_MS,
        },
      ],
    };

    await importSegmentTree(MakaioBus, segment, {
      adapterId: 'adapter-startedat-test',
      adapterName: ADAPTER_NAME,
      model: null,
      cwd: null,
    });

    expect(adapterSessionUpserts).toHaveLength(1);
    expect(adapterSessionUpserts[0].startedAt).toBe(STARTED_AT_MS);
  });

  it('does not append duplicate compaction events on re-import', async () => {
    const { sessionEvents } = registerStorageHandlers();

    const importer = createClaudeCodeCliImporter({
      adapterId: 'adapter-instance-idempotent',
      adapterName: ADAPTER_NAME,
    });

    const content = [
      {
        type: 'user',
        uuid: 'root-message',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:01.000Z',
        message: { role: 'user', content: 'Root' },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        sessionId: 'adapter-root',
        uuid: 'boundary-child',
        timestamp: '2026-03-08T18:00:03.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 42 },
      },
      {
        type: 'user',
        uuid: 'child-summary',
        session_id: 'adapter-root',
        agentId: 'main',
        cwd: '/tmp/project',
        timestamp: '2026-03-08T18:00:04.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'Child summary' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
      .concat('\n');

    await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'adapter-instance-idempotent',
    });

    await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'adapter-instance-idempotent',
    });

    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({
      eventId: expect.stringContaining('session-compacted:'),
      type: 'session.compacted',
    });
  });
});
