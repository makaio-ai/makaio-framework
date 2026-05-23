import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionStorageSubjects, MakaioSessionSchema } from '@makaio/contracts';
import type { LogImporter, DiscoveryMetadata } from '../../log-importer/types.js';
import { DiscoveryOrchestrator } from '../../log-importer/discovery-orchestrator.js';
import { ImportCursorStorageSubjects } from '../../log-importer/cursor-storage.js';
import type { LogOrchestratorConfig, ParseFileResult } from '../../log-importer/base-orchestrator.js';

/** Data shape for a session record used in bus subject payloads. */
type SessionRecord = z.infer<typeof MakaioSessionSchema>;

interface TestRecord {
  id: string;
  content: string;
}

interface TestState {
  checkpoint: number;
}

const cleanups: Array<() => void | Promise<void>> = [];

function registerCleanup(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

function registerCursorGetHandler(params: {
  filePath?: string;
  bytesRead: number;
  lastModified: string;
  sessionContext: ReturnType<typeof createSessionContext>;
}): void {
  registerCleanup(
    MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
      if (params.filePath !== undefined) {
        expect(ctx.payload.filePath).toBe(params.filePath);
      }

      ctx.setResult({
        cursor: {
          filePath: ctx.payload.filePath,
          bytesRead: params.bytesRead,
          lastModified: params.lastModified,
          sessionContext: params.sessionContext,
        },
      });
    }),
  );
}

function registerCursorSetSuccessHandler(): void {
  registerCleanup(
    MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
      ctx.setResult({ success: true });
    }),
  );
}

function registerSessionLookupByLogFilePath(session: SessionRecord, filePath?: string): void {
  registerCleanup(
    MakaioBus.on(SessionStorageSubjects.getByLogFilePath, (ctx) => {
      if (filePath !== undefined) {
        expect(ctx.payload.logFilePath).toBe(filePath);
      }

      ctx.setResult({ session });
    }),
  );
}

function registerUpdateImportStatusHandler(
  statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }>,
  success = true,
): void {
  registerCleanup(
    MakaioBus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
      statusUpdates.push(ctx.payload);
      ctx.setResult({ success });
    }),
  );
}

async function withTempDir(prefix: string, run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    await run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createImportedSession(overrides: {
  adapterSessionId: string;
  importStatus: NonNullable<SessionRecord['importStatus']>;
  sessionId?: string;
  logFilePath?: string | null;
  source?: string;
}): SessionRecord {
  const now = Date.now();
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    adapterSessionId: overrides.adapterSessionId,
    createdAt: now,
    lastActivityAt: now,
    agents: [],
    status: 'discovered',
    isImported: true,
    importStatus: overrides.importStatus,
    logFilePath: overrides.logFilePath ?? undefined,
    source: overrides.source ?? 'claude-code',
  };
}

function createMockImporter(
  overrides?: Partial<LogImporter<TestRecord, TestState>>,
): LogImporter<TestRecord, TestState> {
  return {
    canHandle: () => true,
    getLogDirectory: () => '/tmp',
    parseRecord: (line) => {
      if (typeof line === 'string') {
        return JSON.parse(line) as TestRecord;
      }
      if (typeof line.id === 'string' && typeof line.content === 'string') {
        return { id: line.id, content: line.content };
      }
      return null;
    },
    isMakaioManaged: async () => false,
    extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => ({
      adapterSessionId: 'adapter-session-1',
      model: null,
      cwd: null,
      title: 'Test Session',
      hasMessages: true,
    }),
    extractSessionContext: () => ({
      adapterSessionId: 'adapter-session-1',
      model: null,
      cwd: null,
      sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
      startedEvent: { subject: AgentSubjects.started, payload: {} },
      state: { checkpoint: 0 },
    }),
    processRecords: () => [],
    serializeState: (state) => ({ checkpoint: state.checkpoint }),
    deserializeState: (raw) => ({ checkpoint: Number(raw['checkpoint'] ?? 0) }),
    processLogFile: () => ({
      adapterSessionId: 'adapter-session-1',
      sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
      messageEvents: [],
      messagePayloads: [],
      lineage: { kind: 'root' as const, parentAdapterSessionId: null, forkPointMessageId: null },
    }),
    ...overrides,
  };
}

function createSessionContext(
  overrides: Partial<{
    adapterSessionId: string;
    model: string | null;
    cwd: string | null;
    checkpoint: number;
  }> = {},
) {
  return {
    adapterSessionId: overrides.adapterSessionId ?? 'adapter-session-1',
    model: overrides.model ?? null,
    cwd: overrides.cwd ?? null,
    sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
    startedEvent: { subject: AgentSubjects.started, payload: {} },
    state: { checkpoint: overrides.checkpoint ?? 0 },
  };
}

class TestDiscoveryOrchestrator extends DiscoveryOrchestrator<TestRecord, TestState> {
  protected readonly logPrefix = '[TestDiscovery]';

  public constructor(config: LogOrchestratorConfig, importer: LogImporter<TestRecord, TestState>) {
    super(config, importer);
  }

  protected getLogFilePattern(): string {
    return '*.jsonl';
  }

  protected async parseFile(_filePath: string, startOffset: number): Promise<ParseFileResult<TestRecord>> {
    return {
      records: [{ id: `record-${startOffset}`, content: 'delta' }],
      bytesRead: startOffset + 1,
    };
  }

  public async handleChange(event: {
    filePath: string;
    changeType: 'created' | 'modified' | 'rotated';
    stat: { size: number; mtime: Date };
  }): Promise<void> {
    await this.handleFileChange(event);
  }

  public async idle(): Promise<void> {
    await this.eventQueue.drain();
  }

  public seedFromCursors(cursors: Array<{ filePath: string; bytesRead: number; lastModified: string }>): void {
    this.watcher.seedFromCursors(cursors);
  }

  public async restoreTrackingState(): Promise<void> {
    await this.restorePersistedTrackingState();
  }

  public async runPollCycle(trackedFilePaths: ReadonlySet<string>): Promise<void> {
    await this.onPollCycle(trackedFilePaths);
  }

  public isTrackingFile(filePath: string): boolean {
    return this.trackingFilePaths.has(filePath);
  }
}

class ThrowingDiscoveryOrchestrator extends TestDiscoveryOrchestrator {
  protected override async parseFile(_filePath: string, _startOffset: number): Promise<ParseFileResult<TestRecord>> {
    throw new Error('parse failed');
  }
}

class SkippingDiscoveryOrchestrator extends TestDiscoveryOrchestrator {
  protected override shouldSkipFile(filePath: string): boolean {
    return filePath.endsWith('.skip.jsonl');
  }
}

class CountingStartDiscoveryOrchestrator extends TestDiscoveryOrchestrator {
  public restoreCount = 0;

  protected override async restorePersistedTrackingState(): Promise<void> {
    this.restoreCount += 1;
    await super.restorePersistedTrackingState();
  }
}

describe('DiscoveryOrchestrator', () => {
  let originalInfo: typeof console.info;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalInfo = console.info;
    originalWarn = console.warn;
    console.info = vi.fn();
    console.warn = vi.fn();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    console.info = originalInfo;
    console.warn = originalWarn;
    vi.useRealTimers();
  });

  it('processes incremental reads for modified imported files before switching to tracking', async () => {
    const processRecords = vi.fn(() => []);
    const importer = createMockImporter({ processRecords });
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      importer,
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/imported-session.jsonl';
    const lastModified = new Date('2026-03-05T10:00:00.000Z');
    const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];

    registerCursorGetHandler({
      filePath,
      bytesRead: 10,
      lastModified: lastModified.toISOString(),
      sessionContext: createSessionContext(),
    });
    registerCursorSetSuccessHandler();
    registerSessionLookupByLogFilePath(
      createImportedSession({
        adapterSessionId: 'adapter-session-1',
        importStatus: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerUpdateImportStatusHandler(statusUpdates);

    await orchestrator.handleChange({
      filePath,
      changeType: 'modified',
      stat: { size: 128, mtime: new Date('2026-03-05T10:00:05.000Z') },
    });
    await orchestrator.idle();

    expect(processRecords).toHaveBeenCalledTimes(1);
    expect(statusUpdates).toEqual([{ sessionId: 'session-1', importStatus: 'tracking' }]);
  });

  it('preserves the base skip-file guard for discovery overrides', async () => {
    const extractDiscoveryMetadata = vi.fn(createMockImporter().extractDiscoveryMetadata);
    const orchestrator = new SkippingDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter({ extractDiscoveryMetadata }),
    );
    registerCleanup(() => orchestrator.dispose());

    const cursorReads: string[] = [];
    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
        cursorReads.push(ctx.payload.filePath);
        ctx.setResult({ cursor: null });
      }),
    );

    await orchestrator.handleChange({
      filePath: '/tmp/ignored.skip.jsonl',
      changeType: 'created',
      stat: { size: 64, mtime: new Date('2026-03-07T12:00:00.000Z') },
    });

    expect(cursorReads).toEqual([]);
    expect(extractDiscoveryMetadata).not.toHaveBeenCalled();
  });

  it('keeps start idempotent when discovery adds poll subscriptions', async () => {
    await withTempDir('discovery-orchestrator-start-', async (tempDir) => {
      let listCalls = 0;
      const orchestrator = new CountingStartDiscoveryOrchestrator(
        {
          enabled: true,
          adapterId: 'adapter-1',
          adapterName: 'claude-code',
          directory: tempDir,
        },
        createMockImporter(),
      );
      registerCleanup(() => orchestrator.dispose());

      registerCleanup(
        MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
          listCalls += 1;
          ctx.setResult({ sessions: [] });
        }),
      );

      await orchestrator.start();
      await orchestrator.start();

      expect(orchestrator.restoreCount).toBe(1);
      expect(listCalls).toBe(1);
    });
  });

  it('treats missing hasMessages metadata as no importable messages', async () => {
    const importer = createMockImporter({
      extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => ({
        adapterSessionId: 'adapter-session-1',
        model: null,
        cwd: null,
        title: 'Test Session',
      }),
    });
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      importer,
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/discovery-no-messages.jsonl';
    const discoveredSessions: unknown[] = [];
    const cursorWrites: Array<{ filePath: string; bytesRead: number }> = [];

    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
        ctx.setResult({ cursor: null });
      }),
    );
    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
        cursorWrites.push({ filePath: ctx.payload.filePath, bytesRead: ctx.payload.bytesRead });
        ctx.setResult({ success: true });
      }),
    );
    registerCleanup(
      MakaioBus.on(AdapterSubjects.session.discovered, (ctx) => {
        discoveredSessions.push(ctx.payload);
      }),
    );

    await orchestrator.handleChange({
      filePath,
      changeType: 'created',
      stat: { size: 64, mtime: new Date('2026-03-07T12:00:00.000Z') },
    });
    await orchestrator.idle();

    expect(discoveredSessions).toEqual([]);
    expect(cursorWrites).toEqual([{ filePath, bytesRead: 0 }]);
  });

  it('does not persist the discovery cursor when the discovery event emit fails', async () => {
    const importer = createMockImporter({
      extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => ({
        adapterSessionId: 'adapter-session-1',
        model: null,
        cwd: null,
        title: 'Test Session',
        hasMessages: true,
      }),
    });
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      importer,
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/discovery-emit-failure.jsonl';
    const cursorWrites: Array<{ filePath: string; bytesRead: number }> = [];

    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
        ctx.setResult({ cursor: null });
      }),
    );
    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
        cursorWrites.push({ filePath: ctx.payload.filePath, bytesRead: ctx.payload.bytesRead });
        ctx.setResult({ success: true });
      }),
    );
    registerCleanup(
      MakaioBus.on(AdapterSubjects.session.discovered, () => {
        throw new Error('emit failed');
      }),
    );

    await expect(
      orchestrator.handleChange({
        filePath,
        changeType: 'created',
        stat: { size: 64, mtime: new Date('2026-03-07T12:00:00.000Z') },
      }),
    ).rejects.toThrow('emit failed');

    expect(cursorWrites).toHaveLength(0);
  });

  it('re-runs discovery for modified files that become importable later', async () => {
    let metadataCallCount = 0;
    const importer = createMockImporter({
      extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => {
        metadataCallCount += 1;

        if (metadataCallCount === 1) {
          return {
            adapterSessionId: 'adapter-session-1',
            model: null,
            cwd: null,
            title: 'Skipped First',
            hasMessages: false,
          };
        }

        return {
          adapterSessionId: 'adapter-session-1',
          model: null,
          cwd: null,
          title: 'Importable Later',
          hasMessages: true,
        };
      },
    });
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      importer,
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/discovery-later-importable.jsonl';
    const discoveredSessions: unknown[] = [];
    const cursorWrites: Array<{ filePath: string; bytesRead: number }> = [];

    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
        ctx.setResult({
          cursor:
            metadataCallCount === 0
              ? null
              : {
                  filePath: ctx.payload.filePath,
                  bytesRead: 0,
                  lastModified: '2026-03-07T12:00:00.000Z',
                },
        });
      }),
    );
    registerCleanup(
      MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
        cursorWrites.push({ filePath: ctx.payload.filePath, bytesRead: ctx.payload.bytesRead });
        ctx.setResult({ success: true });
      }),
    );
    registerCleanup(
      MakaioBus.on(SessionStorageSubjects.getByLogFilePath, (ctx) => {
        ctx.setResult({ session: null });
      }),
    );
    registerCleanup(
      MakaioBus.on(AdapterSubjects.session.discovered, (ctx) => {
        discoveredSessions.push(ctx.payload);
      }),
    );

    await orchestrator.handleChange({
      filePath,
      changeType: 'created',
      stat: { size: 64, mtime: new Date('2026-03-07T12:00:00.000Z') },
    });
    await orchestrator.idle();

    await orchestrator.handleChange({
      filePath,
      changeType: 'modified',
      stat: { size: 96, mtime: new Date('2026-03-07T12:05:00.000Z') },
    });
    await orchestrator.idle();

    expect(metadataCallCount).toBe(2);
    expect(discoveredSessions).toHaveLength(1);
    expect(discoveredSessions).toContainEqual(
      expect.objectContaining({
        adapterSessionId: 'adapter-session-1',
        title: 'Importable Later',
      }),
    );
    expect(cursorWrites).toEqual([
      { filePath, bytesRead: 0 },
      { filePath, bytesRead: 0 },
    ]);
  });

  it('restores persisted tracking sessions and reverts them to imported after inactivity', async () => {
    await withTempDir('discovery-orchestrator-', async (tempDir) => {
      const filePath = path.join(tempDir, 'tracked.jsonl');
      fs.writeFileSync(filePath, '{"id":"seed","content":"hello"}\n', 'utf8');

      const trackingSession = createImportedSession({
        adapterSessionId: 'adapter-session-2',
        importStatus: 'tracking',
        logFilePath: filePath,
        sessionId: 'session-2',
      });
      const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];

      const orchestrator = new TestDiscoveryOrchestrator(
        {
          enabled: true,
          adapterId: 'adapter-1',
          adapterName: 'claude-code',
          directory: tempDir,
        },
        createMockImporter(),
      );
      registerCleanup(() => orchestrator.dispose());

      registerCursorGetHandler({
        bytesRead: 0,
        lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
        sessionContext: createSessionContext({ adapterSessionId: 'adapter-session-2' }),
      });
      registerCleanup(
        MakaioBus.on(ImportCursorStorageSubjects.delete, (ctx) => {
          ctx.setResult({ success: true });
        }),
      );
      registerCleanup(
        MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerSessionLookupByLogFilePath(trackingSession);
      registerUpdateImportStatusHandler(statusUpdates);

      orchestrator.seedFromCursors([
        {
          filePath,
          bytesRead: 0,
          lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
        },
      ]);

      await orchestrator.restoreTrackingState();
      await orchestrator.runPollCycle(new Set([filePath]));
      await orchestrator.runPollCycle(new Set([filePath]));
      await orchestrator.runPollCycle(new Set([filePath]));

      expect(statusUpdates).toContainEqual({
        sessionId: 'session-2',
        importStatus: 'imported',
      });
    });
  });

  it('resets persisted tracking sessions when watcher state cannot be restored', async () => {
    const trackingSession = createImportedSession({
      adapterSessionId: 'adapter-session-missing-watch-state',
      importStatus: 'tracking',
      logFilePath: '/tmp/not-seeded.jsonl',
      sessionId: 'session-missing-watch-state',
    });
    const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter(),
    );
    registerCleanup(() => orchestrator.dispose());

    registerCleanup(
      MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
        expect(ctx.payload).toEqual({ source: 'claude-code', importStatus: 'tracking' });
        ctx.setResult({ sessions: [trackingSession] });
      }),
    );
    registerUpdateImportStatusHandler(statusUpdates);

    await orchestrator.restoreTrackingState();

    expect(statusUpdates).toEqual([
      {
        sessionId: 'session-missing-watch-state',
        importStatus: 'imported',
      },
    ]);
    expect(orchestrator.isTrackingFile('/tmp/not-seeded.jsonl')).toBe(false);
  });

  it('resets persisted tracking sessions that no longer have a log file path', async () => {
    const trackingSession = createImportedSession({
      adapterSessionId: 'adapter-session-no-log-path',
      importStatus: 'tracking',
      logFilePath: null,
      sessionId: 'session-no-log-path',
    });
    const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter(),
    );
    registerCleanup(() => orchestrator.dispose());

    registerCleanup(
      MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
        expect(ctx.payload).toEqual({ source: 'claude-code', importStatus: 'tracking' });
        ctx.setResult({ sessions: [trackingSession] });
      }),
    );
    registerUpdateImportStatusHandler(statusUpdates);

    await orchestrator.restoreTrackingState();

    expect(statusUpdates).toEqual([
      {
        sessionId: 'session-no-log-path',
        importStatus: 'imported',
      },
    ]);
  });

  it('ignores modified imported files that belong to another source', async () => {
    const processRecords = vi.fn(() => []);
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter({ processRecords }),
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/other-source-session.jsonl';
    const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];

    registerCursorGetHandler({
      bytesRead: 10,
      lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
      sessionContext: createSessionContext({ adapterSessionId: 'adapter-session-other-source' }),
    });
    registerSessionLookupByLogFilePath(
      createImportedSession({
        adapterSessionId: 'adapter-session-other-source',
        importStatus: 'imported',
        logFilePath: filePath,
        source: 'codex',
      }),
      filePath,
    );
    registerUpdateImportStatusHandler(statusUpdates);

    await orchestrator.handleChange({
      filePath,
      changeType: 'modified',
      stat: { size: 128, mtime: new Date('2026-03-05T10:00:05.000Z') },
    });
    await orchestrator.idle();

    expect(processRecords).not.toHaveBeenCalled();
    expect(statusUpdates).toEqual([]);
    expect(orchestrator.isTrackingFile(filePath)).toBe(false);
  });

  it('does not mark a file as tracking when incremental import fails', async () => {
    const orchestrator = new ThrowingDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter(),
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/failing-imported-session.jsonl';
    const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];

    registerCursorGetHandler({
      bytesRead: 10,
      lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
      sessionContext: createSessionContext(),
    });
    registerSessionLookupByLogFilePath(
      createImportedSession({
        adapterSessionId: 'adapter-session-1',
        importStatus: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerUpdateImportStatusHandler(statusUpdates);

    try {
      await expect(
        orchestrator.handleChange({
          filePath,
          changeType: 'modified',
          stat: { size: 128, mtime: new Date('2026-03-05T10:00:05.000Z') },
        }),
      ).rejects.toThrow('parse failed');

      expect(statusUpdates).toEqual([]);
      expect(orchestrator.isTrackingFile(filePath)).toBe(false);
    } finally {
      // disposed via registered cleanup
    }
  });

  it('does not mark a file as tracking when the tracking status update fails', async () => {
    const processRecords = vi.fn(() => []);
    const orchestrator = new TestDiscoveryOrchestrator(
      {
        enabled: true,
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
      },
      createMockImporter({ processRecords }),
    );
    registerCleanup(() => orchestrator.dispose());

    const filePath = '/tmp/update-status-failure.jsonl';

    registerCursorGetHandler({
      bytesRead: 10,
      lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
      sessionContext: createSessionContext({ adapterSessionId: 'adapter-session-3' }),
    });
    registerCursorSetSuccessHandler();
    registerSessionLookupByLogFilePath(
      createImportedSession({
        adapterSessionId: 'adapter-session-3',
        importStatus: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerCleanup(
      MakaioBus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
        ctx.setResult({ success: false });
      }),
    );

    try {
      await orchestrator.handleChange({
        filePath,
        changeType: 'modified',
        stat: { size: 128, mtime: new Date('2026-03-05T10:00:05.000Z') },
      });
      await orchestrator.idle();

      expect(processRecords).toHaveBeenCalledTimes(1);
      expect(orchestrator.isTrackingFile(filePath)).toBe(false);
    } finally {
      // disposed via registered cleanup
    }
  });

  it('keeps tracking state when reverting to imported fails', async () => {
    await withTempDir('discovery-orchestrator-', async (tempDir) => {
      const filePath = path.join(tempDir, 'tracked-still-live.jsonl');
      fs.writeFileSync(filePath, '{"id":"seed","content":"hello"}\n', 'utf8');

      const trackingSession = createImportedSession({
        adapterSessionId: 'adapter-session-4',
        importStatus: 'tracking',
        logFilePath: filePath,
        sessionId: 'session-4',
      });
      const orchestrator = new TestDiscoveryOrchestrator(
        {
          enabled: true,
          adapterId: 'adapter-1',
          adapterName: 'claude-code',
          directory: tempDir,
        },
        createMockImporter(),
      );
      registerCleanup(() => orchestrator.dispose());

      registerCleanup(
        MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerSessionLookupByLogFilePath(trackingSession);
      registerCleanup(
        MakaioBus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
          ctx.setResult({ success: false });
        }),
      );

      orchestrator.seedFromCursors([
        {
          filePath,
          bytesRead: 0,
          lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
        },
      ]);

      await orchestrator.restoreTrackingState();
      await orchestrator.runPollCycle(new Set([filePath]));
      await orchestrator.runPollCycle(new Set([filePath]));
      await orchestrator.runPollCycle(new Set([filePath]));

      expect(orchestrator.isTrackingFile(filePath)).toBe(true);
    });
  });

  it('reverts tracked sessions to imported when a tracked file disappears', async () => {
    await withTempDir('discovery-orchestrator-', async (tempDir) => {
      const filePath = path.join(tempDir, 'tracked-disappears.jsonl');
      fs.writeFileSync(filePath, '{"id":"seed","content":"hello"}\n', 'utf8');

      const trackingSession = createImportedSession({
        adapterSessionId: 'adapter-session-5',
        importStatus: 'tracking',
        logFilePath: filePath,
        sessionId: 'session-5',
      });
      const statusUpdates: Array<{ sessionId: string; importStatus: NonNullable<SessionRecord['importStatus']> }> = [];

      const orchestrator = new TestDiscoveryOrchestrator(
        {
          enabled: true,
          adapterId: 'adapter-1',
          adapterName: 'claude-code',
          directory: tempDir,
        },
        createMockImporter(),
      );
      registerCleanup(() => orchestrator.dispose());

      registerCleanup(
        MakaioBus.on(SessionStorageSubjects.listImported, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerSessionLookupByLogFilePath(trackingSession, filePath);
      registerUpdateImportStatusHandler(statusUpdates);

      orchestrator.seedFromCursors([
        {
          filePath,
          bytesRead: 0,
          lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
        },
      ]);

      await orchestrator.restoreTrackingState();
      expect(orchestrator.isTrackingFile(filePath)).toBe(true);

      fs.rmSync(filePath, { force: true });
      await orchestrator.runPollCycle(new Set());

      expect(statusUpdates).toContainEqual({
        sessionId: 'session-5',
        importStatus: 'imported',
      });
      expect(orchestrator.isTrackingFile(filePath)).toBe(false);
    });
  });
});
