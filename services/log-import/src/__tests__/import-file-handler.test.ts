/**
 * Tests for the log-import.importFile handler against real in-memory storage.
 *
 * Covers the graceful-absence contract (no-importer / file-missing skips),
 * the happy path (session + turn + message rows, marker-stamped turn events),
 * marker propagation, and the per-file advisory mutex (concurrent requests
 * for the same path serialize and produce single-ingestion state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import {
  ImportCursorStorageSubjects,
  type LogImporter,
  type ProcessLogFileResult,
  type StorageMessagePayload,
} from '@makaio/ai-adapters-core';
import {
  MessageStorageSubjects,
  SessionStorageSubjects,
  TurnStorageSubjects,
  registerMemoryMessageStorage,
  registerMemorySessionEventStorage,
  registerMemorySessionStorage,
  registerMemoryTurnStorage,
} from '@makaio/services-core/session';
import { LogImportSubjects } from '../namespace.js';
import { registerImportFileHandler } from '../import-file-handler.js';
import type { LogImporterRegistration } from '../types.js';
import { createMockImporter } from './test-helpers.js';

const ADAPTER_NAME = 'test-file-adapter';

/** Line format of the fixture's temp JSONL transcripts. */
interface TestRecord {
  adapterMessageId: string;
  role: 'user' | 'assistant';
  contentText: string;
  timestamp: number;
}

/** Optional instrumentation hooks for the fixture importer. */
interface FixtureInstrumentation {
  /** Called when a parse (processLogFile) begins. */
  onParseStart?: () => void;
  /** Called when the import's trailing cursor extraction runs (persistence done). */
  onExtractSessionContext?: () => void;
}

/**
 * Build a minimal in-test LogImporter that parses the temp JSONL format and
 * reconstructs a single turn spanning all records (anchored at the first
 * user record).
 * @param adapterSessionId - Adapter session ID the fixture reports
 * @param instrumentation - Optional concurrency instrumentation hooks
 * @returns LogImporter fixture
 */
function createFixtureImporter(
  adapterSessionId: string,
  instrumentation: FixtureInstrumentation = {},
): LogImporter<unknown, unknown> {
  return createMockImporter({
    parseRecord: (line) => {
      const parsed: unknown = typeof line === 'string' ? JSON.parse(line) : line;
      return parsed;
    },
    processLogFile: (rawRecords): ProcessLogFileResult => {
      instrumentation.onParseStart?.();
      const records = rawRecords as TestRecord[];
      const messagePayloads: StorageMessagePayload[] = records.map((record) => ({
        adapterMessageId: record.adapterMessageId,
        role: record.role,
        contentText: record.contentText,
        blocks: [{ type: 'text', content: record.contentText }],
        agentId: 'main',
        adapterSessionId,
        timestamp: record.timestamp,
      }));
      const anchor = records.find((record) => record.role === 'user') ?? records[0];
      return {
        adapterSessionId,
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId,
            kind: 'root',
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: null,
            cwd: null,
          },
        },
        messageEvents: [],
        messagePayloads,
        lineage: { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null },
        turns: [
          {
            turnAnchorId: anchor.adapterMessageId,
            adapterMessageIds: records.map((record) => record.adapterMessageId),
            startedAt: records[0].timestamp,
            completedAt: records[records.length - 1].timestamp,
          },
        ],
      };
    },
    extractSessionContext: (records) => {
      instrumentation.onExtractSessionContext?.();
      return {
        adapterSessionId,
        model: null,
        cwd: null,
        sessionEvent: { subject: {} as never, payload: {} },
        startedEvent: { subject: {} as never, payload: {} },
        state: { recordCount: records.length },
      };
    },
  });
}

/**
 * Build a registration entry wrapping the fixture importer.
 * @param importer - Fixture importer instance
 * @returns Registration for the getRegistration closure
 */
function buildRegistration(importer: LogImporter<unknown, unknown>): LogImporterRegistration {
  return {
    id: 'test-file-adapter-1',
    adapterName: ADAPTER_NAME,
    displayName: 'Test File Adapter',
    source: 'adapter',
    importer,
    logFilePattern: '**/*.jsonl',
  };
}

/**
 * Write a two-message transcript (user + assistant) as a temp JSONL file.
 * @param dir - Directory to write into
 * @param name - File name
 * @param prefix - adapterMessageId prefix for uniqueness across tests
 * @returns Absolute file path
 */
async function writeTranscript(dir: string, name: string, prefix: string): Promise<string> {
  const records: TestRecord[] = [
    { adapterMessageId: `${prefix}-u1`, role: 'user', contentText: 'hello', timestamp: 1_000 },
    { adapterMessageId: `${prefix}-a1`, role: 'assistant', contentText: 'hi there', timestamp: 2_000 },
  ];
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
  return filePath;
}

describe('registerImportFileHandler', () => {
  const cleanups: Array<() => void> = [];
  let tempDir: string;
  let registrations: Map<string, LogImporterRegistration>;
  let capturedMarkers: Array<{ type: 'started' | 'completed'; ingestionMarker: string | undefined }>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-file-handler-'));
    registrations = new Map();
    capturedMarkers = [];

    cleanups.push(
      registerMemorySessionStorage(MakaioBus),
      registerMemoryTurnStorage(MakaioBus),
      registerMemoryMessageStorage(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
      registerImportFileHandler(MakaioBus, (adapterName) => registrations.get(adapterName)),
      // Cursor persistence stub: importFile writes a resume cursor after full imports.
      MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(SessionSubjects.turn.started, (ctx) => {
        capturedMarkers.push({ type: 'started', ingestionMarker: ctx.payload.ingestionMarker });
      }),
      MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
        capturedMarkers.push({ type: 'completed', ingestionMarker: ctx.payload.ingestionMarker });
      }),
    );
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns a skipped result instead of throwing when no importer is registered', async () => {
    const result = await MakaioBus.request(LogImportSubjects.importFile, {
      filePath: path.join(tempDir, 'whatever.jsonl'),
      adapterName: 'unregistered-adapter',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no-importer' });
  });

  it('returns a skipped result when the file does not exist', async () => {
    registrations.set(ADAPTER_NAME, buildRegistration(createFixtureImporter('session-missing-file')));

    const result = await MakaioBus.request(LogImportSubjects.importFile, {
      filePath: path.join(tempDir, 'does-not-exist.jsonl'),
      adapterName: ADAPTER_NAME,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'file-missing' });
  });

  it('imports a transcript: session, turn, and message rows exist; events carry marker live', async () => {
    const adapterSessionId = 'session-happy-path';
    registrations.set(ADAPTER_NAME, buildRegistration(createFixtureImporter(adapterSessionId)));
    const filePath = await writeTranscript(tempDir, 'happy.jsonl', 'happy');

    const result = await MakaioBus.request(LogImportSubjects.importFile, {
      filePath,
      adapterName: ADAPTER_NAME,
    });

    if (result.status !== 'imported') {
      throw new Error(`Expected imported result, got ${result.status}`);
    }
    expect(result.messageCount).toBe(2);
    expect(result.turnCount).toBe(1);
    expect(result.sessionId).toBeDefined();

    // Session row exists with the adapter identity
    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: result.sessionId });
    expect(session?.adapterSessionId).toBe(adapterSessionId);
    expect(session?.source).toBe(ADAPTER_NAME);

    // Turn row exists and its messages are queryable with real turnId links
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('completed');
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: turns[0].turnId });
    expect(messages.map((m) => m.adapterMessageId)).toEqual(['happy-u1', 'happy-a1']);

    // Default marker for importFile is 'live' (hook-triggered ingestion)
    expect(capturedMarkers.map((e) => e.type)).toEqual(['started', 'completed']);
    expect(capturedMarkers.every((e) => e.ingestionMarker === 'live')).toBe(true);
  });

  it('propagates an explicit backfill marker to the emitted turn events', async () => {
    registrations.set(ADAPTER_NAME, buildRegistration(createFixtureImporter('session-backfill')));
    const filePath = await writeTranscript(tempDir, 'backfill.jsonl', 'backfill');

    const result = await MakaioBus.request(LogImportSubjects.importFile, {
      filePath,
      adapterName: ADAPTER_NAME,
      ingestionMarker: 'backfill',
    });

    expect(result.status).toBe('imported');
    expect(capturedMarkers.length).toBeGreaterThan(0);
    expect(capturedMarkers.every((e) => e.ingestionMarker === 'backfill')).toBe(true);
  });

  it('serializes concurrent imports of the same file and ingests exactly once', async () => {
    const adapterSessionId = 'session-mutex';
    let active = 0;
    let maxActive = 0;
    const importer = createFixtureImporter(adapterSessionId, {
      onParseStart: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      },
      // extractSessionContext runs for the trailing cursor write, after all
      // persistence for the import completed — the end of the critical section.
      onExtractSessionContext: () => {
        active -= 1;
      },
    });
    registrations.set(ADAPTER_NAME, buildRegistration(importer));
    const filePath = await writeTranscript(tempDir, 'mutex.jsonl', 'mutex');

    const [first, second] = await Promise.all([
      MakaioBus.request(LogImportSubjects.importFile, { filePath, adapterName: ADAPTER_NAME }),
      MakaioBus.request(LogImportSubjects.importFile, { filePath, adapterName: ADAPTER_NAME }),
    ]);

    // The advisory mutex serialized the two executions
    expect(maxActive).toBe(1);

    // Both calls report the same session; only the first created the turn
    if (first.status !== 'imported' || second.status !== 'imported') {
      throw new Error(`Expected imported results, got ${first.status} and ${second.status}`);
    }
    expect(first.sessionId).toBe(second.sessionId);
    expect([first.turnCount, second.turnCount].sort()).toEqual([0, 1]);

    // Single-ingestion state: one turn row set, one event set
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: first.sessionId });
    expect(turns).toHaveLength(1);
    expect(capturedMarkers.map((e) => e.type)).toEqual(['started', 'completed']);
  });
});
