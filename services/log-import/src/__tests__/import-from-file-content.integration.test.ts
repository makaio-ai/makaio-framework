/**
 * Integration tests for importFromFileContent and importSegmentTree.
 *
 * Verifies the production import path end-to-end:
 * - importer.processLogFile is called and its results are persisted
 * - MessageStorageSubjects.upsertByAdapterMessageId is called for each message payload
 * - SessionStorageSubjects.importUpsert receives the correct session metadata
 * - Zero message upserts occur when messagePayloads is empty
 * - Import cursor is written with sessionContext after a successful full import
 * - importSegmentTree derives startedAt from the first message timestamp (Path B)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import {
  ImportCursorStorageSubjects,
  type ProcessLogFileResult,
  type StorageMessagePayload,
  type NormalizedEvent,
} from '@makaio/ai-adapters-core';
import { getOpenCodeFixtureDir } from '@makaio/extension-opencode/testing';
import { type MakaioSessionEvent } from '@makaio/contracts';
import {
  MessageStorageSubjects,
  SessionEventStorageSubjects,
  SessionStorageSubjects,
} from '@makaio/services-core/session';
import { importFromFileContent, importSegmentTree } from '../generic-import-handlers.js';
import { createOpenCodeFixtureSession } from './opencode-test-helpers.js';
import { createMockImporter } from './test-helpers.js';

const OPENCODE_FIXTURE_DIR = getOpenCodeFixtureDir();

const ADAPTER_NAME = 'plugin:opencode';

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

/** Captured payload from SessionStorageSubjects.importUpsert bus calls. */
type CapturedImportUpsert = Record<string, unknown>;

/** Captured payload from SessionStorageSubjects.updateImportStatus bus calls. */
interface CapturedImportStatus {
  sessionId: string;
  importStatus: string;
}

interface CapturedSessionUpdate {
  sessionId: string;
  status?: string;
}

describe('importFromFileContent (integration)', () => {
  const cleanups: Array<() => void> = [];
  const fixtureCleanups: Array<() => Promise<void>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  afterEach(async () => {
    while (fixtureCleanups.length > 0) {
      await fixtureCleanups.pop()?.();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  /**
   * Register the minimal set of bus handlers required for importFromFileContent
   * to complete without errors. Returns the captured upsert payloads.
   */
  function registerStorageHandlers(): {
    importUpserts: CapturedImportUpsert[];
    messageUpserts: CapturedMessageUpsert[];
    importStatusUpdates: CapturedImportStatus[];
    cursorSets: CapturedCursorSet[];
    sessionUpdates: CapturedSessionUpdate[];
    sessionEvents: MakaioSessionEvent[];
  } {
    const importUpserts: CapturedImportUpsert[] = [];
    const messageUpserts: CapturedMessageUpsert[] = [];
    const importStatusUpdates: CapturedImportStatus[] = [];
    const cursorSets: CapturedCursorSet[] = [];
    const sessionUpdates: CapturedSessionUpdate[] = [];
    const sessionEvents: MakaioSessionEvent[] = [];
    const sessionIdsByExternalSession = new Map<string, string>();

    // SessionStorageSubjects.importUpsert — create or enrich an imported session record
    cleanups.push(
      MakaioBus.on(SessionStorageSubjects.importUpsert, (ctx) => {
        importUpserts.push({ ...ctx.payload });
        const existingSessionId = sessionIdsByExternalSession.get(ctx.payload.externalSessionId);
        if (existingSessionId) {
          ctx.setResult({ sessionId: existingSessionId, created: false });
          return;
        }
        const sessionId = crypto.randomUUID();
        sessionIdsByExternalSession.set(ctx.payload.externalSessionId, sessionId);
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

    // SessionStorageSubjects.updateImportStatus — capture status transitions
    cleanups.push(
      MakaioBus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
        importStatusUpdates.push({
          sessionId: ctx.payload.sessionId,
          importStatus: ctx.payload.importStatus,
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

    return {
      importUpserts,
      messageUpserts,
      importStatusUpdates,
      cursorSets,
      sessionUpdates,
      sessionEvents,
    };
  }

  it('persists each message payload via upsertByAdapterMessageId', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'adapter-instance-1',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { importUpserts, messageUpserts, importStatusUpdates, sessionUpdates } = registerStorageHandlers();

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

    // Session was upserted with correct metadata
    expect(importUpserts).toHaveLength(1);
    expect(importUpserts[0].externalSessionId).toBe(fixture.adapterSessionId);
    expect(importUpserts[0].source).toBe(ADAPTER_NAME);
    expect(importUpserts[0].logFilePath).toBe(fixture.sessionFilePath);

    // Status updated to 'imported' at the end
    expect(importStatusUpdates).toHaveLength(1);
    expect(importStatusUpdates[0].importStatus).toBe('imported');
    // The updateImportStatus handler (when mocked) does not set status='active'
    // — the real drizzle handler does. The session update capture verifies the
    // mock's response, which is success=true only.
    expect(sessionUpdates).toEqual([]);
  });

  it('performs zero message upserts when messagePayloads is empty', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'adapter-instance-2',
      adapterName: ADAPTER_NAME,
      includeMessages: false,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { messageUpserts, importStatusUpdates } = registerStorageHandlers();

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
    expect(importStatusUpdates).toHaveLength(1);
    expect(importStatusUpdates[0].importStatus).toBe('imported');
  });

  it('upserts session with correct metadata from sessionEvent', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-instance-1',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { importUpserts } = registerStorageHandlers();

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

    expect(importUpserts).toHaveLength(1);
    const upserted = importUpserts[0];
    expect(upserted.externalSessionId).toBe(fixture.adapterSessionId);
    expect(upserted.source).toBe(ADAPTER_NAME);
    expect(upserted.parentAdapterSessionId).toBeNull();
    expect(upserted.forkPointMessageId).toBeNull();
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

    // Cursor should be written for the absolute file path. bytesRead derives
    // from the parsed content snapshot — never from a later stat of the file.
    expect(cursorSets).toHaveLength(1);
    const cursor = cursorSets[0];
    expect(cursor.filePath).toBe(fixture.sessionFilePath);
    expect(cursor.bytesRead).toBe(Buffer.byteLength(fixture.sessionContent, 'utf8'));
    expect(cursor.lastModified).toBeTruthy();
    expect(new Date(cursor.lastModified).getTime()).toBeGreaterThan(0);
    expect(cursor.sessionContext).toBeDefined();
    expect(cursor.sessionContext?.adapterSessionId).toBe(fixture.adapterSessionId);
    expect(cursor.sessionContext?.sessionEvent).toBeDefined();
    expect(cursor.sessionContext?.startedEvent).toBeDefined();
    expect(cursor.sessionContext?.state).toBeDefined();
  });

  it('writes full-import cursor state after record processing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'import-cursor-state-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'cursor-state.jsonl');
    const content = '{"type":"session"}\n{"type":"message"}\n';
    await writeFile(filePath, content, 'utf8');

    const importer = createMockImporter({
      parseRecord: (line) => JSON.parse(String(line)),
      extractSessionContext: () => ({
        adapterSessionId: 'cursor-state-session',
        model: null,
        cwd: null,
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId: 'cursor-state-session',
            kind: 'root' as const,
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: null,
            cwd: null,
          },
        },
        startedEvent: { subject: {} as never, payload: {} },
        state: { phase: 'initial', recordCount: 0 },
      }),
      processRecords: (records, context): NormalizedEvent[] => {
        const state = context.state as { phase: string; recordCount: number };
        state.phase = 'processed';
        state.recordCount = records.length;
        return [];
      },
      processLogFile: () => ({
        adapterSessionId: 'cursor-state-session',
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId: 'cursor-state-session',
            kind: 'root' as const,
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: null,
            cwd: null,
          },
        },
        messageEvents: [],
        messagePayloads: [],
        lineage: { kind: 'root' as const, parentAdapterSessionId: null, forkPointMessageId: null },
      }),
    });
    const { cursorSets } = registerStorageHandlers();

    await importFromFileContent({
      bus: MakaioBus,
      importer,
      content,
      isJsonl: true,
      adapterName: ADAPTER_NAME,
      adapterId: 'cursor-state-adapter',
      sourceFilePath: filePath,
      persistedLogFilePath: filePath,
    });

    expect(cursorSets).toHaveLength(1);
    expect(cursorSets[0].sessionContext?.state).toEqual({ phase: 'processed', recordCount: 2 });
  });

  it('never advances the cursor past the parsed snapshot when the file grew during import', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-grow-test',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { cursorSets } = registerStorageHandlers();

    // Simulate the transcript growing between the caller's readFile snapshot
    // and the cursor write: the on-disk file carries extra unparsed bytes.
    await appendFile(fixture.sessionFilePath, '\n{"unparsed":"growth"}');

    await importFromFileContent({
      bus: MakaioBus,
      importer: fixture.importer,
      content: fixture.sessionContent,
      isJsonl: false,
      adapterName: ADAPTER_NAME,
      adapterId: 'opencode-grow-test',
      sourceFilePath: fixture.sessionFilePath,
      persistedLogFilePath: fixture.sessionFilePath,
    });

    expect(cursorSets).toHaveLength(1);
    const cursor = cursorSets[0];
    // bytesRead points at the end of the parsed snapshot, not the grown file.
    expect(cursor.bytesRead).toBe(Buffer.byteLength(fixture.sessionContent, 'utf8'));
    // The snapshot is stale relative to the file, so the epoch sentinel is
    // stored: it can never satisfy the orchestrator's mtime skip check.
    expect(cursor.lastModified).toBe(new Date(0).toISOString());
  });

  it('normalizes persisted relative log paths before upsert and cursor persistence', async () => {
    const fixture = await createOpenCodeFixtureSession({
      fixtureDir: OPENCODE_FIXTURE_DIR,
      adapterId: 'opencode-relative-path-test',
      adapterName: ADAPTER_NAME,
    });
    fixtureCleanups.push(fixture.cleanup);
    const { cursorSets, importUpserts } = registerStorageHandlers();
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

    expect(importUpserts).toHaveLength(1);
    expect(importUpserts[0].logFilePath).toBe(fixture.sessionFilePath);
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
    const { cursorSets, importUpserts } = registerStorageHandlers();

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
    expect(importUpserts).toHaveLength(1);
    // No logFilePath when persistedLogFilePath is omitted
    expect(importUpserts[0].logFilePath).toBeUndefined();
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
    const compactionPayload = (event: MakaioSessionEvent): { compressChildSessionId: string; summary: string } => {
      const payload = event.payload as Record<string, unknown>;
      expect(typeof payload['compressChildSessionId']).toBe('string');
      expect(typeof payload['summary']).toBe('string');
      return {
        compressChildSessionId: payload['compressChildSessionId'] as string,
        summary: payload['summary'] as string,
      };
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
    const firstCompactionPayload = compactionPayload(sessionEvents[0]);
    const nestedCompactionPayload = compactionPayload(sessionEvents[1]);
    expect(sessionEvents.map((event) => event.eventId)).toEqual([
      `session-compacted:${firstImport.sessionId}:${firstCompactionPayload.compressChildSessionId}`,
      `session-compacted:${firstCompactionPayload.compressChildSessionId}:${nestedCompactionPayload.compressChildSessionId}`,
    ]);
    expect(sessionEvents.map((event) => compactionPayload(event).summary)).toEqual([
      'First compaction summary',
      'Nested compaction summary',
    ]);
  });

  // This test validates the import pipeline's startedAt derivation and the
  // payload shape sent to the storage handler. End-to-end persistence through
  // the real drizzle handler is covered by drizzle-handler.upsert.test.ts
  // (explicit insert, write-once, backfill, and default-to-now scenarios).
  it('sets startedAt on the session importUpsert from the first message timestamp (Path B)', async () => {
    const STARTED_AT_MS = 1741449601000; // 2025-03-08T18:00:01.000Z
    const { importUpserts } = registerStorageHandlers();

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

    expect(importUpserts).toHaveLength(1);
    expect(importUpserts[0].startedAt).toBe(STARTED_AT_MS);
  });
});
