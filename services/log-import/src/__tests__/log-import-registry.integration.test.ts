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
import { MessageStorageSubjects, SessionStorageSubjects } from '@makaio/services-core/session';
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

/** Payload shape captured from SessionStorageSubjects.importUpsert bus calls. */
type CapturedImportUpsert = Record<string, unknown>;

/** Payload shape captured from SessionStorageSubjects.updateImportStatus bus calls. */
interface CapturedImportStatus {
  sessionId: string;
  importStatus: string;
}

/** Payload shape captured from SessionStorageSubjects.importUpsert during scan. */
interface CapturedScanUpsert {
  externalSessionId: string;
  source: string | undefined;
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
 * @param sessionForGetByAdapterSessionId - Pre-seeded session returned by getByAdapterSessionId (null = not found)
 */
function registerStorageInterceptors(
  cleanups: Array<() => void>,
  sessionForGetByAdapterSessionId: {
    sessionId: string;
    adapterSessionId: string;
    source: string;
    logFilePath: string | undefined;
    importStatus: 'discovered' | 'imported' | 'tracking' | undefined;
  } | null = null,
): {
  importUpserts: CapturedImportUpsert[];
  messageUpserts: CapturedMessageUpsert[];
  importStatusUpdates: CapturedImportStatus[];
  importUpsertSessionIds: Array<{ sessionId: string }>;
} {
  const importUpserts: CapturedImportUpsert[] = [];
  const messageUpserts: CapturedMessageUpsert[] = [];
  const importStatusUpdates: CapturedImportStatus[] = [];
  const importUpsertSessionIds: Array<{ sessionId: string }> = [];
  const sessionIdsByImportKey = new Map<string, string>();

  // Session.getByAdapterSessionId — return the seeded session (or null)
  cleanups.push(
    MakaioBus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
      if (
        sessionForGetByAdapterSessionId &&
        ctx.payload.adapterSessionId === sessionForGetByAdapterSessionId.adapterSessionId &&
        ctx.payload.source === sessionForGetByAdapterSessionId.source
      ) {
        ctx.setResult({
          session: {
            sessionId: sessionForGetByAdapterSessionId.sessionId,
            adapterSessionId: sessionForGetByAdapterSessionId.adapterSessionId,
            source: sessionForGetByAdapterSessionId.source,
            logFilePath: sessionForGetByAdapterSessionId.logFilePath ?? undefined,
            importStatus: sessionForGetByAdapterSessionId.importStatus ?? undefined,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            status: 'discovered',
            agents: [],
          },
        });
      } else {
        ctx.setResult({ session: null });
      }
    }),
  );

  // Session.importUpsert — create or enrich an imported session record
  cleanups.push(
    MakaioBus.on(SessionStorageSubjects.importUpsert, (ctx) => {
      importUpserts.push({ ...ctx.payload });
      const importKey = `${ctx.payload.source}\0${ctx.payload.externalSessionId}`;
      const existingSessionId = sessionIdsByImportKey.get(importKey);
      if (existingSessionId) {
        ctx.setResult({ sessionId: existingSessionId, created: false });
        return;
      }
      const sessionId = crypto.randomUUID();
      sessionIdsByImportKey.set(importKey, sessionId);
      importUpsertSessionIds.push({ sessionId });
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

  // Session.updateImportStatus — capture status transitions
  cleanups.push(
    MakaioBus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
      importStatusUpdates.push({
        sessionId: ctx.payload.sessionId,
        importStatus: ctx.payload.importStatus,
      });
      ctx.setResult({ success: true });
    }),
  );

  return { importUpserts, messageUpserts, importStatusUpdates, importUpsertSessionIds };
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

      const { messageUpserts, importUpserts, importStatusUpdates } = registerStorageInterceptors(cleanups);

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

      // Session upserted with correct metadata
      expect(importUpserts).toHaveLength(1);
      expect(importUpserts[0].externalSessionId).toBe(fixture.adapterSessionId);
      expect(importUpserts[0].source).toBe(ADAPTER_NAME);
      // Upload path does not pass logFilePath (no persistent file path)
      expect(importUpserts[0].logFilePath).toBeUndefined();

      // Status transitioned to imported
      expect(importStatusUpdates).toHaveLength(1);
      expect(importStatusUpdates[0].importStatus).toBe('imported');
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

    it('keeps uploaded sessions distinct when different sources share an external ID', async () => {
      const createSharedIdImporter = (adapterName: string) =>
        createMockImporter({
          parseRecord: () => ({ ok: true }),
          processLogFile: () => ({
            adapterSessionId: 'shared-upload-external-id',
            sessionEvent: {
              subject: {} as never,
              payload: {
                adapterSessionId: 'shared-upload-external-id',
                kind: 'root',
                parentAdapterSessionId: null,
                forkPointMessageId: null,
                model: null,
                cwd: '/repo',
              },
            },
            messageEvents: [],
            messagePayloads: [],
            lineage: {
              kind: 'root' as const,
              parentAdapterSessionId: null,
              forkPointMessageId: null,
            },
          }),
          extractSessionContext: () => ({
            adapterSessionId: 'shared-upload-external-id',
            model: null,
            cwd: '/repo',
            sessionEvent: { subject: {} as never, payload: {} },
            startedEvent: { subject: {} as never, payload: {} },
            state: { adapterName },
          }),
        });

      await registry.register({
        id: 'shared-upload-a',
        adapterName: 'shared-upload-source-a',
        displayName: 'Shared Upload A',
        source: 'adapter',
        importer: createSharedIdImporter('shared-upload-source-a'),
        logFilePattern: '*.json',
      });
      await registry.register({
        id: 'shared-upload-b',
        adapterName: 'shared-upload-source-b',
        displayName: 'Shared Upload B',
        source: 'adapter',
        importer: createSharedIdImporter('shared-upload-source-b'),
        logFilePattern: '*.json',
      });

      const { importUpserts, importUpsertSessionIds } = registerStorageInterceptors(cleanups);
      const contentBase64 = Buffer.from('{"ok":true}').toString('base64');

      const first = await MakaioBus.request(LogImportSubjects.uploadFiles, {
        adapterName: 'shared-upload-source-a',
        files: [{ filename: 'shared-a.json', contentBase64 }],
      });
      const second = await MakaioBus.request(LogImportSubjects.uploadFiles, {
        adapterName: 'shared-upload-source-b',
        files: [{ filename: 'shared-b.json', contentBase64 }],
      });

      expect(first.sessionsImported).toBe(1);
      expect(second.sessionsImported).toBe(1);
      expect(importUpserts).toMatchObject([
        { externalSessionId: 'shared-upload-external-id', source: 'shared-upload-source-a' },
        { externalSessionId: 'shared-upload-external-id', source: 'shared-upload-source-b' },
      ]);
      expect(importUpsertSessionIds).toHaveLength(2);
      expect(importUpsertSessionIds[0].sessionId).not.toBe(importUpsertSessionIds[1].sessionId);
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

      // Seed the session with logFilePath so the handler can read the file
      const seededSession = {
        sessionId: crypto.randomUUID(),
        adapterSessionId: fixture.adapterSessionId,
        source: ADAPTER_NAME,
        logFilePath: fixture.sessionFilePath,
        importStatus: 'discovered' as const,
      };

      const { messageUpserts, importStatusUpdates, importUpsertSessionIds } = registerStorageInterceptors(
        cleanups,
        seededSession,
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

      // Makaio session was created via importUpsert
      expect(importUpsertSessionIds).toHaveLength(1);
      expect(importUpsertSessionIds[0].sessionId).toBeTruthy();
      expect(importUpsertSessionIds[0].sessionId).not.toBe(fixture.adapterSessionId);

      // Import status transitioned to 'imported'
      expect(importStatusUpdates.some((s) => s.importStatus === 'imported')).toBe(true);
    });

    it('throws when session is not found by external ID', async () => {
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

      // Register getByAdapterSessionId handler that always returns null
      cleanups.push(
        MakaioBus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
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

    it('throws when the session has no logFilePath', async () => {
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

      // Seed with logFilePath absent (session has no log file path)
      const seededSession = {
        sessionId: crypto.randomUUID(),
        adapterSessionId,
        source: ADAPTER_NAME,
        logFilePath: undefined,
        importStatus: 'discovered' as const,
      };

      cleanups.push(
        MakaioBus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          if (ctx.payload.adapterSessionId === adapterSessionId) {
            ctx.setResult({
              session: {
                sessionId: seededSession.sessionId,
                adapterSessionId,
                source: ADAPTER_NAME,
                importStatus: 'discovered',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                status: 'discovered',
                agents: [],
              },
            });
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

    it('throws when the session belongs to another adapter source', async () => {
      const adapterSessionId = 'wrong-source-session';

      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'wrong-source-adapter',
        adapterName: ADAPTER_NAME,
      });
      fixtureCleanups.push(fixture.cleanup);
      await registry.register({
        id: 'wrong-source-adapter',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '*.json',
      });

      cleanups.push(
        MakaioBus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          if (ctx.payload.adapterSessionId === adapterSessionId) {
            ctx.setResult({
              session: {
                sessionId: crypto.randomUUID(),
                adapterSessionId,
                source: 'other-adapter',
                logFilePath: fixture.sessionFilePath,
                importStatus: 'discovered',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                status: 'discovered',
                agents: [],
              },
            });
            return;
          }
          ctx.setResult({ session: null });
        }),
      );

      await expect(
        MakaioBus.request(LogImportSubjects.importSession, {
          adapterSessionId,
          adapterName: ADAPTER_NAME,
        }),
      ).rejects.toThrow(`belongs to adapter 'other-adapter', not '${ADAPTER_NAME}'`);
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

      // Only wire Session.importUpsert for scan (no message upsert handler)
      cleanups.push(
        MakaioBus.on(SessionStorageSubjects.importUpsert, (ctx) => {
          scanUpserts.push({
            externalSessionId: ctx.payload.externalSessionId,
            source: ctx.payload.source,
            startedAt: 'startedAt' in ctx.payload ? (ctx.payload.startedAt as number | undefined) : undefined,
          });
          ctx.setResult({ sessionId: crypto.randomUUID(), created: true });
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

      // Session upserted with correct adapter name
      expect(scanUpserts).toHaveLength(1);
      expect(scanUpserts[0].externalSessionId).toBe(fixture.adapterSessionId);
      expect(scanUpserts[0].source).toBe(ADAPTER_NAME);
      expect(scanUpserts[0].startedAt).toBe(1768498516323);

      // No messages were persisted during scan
      expect(messageUpserts).toHaveLength(0);
    });

    it('stamps machineId from registration on scan importUpsert payloads', async () => {
      const fixture = await createOpenCodeFixtureSession({
        fixtureDir: OPENCODE_FIXTURE_DIR,
        adapterId: 'scan-machineid-adapter',
        adapterName: ADAPTER_NAME,
        logDirectory: 'scanRoot',
      });
      fixtureCleanups.push(fixture.cleanup);

      await registry.register({
        id: 'scan-machineid-adapter',
        adapterName: ADAPTER_NAME,
        displayName: 'OpenCode',
        source: 'adapter',
        importer: fixture.importer,
        logFilePattern: '**/storage/session/*/*.json',
        machineId: 'remote-owner-machine',
      });

      const scanUpserts: Array<Record<string, unknown>> = [];

      cleanups.push(
        MakaioBus.on(SessionStorageSubjects.importUpsert, (ctx) => {
          scanUpserts.push({ ...ctx.payload });
          ctx.setResult({ sessionId: crypto.randomUUID(), created: true });
        }),
      );

      await MakaioBus.request(LogImportSubjects.scan, { adapterName: ADAPTER_NAME });

      expect(scanUpserts).toHaveLength(1);
      // machineId must come from the registration, not from any central-server identity
      expect(scanUpserts[0].machineId).toBe('remote-owner-machine');
    });
  });
});
