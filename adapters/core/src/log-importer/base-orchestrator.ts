/** Base orchestrator for log import across adapters. @packageDocumentation */
import { MakaioBus } from '@makaio/bus-core';

import { ImportCursorStorageSubjects } from './cursor-storage.js';
import { LogImportEventQueue } from './event-queue.js';
import { LogImportWatcher, type LogFileChangeEvent } from './log-import-watcher.js';
import { LogImportStats } from './import-stats.js';
import { createDefaultCheckMakaioManaged, MakaioManagedSessionCache } from './makaio-managed-session.js';
import {
  DEFAULT_EVENTS_PER_SECOND,
  DEFAULT_POLL_INTERVAL_MS,
  PROGRESS_LOG_INTERVAL_MS,
  type LogOrchestratorConfig,
  type ParseFileResult,
} from './orchestrator-config.js';
import {
  getCursorWithMigration,
  logParseErrors,
  reParseAndHandleFirstRead,
  shouldSkipUnchangedFile,
} from './orchestrator-file-processor.js';
import {
  buildFirstReadEventPromises,
  buildIncrementalCursorContext,
  buildIncrementalReadEventPromises,
  detectCompactionInState,
} from './orchestrator-read-handlers.js';
import type { NormalizedEvent, LogImporter, LogImportSessionContext, ImportCursorPosition } from './types.js';
import { WatcherTaskTracker } from './watcher-task-tracker.js';

export type { LogOrchestratorConfig, ParseFileResult } from './orchestrator-config.js';

/**
 * Abstract base class for log import orchestrators.
 *
 * Supports JSONL (byte offset cursors) and JSON (mtime-based) file formats.
 * Concrete implementations provide adapter-specific file parsing.
 * @typeParam TRecord - The adapter's native log record type
 * @typeParam TState - The adapter's resumable state type (default: unknown)
 */
export abstract class BaseLogOrchestrator<TRecord, TState = unknown> {
  protected readonly config: Required<Omit<LogOrchestratorConfig, 'checkMakaioManaged' | 'directory' | 'machineId'>> & {
    checkMakaioManaged?: LogOrchestratorConfig['checkMakaioManaged'];
    directory?: string;
    machineId?: string | null;
  };

  protected readonly watcher: LogImportWatcher;
  protected readonly eventQueue: LogImportEventQueue;

  /** Log prefix for console output - set by subclass */
  protected abstract readonly logPrefix: string;

  /** Importer instance - subclasses create and manage their own typed instance. */
  protected readonly importer: LogImporter<TRecord, TState>;

  private readonly managedSessionCache = new MakaioManagedSessionCache();
  private unsubscribeChange?: () => void;
  private unsubscribeError?: () => void;
  private unsubscribeDeleted?: () => void;
  private readonly stats = new LogImportStats();
  private readonly watcherTasks = new WatcherTaskTracker();
  private progressTimer?: ReturnType<typeof setInterval>;

  protected constructor(config: LogOrchestratorConfig, importer: LogImporter<TRecord, TState>) {
    this.importer = importer;

    const logDirectory = config.directory ?? importer.getLogDirectory();

    this.config = {
      enabled: config.enabled,
      directory: config.directory,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      eventsPerSecond: config.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND,
      adapterId: config.adapterId,
      adapterName: config.adapterName,
      checkMakaioManaged: config.checkMakaioManaged,
      machineId: config.machineId,
    };

    this.watcher = new LogImportWatcher({
      directory: logDirectory,
      pattern: this.getLogFilePattern(),
      pollIntervalMs: this.config.pollIntervalMs,
    });

    this.eventQueue = new LogImportEventQueue({
      eventsPerSecond: this.config.eventsPerSecond,
      onEventEmitted: () => {
        this.stats.recordEventEmitted(this.logPrefix);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Abstract Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /** Get the glob pattern for log files to watch. */
  protected abstract getLogFilePattern(): string;

  /**
   * Determine whether a discovered file should be skipped before processing.
   *
   * Default implementation never skips. Subclasses may override to exclude
   * files by name (e.g., ephemeral compaction summary files).
   * @param _filePath - Absolute path to the candidate file
   * @returns `true` to skip the file entirely, `false` to process normally
   */
  protected shouldSkipFile(_filePath: string): boolean {
    return false;
  }

  /**
   * Parse a log file from the given byte offset.
   * @param filePath - Path to the log file
   * @param startOffset - Byte offset to start reading from
   * @param maxRecords - Optional maximum number of records to return (for shallow discovery)
   */
  protected abstract parseFile(
    filePath: string,
    startOffset: number,
    maxRecords?: number,
  ): Promise<ParseFileResult<TRecord>>;

  /**
   * Validate and filter parsed records. Default: returns records as-is.
   * @param records - Raw parsed records
   * @returns Validated/filtered records
   */
  protected validateRecords(records: TRecord[]): TRecord[] {
    return records;
  }

  /**
   * Returns the maximum number of records to parse per file.
   * Override in subclasses to limit parsing (e.g., discovery mode).
   * @returns Maximum record count, or `undefined` for no limit.
   */
  protected getMaxRecords(): number | undefined {
    return undefined;
  }

  /**
   * Builds the serialized session context for cursor persistence.
   * @param context - The import session context to serialize.
   * @returns Serialized cursor session context.
   */
  protected buildCursorSessionContext(
    context: LogImportSessionContext<TState>,
  ): NonNullable<ImportCursorPosition['sessionContext']> {
    const { adapterSessionId, sessionEvent, startedEvent, state, ...sessionMetadata } = context;
    return {
      ...sessionMetadata,
      adapterSessionId,
      sessionEvent,
      startedEvent,
      state: this.importer.serializeState(state),
    };
  }

  /**
   * Check if this orchestrator uses JSON format (mtime-based cursor).
   * @returns True if JSON format, false for JSONL
   */
  protected usesJsonFormat(): boolean {
    const pattern = this.getLogFilePattern();
    return pattern.includes('.json') && !pattern.includes('.jsonl');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public isRunning(): boolean {
    return this.watcher.isRunning();
  }

  public async start(): Promise<void> {
    if (!this.config.enabled || this.isRunning()) return;

    const logDir = this.config.directory ?? this.importer.getLogDirectory();
    console.info(`${this.logPrefix} Starting - watching ${logDir}`);

    this.stats.reset();
    this.managedSessionCache.clear();
    this.progressTimer = setInterval(() => this.stats.logProgress(this.logPrefix), PROGRESS_LOG_INTERVAL_MS);

    this.unsubscribeChange = this.watcher.onChange((event) => {
      this.trackFileChange(event);
    });

    this.unsubscribeError = this.watcher.onError(({ error, filePath }) => {
      console.warn(`${this.logPrefix} Error${filePath ? ` for ${filePath}` : ''}: ${error.message}`);
    });

    this.unsubscribeDeleted = this.watcher.onDeleted(({ filePath }) => {
      this.watcherTasks.track(
        MakaioBus.request(ImportCursorStorageSubjects.delete, { filePath })
          .then(() => undefined)
          .catch(() => {}),
      );
    });

    await this.watcher.start();
  }

  public async stop(): Promise<void> {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }

    this.unsubscribeChange?.();
    this.unsubscribeError?.();
    this.unsubscribeDeleted?.();
    this.unsubscribeChange = undefined;
    this.unsubscribeError = undefined;
    this.unsubscribeDeleted = undefined;

    this.watcher.stop();
    await this.watcherTasks.drain();
    await this.eventQueue.drain();

    if (this.stats.hasActivity()) {
      console.info(this.stats.stoppedMessage(this.logPrefix));
    }
  }

  public async dispose(): Promise<void> {
    await this.stop();
    this.watcher.dispose();
    this.managedSessionCache.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Static Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /** @returns Function that checks if a session is Makaio-managed. */
  public static createDefaultCheckMakaioManaged(): (sessionId: string) => Promise<boolean> {
    return createDefaultCheckMakaioManaged();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Protected Methods
  // ─────────────────────────────────────────────────────────────────────────────

  protected async updateCursor(
    filePath: string,
    bytesRead: number,
    mtime: Date,
    sessionContext?: ImportCursorPosition['sessionContext'],
  ): Promise<void> {
    await MakaioBus.request(ImportCursorStorageSubjects.set, {
      filePath,
      bytesRead,
      lastModified: mtime.toISOString(),
      sessionContext,
    });
  }

  /**
   * Handle a file-change event: resolve cursor state and route to first-read or
   * incremental-read as appropriate.
   *
   * Subclasses (e.g., {@link DiscoveryOrchestrator}) may override this method to
   * substitute an entirely different dispatch strategy.
   * @param event - File change event from the watcher
   */
  protected async handleFileChange(event: LogFileChangeEvent): Promise<void> {
    const { filePath, changeType, stat } = event;

    if (this.shouldSkipFile(filePath)) return;

    const isJsonFormat = this.usesJsonFormat();

    // Handle file rotation — delete cursor so we re-read from start
    if (changeType === 'rotated') {
      await MakaioBus.request(ImportCursorStorageSubjects.delete, { filePath }).catch(() => {});
    }

    const cursor = await getCursorWithMigration(filePath, isJsonFormat, event, (e) => this.trackFileChange(e));
    if (cursor === 'retry') return;

    const isIncremental = cursor?.sessionContext !== undefined;
    const startOffset = isIncremental ? (cursor?.bytesRead ?? 0) : 0;

    if (shouldSkipUnchangedFile(cursor?.lastModified, stat.mtime, isJsonFormat, changeType)) {
      return;
    }

    const parseResult = await this.parseFile(filePath, isJsonFormat ? 0 : startOffset, this.getMaxRecords());
    logParseErrors(this.logPrefix, filePath, parseResult.errors);
    this.stats.recordFileProcessed();

    const validRecords = this.validateRecords(parseResult.records);
    const bytesRead = parseResult.bytesRead ?? 0;

    if (validRecords.length === 0) {
      await this.maybeUpdateCursor(filePath, bytesRead, startOffset, stat.mtime, isJsonFormat, cursor?.sessionContext);
      return;
    }

    if (isIncremental && cursor?.sessionContext) {
      await this.handleIncrementalRead(
        filePath,
        validRecords,
        cursor.sessionContext,
        bytesRead,
        stat.mtime,
        isJsonFormat,
        startOffset,
      );
    } else {
      await this.handleFirstRead(filePath, validRecords, bytesRead, stat.mtime, isJsonFormat, startOffset);
    }
  }

  /**
   * Track a watcher-triggered file import so shutdown can wait for any cursor
   * work that the handler enqueues before draining the shared FIFO queue.
   * @param event - File change event to process
   */
  protected trackFileChange(event: LogFileChangeEvent): void {
    const change = this.handleFileChange(event).catch((error) => {
      console.error(
        `${this.logPrefix} Error handling file change:`,
        error instanceof Error ? error.message : String(error),
      );
    });
    this.watcherTasks.track(change);
  }

  /**
   * Handle the first read of a log file.
   *
   * Extracts session context, emits session lifecycle events, processes records,
   * and saves the cursor. Subclasses may override to change behavior (e.g.,
   * {@link DiscoveryOrchestrator} skips message processing).
   * @param filePath - Path to the log file
   * @param records - Records parsed from the file
   * @param bytesRead - Bytes read during this parse
   * @param mtime - File modification time
   * @param isJsonFormat - Whether the file uses JSON (mtime-based) format
   * @param startOffset - Byte offset this read started from
   * @param emitLifecycleEvents - Whether to emit session and started lifecycle events for this pass
   */
  protected async handleFirstRead(
    filePath: string,
    records: TRecord[],
    bytesRead: number,
    mtime: Date,
    isJsonFormat: boolean,
    startOffset: number,
    emitLifecycleEvents = true,
  ): Promise<void> {
    const context = this.importer.extractSessionContext(records);

    if (await this.isSessionSkipped(context.adapterSessionId)) {
      await this.maybeUpdateCursor(
        filePath,
        bytesRead,
        startOffset,
        mtime,
        isJsonFormat,
        this.buildCursorSessionContext(context),
      );
      return;
    }

    const eventPromises = buildFirstReadEventPromises(
      records,
      context,
      emitLifecycleEvents,
      (r, c) => this.importer.processRecords(r, c),
      (e) => this.queueEvent(e),
    );

    this.trackImportedSession(context.adapterSessionId);
    await this.queueCursorUpdate(
      filePath,
      bytesRead,
      startOffset,
      mtime,
      isJsonFormat,
      this.buildCursorSessionContext(context),
      eventPromises,
    );
  }

  /**
   * Record that a session has been imported, updating import statistics.
   *
   * Protected to allow subclasses to update stats when processing additional
   * sessions (e.g., compress child sessions from compacted files).
   * @param adapterSessionId - The session ID that was imported
   */
  protected trackImportedSession(adapterSessionId: string): void {
    this.stats.recordSessionImported(adapterSessionId);
  }

  /**
   * Handle an incremental read of a log file.
   *
   * Processes new records since the last cursor position. Subclasses may override
   * to skip incremental processing (e.g., {@link DiscoveryOrchestrator}).
   * @param filePath - Path to the log file
   * @param records - New records since last read
   * @param cursorContext - Existing cursor session context
   * @param bytesRead - Bytes read during this parse
   * @param mtime - File modification time
   * @param isJsonFormat - Whether the file uses JSON (mtime-based) format
   * @param startOffset - Byte offset this read started from
   */
  protected async handleIncrementalRead(
    filePath: string,
    records: TRecord[],
    cursorContext: NonNullable<ImportCursorPosition['sessionContext']>,
    bytesRead: number,
    mtime: Date,
    isJsonFormat: boolean,
    startOffset: number,
  ): Promise<void> {
    if (await this.isSessionSkipped(cursorContext.adapterSessionId)) {
      await this.maybeUpdateCursor(filePath, bytesRead, startOffset, mtime, isJsonFormat, cursorContext);
      return;
    }

    let deserializedState: TState;
    try {
      deserializedState = this.importer.deserializeState(cursorContext.state);
    } catch (error) {
      console.warn(
        `${this.logPrefix} Corrupted cursor state for ${filePath}, deleting cursor and re-importing.`,
        error instanceof Error ? error.message : String(error),
      );
      await MakaioBus.request(ImportCursorStorageSubjects.delete, { filePath }).catch((deleteError) => {
        console.warn(
          `${this.logPrefix} Failed to delete corrupted cursor for ${filePath}.`,
          deleteError instanceof Error ? deleteError.message : String(deleteError),
        );
      });
      await reParseAndHandleFirstRead(filePath, mtime, isJsonFormat, true, this.logPrefix, {
        parseFile: (fp, offset) => this.parseFile(fp, offset),
        validateRecords: (r) => this.validateRecords(r),
        handleFirstRead: (fp, r, br, mt, json, so, elc) => this.handleFirstRead(fp, r, br, mt, json, so, elc),
      });
      return;
    }

    const context: LogImportSessionContext<TState> = {
      adapterSessionId: cursorContext.adapterSessionId,
      model: cursorContext.model,
      cwd: cursorContext.cwd,
      sessionEvent: cursorContext.sessionEvent,
      startedEvent: cursorContext.startedEvent,
      state: deserializedState,
    };

    // Process records first so state mutations (e.g. compactionDetected) are visible
    // before any events are queued — the compaction path discards events entirely.
    const messageEvents = this.importer.processRecords(records, context);

    if (detectCompactionInState(context.state)) {
      await reParseAndHandleFirstRead(filePath, mtime, isJsonFormat, false, this.logPrefix, {
        parseFile: (fp, offset) => this.parseFile(fp, offset),
        validateRecords: (r) => this.validateRecords(r),
        handleFirstRead: (fp, r, br, mt, json, so, elc) => this.handleFirstRead(fp, r, br, mt, json, so, elc),
      });
      return;
    }

    const eventPromises = buildIncrementalReadEventPromises(messageEvents, (e) => this.queueEvent(e));

    const updatedCursorContext = buildIncrementalCursorContext(cursorContext, context.state, (s) =>
      this.importer.serializeState(s),
    );

    await this.queueCursorUpdate(
      filePath,
      bytesRead,
      startOffset,
      mtime,
      isJsonFormat,
      updatedCursorContext,
      eventPromises,
    );
  }

  protected async maybeUpdateCursor(
    filePath: string,
    bytesRead: number,
    startOffset: number,
    mtime: Date,
    isJsonFormat: boolean,
    sessionContext?: ImportCursorPosition['sessionContext'],
  ): Promise<void> {
    if (bytesRead > startOffset || isJsonFormat) {
      await this.updateCursor(filePath, bytesRead, mtime, sessionContext);
    }
  }

  /**
   * Determine whether an adapter session should be skipped from import.
   *
   * Delegates to the managed-session cache so concurrent checks for the same
   * `adapterSessionId` share one storage lookup and tracked skips update stats.
   * @param adapterSessionId - External adapter session ID being evaluated
   * @returns Promise resolving to true when the session is Makaio-managed and should be skipped
   */
  protected async isSessionSkipped(adapterSessionId: string): Promise<boolean> {
    return this.managedSessionCache.isSkipped(
      adapterSessionId,
      (sessionId) => this.importer.isMakaioManaged(sessionId),
      (sessionId) => this.stats.recordSessionSkipped(sessionId),
    );
  }

  /**
   * Queue a normalized event and return its delivery promise.
   * @param event - Normalized event to emit
   * @returns Promise that resolves after delivery or rejects on emit failure
   */
  protected queueEvent(event: NormalizedEvent): Promise<void> {
    return this.eventQueue.queueEvent(event);
  }

  /**
   * Enqueue a cursor write as a PQueue task so it executes after all previously
   * queued events for the same batch have been emitted.
   *
   * PQueue runs tasks with concurrency=1 in FIFO order, so placing the cursor
   * write at the back of the queue after all `queueEvent` calls guarantees that
   * the cursor advances only once every preceding event in the batch has been
   * delivered. This prevents the race where a process exit after `queueEvent`
   * but before queue drain would leave events lost yet the cursor advanced.
   * @param filePath - Path to the log file
   * @param bytesRead - Total bytes read at the new cursor position
   * @param startOffset - Byte offset this read started from
   * @param mtime - File modification time
   * @param isJsonFormat - Whether the file uses JSON (mtime-based) format
   * @param sessionContext - Serialized session context for the cursor
   * @param precedingEventPromises - Emission promises queued before this cursor write
   * @returns Promise that resolves when the cursor write has completed
   */
  protected queueCursorUpdate(
    filePath: string,
    bytesRead: number,
    startOffset: number,
    mtime: Date,
    isJsonFormat: boolean,
    sessionContext?: ImportCursorPosition['sessionContext'],
    precedingEventPromises: Promise<void>[] = [],
  ): Promise<void> {
    return this.eventQueue.queueAfterEvents(
      () => this.maybeUpdateCursor(filePath, bytesRead, startOffset, mtime, isJsonFormat, sessionContext),
      precedingEventPromises,
    );
  }
}
