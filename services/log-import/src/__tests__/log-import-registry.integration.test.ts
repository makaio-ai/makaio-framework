/**
 * Integration tests for log-import registry bus subject handlers.
 *
 * Tests the full request-handler pipeline above `importFromFileContent`:
 * - `LogImportSubjects.uploadFiles` — file upload path via registry
 * - `LogImportSubjects.importSession` — lazy-load pick-up for discovered sessions
 * - `LogImportSubjects.scan` — discovery-only, no message persistence
 *
 * Storage handlers are intercepted with in-memory captures to assert what
 * gets persisted without requiring a real database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { getOpenCodeFixtureDir } from '@makaio/extension-opencode/testing';
import { LogImportSubjects } from '../namespace.js';
import {
  AdapterSessionStorageSubjects,
  MessageStorageSubjects,
  SessionStorageSubjects,
} from '@makaio/services-core/session';
import { LogImportRegistry } from '../log-import-registry.js';
import type { LogImporterRegistration } from '../types.js';
import { createMockImporter } from './test-helpers.js';
import { createOpenCodeFixtureSession } from './opencode-test-helpers.js';

const ADAPTER_NAME = 'plugin:opencode';
const OPENCODE_FIXTURE_DIR = getOpenCodeFixtureDir();

// ---------------------------------------------------------------------------
// Shared test builder helpers
// ---------------------------------------------------------------------------

/** Payload shape captured from upsertByAdapterMessageId bus calls. */
interface CapturedMessageUpsert {
  sessionId: string;
  adapterMessageId: string;
  role: string;
  contentText: string;
  blocks: unknown[];
}

/** Payload shape captured from AdapterSessionStorageSubjects.upsert bus calls. */
type CapturedAdapterSessionUpsert = Record<string, unknown>;

/** Payload shape captured from AdapterSessionStorageSubjects.updateStatus bus calls. */
interface CapturedAdapterSessionStatus {
  adapterSessionId: string;
  status: string;
}

/** Payload shape captured from AdapterSessionStorageSubjects.upsert during scan. */
interface CapturedScanUpsert {
  adapterSessionId: string;
  adapterName: string;
  startedAt?: number;
}

// ---------------------------------------------------------------------------
// Shared in-memory storage interceptor
// ---------------------------------------------------------------------------

/**
 * Registers the minimal set of in-memory bus handlers that the import pipeline
 * depends on. Returns captured call payloads for assertions.
 *
 * Every handler is pushed into `cleanups` so tests can unsubscribe in afterEach.
 * @param cleanups - Array to push cleanup functions into
 * @param adapterSessionForGet - Pre-seeded adapter session returned by .get (null = not found)
 */
function registerStorageInterceptors(
  cleanups: Array<() => void>,
  adapterSessionForGet: {
    adapterSessionId: string;
    adapterName: string;
    parentAdapterSessionId: string | null;
    forkPointMessageId: string | null;
    sessionId: string | null;
    model: string | null;
    cwd: string | null;
    logFilePath: string | null;
    discoveredAt: number;
    startedAt: number;
    status: 'discovered' | 'imported' | 'live' | 'tracking';
    kind: 'root' | 'fork' | 'subagent';
  } | null = null,
): {
  adapterSessionUpserts: CapturedAdapterSessionUpsert[];
  messageUpserts: CapturedMessageUpsert[];
  adapterSessionStatuses: CapturedAdapterSessionStatus[];
  createAndLinkCalls: Array<{ sessionId: string }>;
} {
  const adapterSessionUpserts: CapturedAdapterSessionUpsert[] = [];
  const messageUpserts: CapturedMessageUpsert[] = [];
  const adapterSessionStatuses: CapturedAdapterSessionStatus[] = [];
  const createAndLinkCalls: Array<{ sessionId: string }> = [];

  // AdapterSession.get — return the seeded session (or null)
  cleanups.push(
    MakaioBus.on(AdapterSessionStorageSubjects.get, (ctx) => {
      if (adapterSessionForGet && ctx.payload.adapterSessionId === adapterSessionForGet.adapterSessionId) {
        ctx.setResult({ session: adapterSessionForGet });
      } else {
        ctx.setResult({ session: null });
      }
    }),
  );

  // AdapterSession.upsert — capture the payload and return created=true
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

  // AdapterSession.createAndLink — create and link a Makaio session, capture sessionId
  cleanups.push(
    MakaioBus.on(AdapterSessionStorageSubjects.createAndLink, (ctx) => {
      const sessionId = crypto.randomUUID();
      createAndLinkCalls.push({ sessionId });
      ctx.setResult({ sessionId, created: true });
    }),
  );

  // Session.update — accept status transitions (imported → active)
  cleanups.push(
    MakaioBus.on(SessionStorageSubjects.update, (ctx) => {
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

  return { adapterSessionUpserts, messageUpserts, adapterSessionStatuses, createAndLinkCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('log-import registry (integration)', () => {
  let registry: LogImportRegistry;
  const cleanups: Array<() => void> = [];
  const fixtureCleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    registry = new LogImportRegistry({ bus: MakaioBus });
    await registry.init();
  });

  afterEach(async () => {
    await registry.destroy();

    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }

    while (fixtureCleanups.length > 0) {
      await fixtureCleanups.pop()?.();
    }
  });

  // -------------------------------------------------------------------------
  // uploadFiles path
  // -------------------------------------------------------------------------

  describe('LogImportSubjects.uploadFiles', () => {
    it('stores message payloads when valid files are uploaded', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'upload-adapter-1',
        adapterName: ADAPTER_NAME,
      });
      fixtureCleanups.push(fixture.cleanup);

      const registration: LogImporterRegistration = {
        id: 'upload-adapter-1',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '*.json',
      };

      await registry.register(registration);

      const { messageUpserts, adapterSessionUpserts, adapterSessionStatuses } = registerStorageInterceptors(cleanups);

      const contentBase64 = Buffer.from(fixture.sessionContent).toString('base64');

      const result = await MakaioBus.request(LogImportSubjects.uploadFiles, {
        adapterName: ADAPTER_NAME,
        files: [{ filename: fixture.sessionFilePath, contentBase64 }],
      });

      // Handler response
      expect(result.adapterName).toBe(ADAPTER_NAME);
      expect(result.filesProcessed).toBe(1);
      expect(result.sessionsImported).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Two messages were written
      expect(messageUpserts).toHaveLength(2);

      // Content assertions
      expect(messageUpserts[0].adapterMessageId).toBe('msg_bb815fae3001NfwSfS3QMC3yzU');
      expect(messageUpserts[0].role).toBe('user');
      expect(messageUpserts[0].contentText).toBe('Install the opencode-antigravity-auth plugin');
      expect(messageUpserts[0].blocks).toHaveLength(1);

      expect(messageUpserts[1].adapterMessageId).toBe('msg_bbc7965ee0013MiAht130lgpXk');
      expect(messageUpserts[1].role).toBe('assistant');
      expect(messageUpserts[1].contentText).toContain("I'll help you install");

      // All messages share the same sessionId
      const uniqueSessionIds = new Set(messageUpserts.map((m) => m.sessionId));
      expect(uniqueSessionIds.size).toBe(1);

      // Adapter session upserted with correct metadata
      expect(adapterSessionUpserts).toHaveLength(1);
      expect(adapterSessionUpserts[0].adapterSessionId).toBe(fixture.adapterSessionId);
      expect(adapterSessionUpserts[0].adapterName).toBe(ADAPTER_NAME);
      expect(adapterSessionUpserts[0].logFilePath).toBeUndefined();

      // Status transitioned to imported
      expect(adapterSessionStatuses).toHaveLength(1);
      expect(adapterSessionStatuses[0].adapterSessionId).toBe(fixture.adapterSessionId);
      expect(adapterSessionStatuses[0].status).toBe('imported');
    });

    it('reports an error when no importer is registered for the adapter', async () => {
      // No registration — registry has no importer for 'unknown-adapter'
      const { messageUpserts } = registerStorageInterceptors(cleanups);

      const fileContent = '{"type":"message"}\n';
      const contentBase64 = Buffer.from(fileContent).toString('base64');

      const result = await MakaioBus.request(LogImportSubjects.uploadFiles, {
        adapterName: 'unknown-adapter',
        files: [{ filename: 'session.jsonl', contentBase64 }],
      });

      expect(result.sessionsImported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('session.jsonl');
      expect(result.errors[0].error).toContain('No importer registered');

      // No messages written
      expect(messageUpserts).toHaveLength(0);
    });

    it('reports a per-file error when parsing yields no records', async () => {
      const importer = createMockImporter({
        parseRecord: () => null,
      });

      await registry.register({
        id: 'empty-importer',
        adapterName: 'empty-adapter',
        displayName: 'Empty Adapter',
        source: 'adapter',
        importer,
        logFilePattern: '*.json',
      });

      registerStorageInterceptors(cleanups);

      const contentBase64 = Buffer.from('bad content').toString('base64');

      const result = await MakaioBus.request(LogImportSubjects.uploadFiles, {
        adapterName: 'empty-adapter',
        files: [{ filename: 'bad.json', contentBase64 }],
      });

      expect(result.sessionsImported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('bad.json');
      expect(result.errors[0].error).toBe('No valid records found');
    });
  });

  // -------------------------------------------------------------------------
  // importSession path
  // -------------------------------------------------------------------------

  describe('LogImportSubjects.importSession', () => {
    it('imports messages from the log file and activates the session', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'lazy-adapter-1',
        adapterName: ADAPTER_NAME,
      });
      fixtureCleanups.push(fixture.cleanup);

      await registry.register({
        id: 'lazy-adapter-1',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '*.json',
      });

      // Seed the adapter session with logFilePath so the handler can read the file
      const seededAdapterSessionNow = Date.now();
      const seededAdapterSession = {
        adapterSessionId: fixture.adapterSessionId,
        adapterName: ADAPTER_NAME,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        sessionId: null,
        model: null,
        cwd: '/home/user/source-workspace/terminal',
        logFilePath: fixture.sessionFilePath,
        kind: 'root' as const,
        discoveredAt: seededAdapterSessionNow,
        startedAt: seededAdapterSessionNow,
        status: 'discovered' as const,
      };

      const { messageUpserts, adapterSessionStatuses, createAndLinkCalls } = registerStorageInterceptors(
        cleanups,
        seededAdapterSession,
      );

      const result = await MakaioBus.request(LogImportSubjects.importSession, {
        adapterSessionId: fixture.adapterSessionId,
        adapterName: ADAPTER_NAME,
      });

      // Handler response — a fresh UUID is generated for the Makaio session,
      // so it must not equal the adapter session ID (e.g. "ses_...").
      expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(result.sessionId).not.toBe(fixture.adapterSessionId);
      expect(result.messageCount).toBe(2);

      // Messages were written
      expect(messageUpserts).toHaveLength(2);
      expect(messageUpserts[0].contentText).toBe('Install the opencode-antigravity-auth plugin');
      expect(messageUpserts[1].contentText).toContain("I'll help you install");

      // Makaio session was created and linked with a UUID session ID
      expect(createAndLinkCalls).toHaveLength(1);
      expect(createAndLinkCalls[0].sessionId).toBeTruthy();
      expect(createAndLinkCalls[0].sessionId).not.toBe(fixture.adapterSessionId);

      // Adapter session status transitioned to 'imported'
      expect(adapterSessionStatuses.some((s) => s.status === 'imported')).toBe(true);
    });

    it('throws when adapter session is not found', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'import-adapter-2',
        adapterName: ADAPTER_NAME,
      });
      fixtureCleanups.push(fixture.cleanup);
      await registry.register({
        id: 'import-adapter-2',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '*.json',
      });

      // Register get handler that always returns null
      cleanups.push(
        MakaioBus.on(AdapterSessionStorageSubjects.get, (ctx) => {
          ctx.setResult({ session: null });
        }),
      );

      await expect(
        MakaioBus.request(LogImportSubjects.importSession, {
          adapterSessionId: 'nonexistent-session',
          adapterName: ADAPTER_NAME,
        }),
      ).rejects.toThrow();
    });

    it('throws when the adapter session has no logFilePath', async () => {
      const adapterSessionId = 'no-path-session';

      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'no-path-adapter',
        adapterName: ADAPTER_NAME,
      });
      fixtureCleanups.push(fixture.cleanup);
      await registry.register({
        id: 'no-path-adapter',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '*.json',
      });

      // Seed with logFilePath: null
      const now = Date.now();
      const seededSession = {
        adapterSessionId,
        adapterName: ADAPTER_NAME,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        sessionId: null,
        model: null,
        cwd: null,
        logFilePath: null,
        kind: 'root' as const,
        discoveredAt: now,
        startedAt: now,
        status: 'discovered' as const,
      };

      cleanups.push(
        MakaioBus.on(AdapterSessionStorageSubjects.get, (ctx) => {
          if (ctx.payload.adapterSessionId === adapterSessionId) {
            ctx.setResult({ session: seededSession });
          } else {
            ctx.setResult({ session: null });
          }
        }),
      );

      await expect(
        MakaioBus.request(LogImportSubjects.importSession, {
          adapterSessionId,
          adapterName: ADAPTER_NAME,
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // scan path — discovery only, no message persistence
  // -------------------------------------------------------------------------

  describe('LogImportSubjects.scan', () => {
    it('loads message payloads when the storageRoot alias is used as the custom log directory', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'scan-adapter-process',
        adapterName: ADAPTER_NAME,
        logDirectory: 'storageRoot',
      });
      fixtureCleanups.push(fixture.cleanup);

      const record = fixture.importer.parseRecord(fixture.sessionContent);
      expect(record).not.toBeNull();

      const result = fixture.importer.processLogFile(record!);

      expect(result.messagePayloads).toHaveLength(2);
      expect(result.messagePayloads.map((payload) => payload.role)).toEqual(['user', 'assistant']);
    });

    it('discovers sessions without persisting messages', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'scan-adapter-1',
        adapterName: ADAPTER_NAME,
        logDirectory: 'scanRoot',
      });
      fixtureCleanups.push(fixture.cleanup);

      await registry.register({
        id: 'scan-adapter-1',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '**/storage/session/*/*.json',
      });

      const scanUpserts: CapturedScanUpsert[] = [];
      const messageUpserts: CapturedMessageUpsert[] = [];

      // Only wire AdapterSession.upsert for scan (no message upsert handler)
      cleanups.push(
        MakaioBus.on(AdapterSessionStorageSubjects.upsert, (ctx) => {
          scanUpserts.push({
            adapterSessionId: ctx.payload.adapterSessionId,
            adapterName: ctx.payload.adapterName,
            startedAt: 'startedAt' in ctx.payload ? ctx.payload.startedAt : undefined,
          });
          ctx.setResult({
            adapterSessionId: ctx.payload.adapterSessionId,
            sessionId: null,
            created: true,
          });
        }),
      );

      // Message upsert should never be called during scan
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

      const result = await MakaioBus.request(LogImportSubjects.scan, {
        adapterName: ADAPTER_NAME,
      });

      // Discovery counts
      expect(result.adapterName).toBe(ADAPTER_NAME);
      expect(result.sessionsFound).toBe(1);
      expect(result.newSessions).toBe(1);

      // Adapter session upserted with correct adapter name
      expect(scanUpserts).toHaveLength(1);
      expect(scanUpserts[0].adapterSessionId).toBe(fixture.adapterSessionId);
      expect(scanUpserts[0].adapterName).toBe(ADAPTER_NAME);
      expect(scanUpserts[0].startedAt).toBe(1768498516323);

      // No messages were persisted during scan
      expect(messageUpserts).toHaveLength(0);
    });
  });
});
