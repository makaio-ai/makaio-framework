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
import {
  ImportCursorStorageSubjects,
  type ProcessLogFileResult,
  type StorageMessagePayload,
} from '@makaio/ai-adapters-core';
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
import { createMockImporter } from './test-helpers.js';

const OPENCODE_FIXTURE_DIR = getOpenCodeFixtureDir();

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

  it('persists nested compaction events idempotently across repeated imports', async () => {
    const { sessionEvents } = registerStorageHandlers();
    const rootSessionId = 'session-with-compaction-root';
    const compressSessionId = 'session-with-compaction-child';
    const nestedCompressSessionId = 'session-with-compaction-grandchild';

    const message = (
      adapterSessionId: string,
      adapterMessageId: string,
      contentText: string,
      timestamp: number,
      origin?: StorageMessagePayload['origin'],
    ): StorageMessagePayload => ({
      adapterSessionId,
      adapterMessageId,
      role: 'user',
      contentText,
      blocks: [{ type: 'text', content: contentText }],
      agentId: 'main',
      timestamp,
      ...(origin !== undefined ? { origin } : {}),
    });
    const assertString = (value: unknown): asserts value is string => {
      expect(typeof value).toBe('string');
    };

    const result: ProcessLogFileResult = {
      adapterSessionId: rootSessionId,
      sessionEvent: {
        subject: {} as never,
        payload: {
          adapterSessionId: rootSessionId,
          kind: 'root',
          parentAdapterSessionId: null,
          forkPointMessageId: null,
          model: 'mock-model',
          cwd: '/mock/project',
        },
      },
      messageEvents: [],
      messagePayloads: [message(rootSessionId, 'root-message', 'Root message', 1000)],
      lineage: {
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      },
      compressChildren: [
        {
          adapterSessionId: compressSessionId,
          sessionEvent: {
            subject: {} as never,
            payload: {
              adapterSessionId: compressSessionId,
              kind: 'compress',
              parentAdapterSessionId: rootSessionId,
              forkPointMessageId: null,
              model: 'mock-model',
              cwd: '/mock/project',
            },
          },
          messageEvents: [],
          messagePayloads: [
            message(compressSessionId, 'compact-summary-1', 'First compaction summary', 2000, 'compact'),
          ],
          lineage: {
            kind: 'compress',
            parentAdapterSessionId: rootSessionId,
            forkPointMessageId: null,
          },
          compactionMetadata: {
            trigger: 'auto',
            preTokens: 12000,
            timestamp: 1990,
          },
          compressChildren: [
            {
              adapterSessionId: nestedCompressSessionId,
              sessionEvent: {
                subject: {} as never,
                payload: {
                  adapterSessionId: nestedCompressSessionId,
                  kind: 'compress',
                  parentAdapterSessionId: compressSessionId,
                  forkPointMessageId: null,
                  model: 'mock-model',
                  cwd: '/mock/project',
                },
              },
              messageEvents: [],
              messagePayloads: [
                message(nestedCompressSessionId, 'compact-summary-2', 'Nested compaction summary', 3000, 'compact'),
              ],
              lineage: {
                kind: 'compress',
                parentAdapterSessionId: compressSessionId,
                forkPointMessageId: null,
              },
              compactionMetadata: {
                trigger: 'manual',
                preTokens: 6000,
                timestamp: 2990,
              },
            },
          ],
        },
      ],
    };

    const importer = createMockImporter({
      parseRecord: (line) => {
        const parsed: unknown = typeof line === 'string' ? JSON.parse(line) : line;
        return parsed;
      },
      processLogFile: () => result,
    });
    const content = [
      { type: 'session', id: rootSessionId },
      { type: 'compact_boundary', parent: rootSessionId, child: compressSessionId },
      { type: 'compact_boundary', parent: compressSessionId, child: nestedCompressSessionId },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');

    const firstImport = await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'mock-compaction-importer',
    });

    const secondImport = await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'mock-compaction-importer',
    });

    expect(firstImport.sessionId).toBe(secondImport.sessionId);
    expect(firstImport.messageCount).toBe(3);
    expect(secondImport.messageCount).toBe(3);
    expect(sessionEvents).toHaveLength(2);
    const firstCompactionChildId = sessionEvents[0].payload.compressChildSessionId;
    const nestedCompactionChildId = sessionEvents[1].payload.compressChildSessionId;
    assertString(firstCompactionChildId);
    assertString(nestedCompactionChildId);
    expect(sessionEvents.map((event) => event.eventId)).toEqual([
      `session-compacted:${firstImport.sessionId}:${firstCompactionChildId}`,
      `session-compacted:${firstCompactionChildId}:${nestedCompactionChildId}`,
    ]);
    expect(sessionEvents.map((event) => event.payload.summary)).toEqual([
      'First compaction summary',
      'Nested compaction summary',
    ]);
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
});
