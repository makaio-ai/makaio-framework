/// <reference types="bun-types" />
/**
 * Unit tests for BaseLogOrchestrator.
 *
 * Tests the abstract base class using a concrete test implementation
 * with minimal stubs.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import {
  BaseLogOrchestrator,
  type LogOrchestratorConfig,
  type ParseFileResult,
} from '../../log-importer/base-orchestrator.js';
import { ImportCursorStorageSubjects } from '../../log-importer/cursor-storage.js';
import type { LogImporter, DiscoveryMetadata } from '../../log-importer/types.js';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Simple test record type */
interface TestRecord {
  id: string;
  type: string;
  content: string;
}

/**
 * Create a mock importer for testing.
 * @param overrides - Optional overrides
 */
function createMockImporter(overrides?: Partial<LogImporter<TestRecord, unknown>>): LogImporter<TestRecord, unknown> {
  return {
    canHandle: () => true,
    getLogDirectory: () => '/test/logs',
    parseRecord: (line) => (typeof line === 'string' ? JSON.parse(line) : line) as TestRecord,
    isMakaioManaged: async () => false,
    extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => ({
      adapterSessionId: 'test-session',
      model: null,
      cwd: null,
      title: 'Test session',
      hasMessages: true,
    }),
    extractSessionContext: () => ({
      adapterSessionId: 'test-session',
      model: null,
      cwd: null,
      sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
      startedEvent: { subject: AgentSubjects.started, payload: {} },
      state: {},
    }),
    processRecords: () => [],
    serializeState: () => ({}),
    deserializeState: () => ({}),
    processLogFile: () => ({
      adapterSessionId: 'test-session',
      sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
      messageEvents: [],
      messagePayloads: [],
      lineage: { kind: 'root' as const, parentAdapterSessionId: null, forkPointMessageId: null },
    }),
    ...overrides,
  };
}

/**
 * Concrete test implementation of BaseLogOrchestrator.
 * Implements abstract methods with minimal stubs for testing.
 */
class TestLogOrchestrator extends BaseLogOrchestrator<TestRecord, unknown> {
  protected readonly logPrefix = '[TestLogOrchestrator]';

  public constructor(config: LogOrchestratorConfig, importer: LogImporter<TestRecord, unknown>) {
    super(config, importer);
  }

  /** Expose protected importer for testing */
  public getImporter(): LogImporter<TestRecord, unknown> {
    return this.importer;
  }

  /** Expose protected config for testing */
  public getConfig(): LogOrchestratorConfig {
    return this.config;
  }

  protected getLogFilePattern(): string {
    return '*.jsonl';
  }

  protected async parseFile(_filePath: string, _startOffset: number): Promise<ParseFileResult<TestRecord>> {
    return { records: [], bytesRead: 0 };
  }

  public async checkSessionSkipped(adapterSessionId: string): Promise<boolean> {
    return this.isSessionSkipped(adapterSessionId);
  }

  /** Expose protected format-detection helper for tests. */
  public usesJsonFormatPublic(): boolean {
    return this.usesJsonFormat();
  }

  /**
   * Expose protected handleFileChange for integration tests.
   * @param event - The file change event to process
   */
  public async handleChange(event: {
    filePath: string;
    changeType: 'created' | 'modified' | 'rotated';
    stat: { size: number; mtime: Date };
  }): Promise<void> {
    await this.handleFileChange(event);
  }

  /**
   * Expose watcher-style tracking for lifecycle tests.
   * @param event - The file change event to queue
   */
  public triggerTrackedChange(event: {
    filePath: string;
    changeType: 'created' | 'modified' | 'rotated';
    stat: { size: number; mtime: Date };
  }): void {
    this.trackFileChange(event);
  }

  /**
   * Expose the protected first-read handler for cursor-order tests.
   * @param filePath - Path to the log file
   * @param records - Parsed records to process
   * @param bytesRead - Bytes read during this parse
   * @param mtime - File modification time
   * @param isJsonFormat - Whether the file uses JSON (mtime-based) format
   * @param startOffset - Byte offset this read started from
   * @param emitLifecycleEvents - Whether to emit lifecycle events for the pass
   */
  public async runFirstRead(
    filePath: string,
    records: TestRecord[],
    bytesRead: number,
    mtime: Date,
    isJsonFormat: boolean,
    startOffset: number,
    emitLifecycleEvents = true,
  ): Promise<void> {
    await this.handleFirstRead(filePath, records, bytesRead, mtime, isJsonFormat, startOffset, emitLifecycleEvents);
  }

  /** Wait for all queued events to drain. */
  public async idle(): Promise<void> {
    await this.eventQueue.drain();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('BaseLogOrchestrator', () => {
  let originalConsoleInfo: typeof console.info;

  beforeEach(() => {
    // Suppress console.info during tests
    originalConsoleInfo = console.info;
    console.info = mock();
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
  });

  describe('constructor', () => {
    it('should accept importer and extract log directory from it', () => {
      const importer = createMockImporter({
        getLogDirectory: () => '/custom/log/path',
      });

      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test-adapter',
        adapterName: 'Test Adapter',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      expect(orchestrator.getImporter()).toBe(importer);
      expect(orchestrator.isEnabled()).toBe(true);
    });

    it('should use config.directory over importer.getLogDirectory()', () => {
      const importer = createMockImporter({
        getLogDirectory: () => '/default/path',
      });

      const config: LogOrchestratorConfig = {
        enabled: true,
        directory: '/override/path',
        adapterId: 'test-adapter',
        adapterName: 'Test Adapter',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      // The directory override should be preserved in config
      expect(orchestrator.getConfig().directory).toBe('/override/path');
    });
  });

  describe('config normalization', () => {
    it('should use default pollIntervalMs when not provided', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      const resolvedConfig = orchestrator.getConfig();

      expect(resolvedConfig.pollIntervalMs).toBe(10_000); // DEFAULT_POLL_INTERVAL_MS
    });

    it('should use provided pollIntervalMs', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
        pollIntervalMs: 5000,
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      const resolvedConfig = orchestrator.getConfig();

      expect(resolvedConfig.pollIntervalMs).toBe(5000);
    });

    it('should use default eventsPerSecond when not provided', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      const resolvedConfig = orchestrator.getConfig();

      expect(resolvedConfig.eventsPerSecond).toBe(100); // DEFAULT_EVENTS_PER_SECOND
    });

    it('should use provided eventsPerSecond', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
        eventsPerSecond: 50,
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      const resolvedConfig = orchestrator.getConfig();

      expect(resolvedConfig.eventsPerSecond).toBe(50);
    });

    it('should preserve checkMakaioManaged callback in config', () => {
      const importer = createMockImporter();
      const customCheck = mock().mockResolvedValue(true);
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
        checkMakaioManaged: customCheck,
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      const resolvedConfig = orchestrator.getConfig();

      expect(resolvedConfig.checkMakaioManaged).toBe(customCheck);
    });
  });

  describe('isEnabled', () => {
    it('should return true when enabled', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      expect(orchestrator.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: false,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      expect(orchestrator.isEnabled()).toBe(false);
    });
  });

  describe('start/stop/dispose lifecycle', () => {
    it('should not start when disabled', async () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: false,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      await orchestrator.start();

      expect(orchestrator.isRunning()).toBe(false);
    });

    it('should start when enabled', async () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      try {
        await orchestrator.start();
        expect(orchestrator.isRunning()).toBe(true);
      } finally {
        await orchestrator.dispose();
      }
    });

    it('clears managed-session skip cache when a new run starts', async () => {
      const managedCheck = mock().mockResolvedValue(false);
      const importer = createMockImporter({ isMakaioManaged: managedCheck });
      const orchestrator = new TestLogOrchestrator(
        {
          enabled: true,
          adapterId: 'test',
          adapterName: 'Test',
        },
        importer,
      );

      try {
        await orchestrator.checkSessionSkipped('session-1');
        await orchestrator.start();
        await orchestrator.checkSessionSkipped('session-1');

        expect(managedCheck).toHaveBeenCalledTimes(2);
      } finally {
        await orchestrator.dispose();
      }
    });

    it('should not start twice', async () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      try {
        await orchestrator.start();
        await orchestrator.start(); // Second call should be no-op
        expect(orchestrator.isRunning()).toBe(true);
      } finally {
        await orchestrator.dispose();
      }
    });

    it('should stop correctly', async () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      try {
        await orchestrator.start();
        expect(orchestrator.isRunning()).toBe(true);

        await orchestrator.stop();
        expect(orchestrator.isRunning()).toBe(false);
      } finally {
        await orchestrator.dispose();
      }
    });

    it('waits for tracked file changes and queued cursor writes before stop returns', async () => {
      let releaseParse: (() => void) | undefined;
      const parseStarted = new Promise<void>((resolve) => {
        releaseParse = resolve;
      });
      const cursorWrites: Array<{ filePath: string; bytesRead: number }> = [];

      class SlowParseOrchestrator extends TestLogOrchestrator {
        protected override async parseFile(
          _filePath: string,
          _startOffset: number,
        ): Promise<ParseFileResult<TestRecord>> {
          await parseStarted;
          return {
            records: [{ id: 'r1', type: 'message', content: 'hello' }],
            bytesRead: 20,
          };
        }

        protected override queueEvent(): Promise<void> {
          return Promise.resolve();
        }
      }

      const orchestrator = new SlowParseOrchestrator(
        { enabled: true, adapterId: 'test', adapterName: 'Test' },
        createMockImporter(),
      );
      const busCleanups = [
        MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
          ctx.setResult({ cursor: null });
        }),
        MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
          cursorWrites.push({ filePath: ctx.payload.filePath, bytesRead: ctx.payload.bytesRead });
          ctx.setResult({ success: true });
        }),
      ];

      try {
        orchestrator.triggerTrackedChange({
          filePath: '/tmp/test-session.jsonl',
          changeType: 'created',
          stat: { size: 20, mtime: new Date('2026-03-09T10:00:00.000Z') },
        });

        let stopped = false;
        const stopPromise = orchestrator.stop().then(() => {
          stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(stopped).toBe(false);

        releaseParse?.();
        await stopPromise;

        expect(cursorWrites).toEqual([{ filePath: '/tmp/test-session.jsonl', bytesRead: 20 }]);
      } finally {
        releaseParse?.();
        await orchestrator.dispose();
        for (const cleanup of busCleanups) {
          cleanup();
        }
      }
    });

    it('should dispose correctly', async () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);
      await orchestrator.start();

      await orchestrator.dispose();
      expect(orchestrator.isRunning()).toBe(false);
    });
  });

  describe('createDefaultCheckMakaioManaged', () => {
    it('should return a function', () => {
      const checkFn = BaseLogOrchestrator.createDefaultCheckMakaioManaged();
      expect(typeof checkFn).toBe('function');
    });

    it('should return false when AgentEventStorage has no events (mocked)', async () => {
      // The actual check requires MakaioBus which is mocked in integration tests
      // Here we just verify the function signature
      const checkFn = BaseLogOrchestrator.createDefaultCheckMakaioManaged();

      // Without MakaioBus running, this should catch and return false
      const result = await checkFn('test-session');
      expect(result).toBe(false);
    });
  });

  describe('usesJsonFormat detection', () => {
    it('should detect JSON format from pattern', () => {
      class JsonOrchestrator extends TestLogOrchestrator {
        protected override getLogFilePattern(): string {
          return '*.json';
        }
      }

      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new JsonOrchestrator(config, importer);

      expect(orchestrator.usesJsonFormatPublic()).toBe(true);
    });

    it('should detect JSONL format from pattern', () => {
      const importer = createMockImporter();
      const config: LogOrchestratorConfig = {
        enabled: true,
        adapterId: 'test',
        adapterName: 'Test',
      };

      const orchestrator = new TestLogOrchestrator(config, importer);

      expect(orchestrator.usesJsonFormatPublic()).toBe(false);
    });
  });

  describe('handleIncrementalRead - corrupted cursor recovery', () => {
    /** Bus unsubscribe callbacks collected per test for cleanup. */
    const cleanups: Array<() => void | Promise<void>> = [];

    let originalConsoleWarn: typeof console.warn;

    beforeEach(() => {
      originalConsoleWarn = console.warn;
      console.warn = mock();
    });

    afterEach(async () => {
      console.warn = originalConsoleWarn;
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    /**
     * Variant of TestLogOrchestrator that always returns one record from parseFile,
     * ensuring handleIncrementalRead (and handleFirstRead) are reached even with
     * minimal importer stubs.
     *
     * Overrides queueEvent to a no-op so that stub lifecycle events (which carry
     * empty payloads) are not emitted to MakaioBus — this test verifies the
     * recovery control flow, not the event emission pipeline.
     */
    class RecordReturningOrchestrator extends TestLogOrchestrator {
      protected override async parseFile(
        _filePath: string,
        _startOffset: number,
      ): Promise<ParseFileResult<TestRecord>> {
        return {
          records: [{ id: 'r1', type: 'message', content: 'hello' }],
          bytesRead: 20,
        };
      }

      protected override queueEvent(): Promise<void> {
        // Suppress event emission: this test focuses on the recovery control flow,
        // not on event payload correctness.
        return Promise.resolve();
      }
    }

    it('deletes corrupted cursor and falls through to handleFirstRead when deserializeState throws', async () => {
      const filePath = '/tmp/test-session.jsonl';
      const mtime = new Date('2026-03-09T10:00:05.000Z');
      const lastModified = new Date('2026-03-09T10:00:00.000Z');

      const extractSessionContext = mock(() => ({
        adapterSessionId: 'session-1',
        model: null,
        cwd: null,
        sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
        startedEvent: { subject: AgentSubjects.started, payload: {} },
        state: {},
      }));

      const importer = createMockImporter({
        deserializeState: () => {
          throw new Error('Zod parse failure: expected object, got string');
        },
        extractSessionContext,
        isMakaioManaged: async () => false,
      });

      const orchestrator = new RecordReturningOrchestrator(
        { enabled: true, adapterId: 'test', adapterName: 'Test' },
        importer,
      );
      cleanups.push(() => orchestrator.dispose());

      // Cursor with a valid sessionContext — triggers the incremental read path
      cleanups.push(
        MakaioBus.on(ImportCursorStorageSubjects.get, (ctx) => {
          ctx.setResult({
            cursor: {
              filePath: ctx.payload.filePath,
              bytesRead: 10,
              lastModified: lastModified.toISOString(),
              sessionContext: {
                adapterSessionId: 'session-1',
                model: null,
                cwd: null,
                sessionEvent: { subject: AdapterSubjects.session.discovered, payload: {} },
                startedEvent: { subject: AgentSubjects.started, payload: {} },
                state: { corruptedField: 'not-a-valid-state' },
              },
            },
          });
        }),
      );

      const deletedPaths: string[] = [];
      cleanups.push(
        MakaioBus.on(ImportCursorStorageSubjects.delete, (ctx) => {
          deletedPaths.push(ctx.payload.filePath);
          ctx.setResult({ success: true });
        }),
      );

      // handleFirstRead will attempt to update the cursor after re-import
      cleanups.push(
        MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
          ctx.setResult({ success: true });
        }),
      );

      await orchestrator.handleChange({
        filePath,
        changeType: 'modified',
        stat: { size: 128, mtime },
      });
      await orchestrator.idle();

      // Warning must be logged
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Corrupted cursor state'),
        expect.stringContaining('Zod parse failure'),
      );

      // Corrupted cursor must be deleted
      expect(deletedPaths).toContain(filePath);

      // handleFirstRead must be invoked — proven by extractSessionContext being called
      expect(extractSessionContext).toHaveBeenCalledTimes(1);
    });
  });

  describe('cursor advancement', () => {
    const cleanups: Array<() => void | Promise<void>> = [];

    let originalConsoleError: typeof console.error;

    beforeEach(() => {
      originalConsoleError = console.error;
      console.error = mock();
    });

    afterEach(async () => {
      console.error = originalConsoleError;
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it('does not advance the cursor when a queued event emission rejects', async () => {
      const cursorWrites: Array<{ filePath: string; bytesRead: number }> = [];
      const importer = createMockImporter({
        processRecords: () => [
          {
            subject: AgentSubjects.started,
            payload: {
              agentId: 'agent-1',
              adapterId: 'adapter-1',
              adapterName: 'test',
              adapterSessionId: 'adapter-session-1',
              model: 'gpt-4',
              cwd: null,
            },
          },
        ],
      });
      const orchestrator = new TestLogOrchestrator(
        {
          enabled: true,
          adapterId: 'test',
          adapterName: 'Test',
        },
        importer,
      );
      cleanups.push(() => orchestrator.dispose());

      cleanups.push(
        MakaioBus.on(AgentSubjects.started, () => {
          throw new Error('emit failed');
        }),
      );
      cleanups.push(
        MakaioBus.on(ImportCursorStorageSubjects.set, (ctx) => {
          cursorWrites.push({ filePath: ctx.payload.filePath, bytesRead: ctx.payload.bytesRead });
          ctx.setResult({ success: true });
        }),
      );

      await expect(
        orchestrator.runFirstRead(
          '/tmp/test-session.jsonl',
          [{ id: 'r1', type: 'message', content: 'hello' }],
          20,
          new Date('2026-03-09T10:00:00.000Z'),
          false,
          0,
          false,
        ),
      ).rejects.toThrow('emit failed');

      expect(cursorWrites).toHaveLength(0);
    });
  });

  describe('isSessionSkipped', () => {
    it('cleans in-flight state when importer check rejects and allows retries', async () => {
      const managedCheck = mock<(_: string) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(false);

      const importer = createMockImporter({
        isMakaioManaged: managedCheck,
      });
      const orchestrator = new TestLogOrchestrator({ enabled: true, adapterId: 'test', adapterName: 'Test' }, importer);

      await expect(orchestrator.checkSessionSkipped('session-1')).rejects.toThrow('boom');
      await expect(orchestrator.checkSessionSkipped('session-1')).resolves.toBe(false);
      expect(managedCheck).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent checks for the same session id', async () => {
      const managedCheck = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      });
      const importer = createMockImporter({ isMakaioManaged: managedCheck });
      const orchestrator = new TestLogOrchestrator({ enabled: true, adapterId: 'test', adapterName: 'Test' }, importer);

      const [first, second] = await Promise.all([
        orchestrator.checkSessionSkipped('session-1'),
        orchestrator.checkSessionSkipped('session-1'),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(managedCheck).toHaveBeenCalledTimes(1);
    });

    it('returns cached value on subsequent sequential calls', async () => {
      const managedCheck = mock().mockResolvedValue(false);
      const importer = createMockImporter({ isMakaioManaged: managedCheck });
      const orchestrator = new TestLogOrchestrator({ enabled: true, adapterId: 'test', adapterName: 'Test' }, importer);

      await expect(orchestrator.checkSessionSkipped('session-1')).resolves.toBe(false);
      await expect(orchestrator.checkSessionSkipped('session-1')).resolves.toBe(false);
      expect(managedCheck).toHaveBeenCalledTimes(1);
    });
  });
});
