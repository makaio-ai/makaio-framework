/// <reference types="bun-types" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock, jest } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import type { AdapterSessionRecord } from '@makaio/services-core/session';
import { AdapterSessionStorageSubjects } from '@makaio/services-core/session';
import type { LogImporter, DiscoveryMetadata } from '../../log-importer/types.js';
import { DiscoveryOrchestrator } from '../../log-importer/discovery-orchestrator.js';
import { ImportCursorStorageSubjects } from '../../log-importer/cursor-storage.js';
import type { LogOrchestratorConfig, ParseFileResult } from '../../log-importer/base-orchestrator.js';

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

function registerAdapterSessionLookup(session: AdapterSessionRecord, filePath?: string): void {
  registerCleanup(
    MakaioBus.on(AdapterSessionStorageSubjects.getByLogFilePath, (ctx) => {
      if (filePath !== undefined) {
        expect(ctx.payload.logFilePath).toBe(filePath);
      }

      ctx.setResult({ session });
    }),
  );
}

function registerUpdateStatusHandler(
  statusUpdates: Array<{ adapterSessionId: string; status: AdapterSessionRecord['status'] }>,
  success = true,
): void {
  registerCleanup(
    MakaioBus.on(AdapterSessionStorageSubjects.updateStatus, (ctx) => {
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

function createAdapterSession(
  overrides: Partial<AdapterSessionRecord> & Pick<AdapterSessionRecord, 'adapterSessionId' | 'status'>,
): AdapterSessionRecord {
  const now = Date.now();
  return {
    adapterSessionId: overrides.adapterSessionId,
    adapterName: overrides.adapterName ?? 'claude-code',
    parentAdapterSessionId: overrides.parentAdapterSessionId ?? null,
    forkPointMessageId: overrides.forkPointMessageId ?? null,
    sessionId: overrides.sessionId ?? 'session-1',
    model: overrides.model ?? null,
    cwd: overrides.cwd ?? null,
    logFilePath: overrides.logFilePath ?? null,
    discoveredAt: overrides.discoveredAt ?? now,
    startedAt: overrides.startedAt ?? now,
    status: overrides.status,
    kind: overrides.kind ?? 'root',
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
    console.info = mock();
    console.warn = mock();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    console.info = originalInfo;
    console.warn = originalWarn;
    jest.useRealTimers();
  });

  it('processes incremental reads for modified imported files before switching to tracking', async () => {
    const processRecords = mock(() => []);
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
    const statusUpdates: Array<{ adapterSessionId: string; status: AdapterSessionRecord['status'] }> = [];

    registerCursorGetHandler({
      filePath,
      bytesRead: 10,
      lastModified: lastModified.toISOString(),
      sessionContext: createSessionContext(),
    });
    registerCursorSetSuccessHandler();
    registerAdapterSessionLookup(
      createAdapterSession({
        adapterSessionId: 'adapter-session-1',
        status: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerUpdateStatusHandler(statusUpdates);

    await orchestrator.handleChange({
      filePath,
      changeType: 'modified',
      stat: { size: 128, mtime: new Date('2026-03-05T10:00:05.000Z') },
    });
    await orchestrator.idle();

    expect(processRecords).toHaveBeenCalledTimes(1);
    expect(statusUpdates).toEqual([{ adapterSessionId: 'adapter-session-1', status: 'tracking' }]);
  });

  it('preserves the base skip-file guard for discovery overrides', async () => {
    const extractDiscoveryMetadata = mock(createMockImporter().extractDiscoveryMetadata);
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
        MakaioBus.on(AdapterSessionStorageSubjects.list, (ctx) => {
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
      MakaioBus.on(AdapterSessionStorageSubjects.getByLogFilePath, (ctx) => {
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

      const trackingSession = createAdapterSession({
        adapterSessionId: 'adapter-session-2',
        status: 'tracking',
        logFilePath: filePath,
      });
      const statusUpdates: Array<{ adapterSessionId: string; status: AdapterSessionRecord['status'] }> = [];

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
        MakaioBus.on(AdapterSessionStorageSubjects.list, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerAdapterSessionLookup(trackingSession);
      registerUpdateStatusHandler(statusUpdates);

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
        adapterSessionId: 'adapter-session-2',
        status: 'imported',
      });
    });
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
    const statusUpdates: Array<{ adapterSessionId: string; status: AdapterSessionRecord['status'] }> = [];

    registerCursorGetHandler({
      bytesRead: 10,
      lastModified: new Date('2026-03-05T10:00:00.000Z').toISOString(),
      sessionContext: createSessionContext(),
    });
    registerAdapterSessionLookup(
      createAdapterSession({
        adapterSessionId: 'adapter-session-1',
        status: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerUpdateStatusHandler(statusUpdates);

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
    const processRecords = mock(() => []);
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
    registerAdapterSessionLookup(
      createAdapterSession({
        adapterSessionId: 'adapter-session-3',
        status: 'imported',
        logFilePath: filePath,
      }),
      filePath,
    );
    registerCleanup(
      MakaioBus.on(AdapterSessionStorageSubjects.updateStatus, (ctx) => {
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

      const trackingSession = createAdapterSession({
        adapterSessionId: 'adapter-session-4',
        status: 'tracking',
        logFilePath: filePath,
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
        MakaioBus.on(AdapterSessionStorageSubjects.list, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerAdapterSessionLookup(trackingSession);
      registerCleanup(
        MakaioBus.on(AdapterSessionStorageSubjects.updateStatus, (ctx) => {
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

      const trackingSession = createAdapterSession({
        adapterSessionId: 'adapter-session-5',
        status: 'tracking',
        logFilePath: filePath,
      });
      const statusUpdates: Array<{ adapterSessionId: string; status: AdapterSessionRecord['status'] }> = [];

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
        MakaioBus.on(AdapterSessionStorageSubjects.list, (ctx) => {
          ctx.setResult({ sessions: [trackingSession] });
        }),
      );
      registerAdapterSessionLookup(trackingSession, filePath);
      registerUpdateStatusHandler(statusUpdates);

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
        adapterSessionId: 'adapter-session-5',
        status: 'imported',
      });
      expect(orchestrator.isTrackingFile(filePath)).toBe(false);
    });
  });
});
