import { LogFileWatcher as RuntimeLogFileWatcher } from '@makaio/file-watcher';

import type { ImportCursorPosition } from './types.js';

export interface LogFileChangeEvent {
  /** Absolute path to the changed file. */
  filePath: string;
  /** Current file stats needed for cursor and rotation handling. */
  stat: {
    /** File size in bytes. */
    size: number;
    /** Last modification time. */
    mtime: Date;
  };
  /** Type of change detected by the watcher. */
  changeType: 'created' | 'modified' | 'rotated';
}

export interface LogImportWatcherOptions {
  /** Directory to watch for log files. */
  directory: string;
  /** Glob pattern used to discover log files. */
  pattern: string;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
}

/**
 * Adapter-log watcher facade used by orchestrators.
 *
 * Keeps the concrete file-watcher package out of the exported orchestrator API,
 * while preserving the small operations subclasses need for discovery tracking.
 */
export class LogImportWatcher {
  private readonly watcher: RuntimeLogFileWatcher;

  public constructor(options: LogImportWatcherOptions) {
    this.watcher = new RuntimeLogFileWatcher(options);
  }

  /** @returns True when the underlying watcher is actively polling. */
  public isRunning(): boolean {
    return this.watcher.isRunning();
  }

  /** Start watching the configured log directory. */
  public async start(): Promise<void> {
    await this.watcher.start();
  }

  /** Stop watching while preserving tracked file state. */
  public stop(): void {
    this.watcher.stop();
  }

  /** Dispose watcher resources and listeners. */
  public dispose(): void {
    this.watcher.dispose();
  }

  /**
   * Subscribe to file change events.
   * @param handler - Callback receiving a log file change event.
   * @returns Function that unsubscribes the handler.
   */
  public onChange(handler: (event: LogFileChangeEvent) => void | Promise<void>): () => void {
    return this.watcher.on('change', handler);
  }

  /**
   * Subscribe to watcher errors.
   * @param handler - Callback receiving the error and optional file path.
   * @returns Function that unsubscribes the handler.
   */
  public onError(handler: (event: { error: Error; filePath?: string }) => void | Promise<void>): () => void {
    return this.watcher.on('error', handler);
  }

  /**
   * Subscribe to tracked-file deletion events.
   * @param handler - Callback receiving the deleted file path.
   * @returns Function that unsubscribes the handler.
   */
  public onDeleted(handler: (event: { filePath: string }) => void | Promise<void>): () => void {
    return this.watcher.on('deleted', handler);
  }

  /**
   * Subscribe to completed watcher poll cycles.
   * @param handler - Callback receiving the current tracked file path set.
   * @returns Function that unsubscribes the poll handler.
   */
  public onPolled(handler: (trackedFilePaths: ReadonlySet<string>) => void | Promise<void>): () => void {
    return this.watcher.on('polled', ({ trackedFilePaths }) => handler(trackedFilePaths));
  }

  /**
   * Read the watcher's last observed mtime for a file.
   * @param filePath - Absolute path to inspect.
   * @returns Last observed mtime in milliseconds, or undefined when untracked.
   */
  public getTrackedFileMtimeMs(filePath: string): number | undefined {
    return this.watcher.getTrackedFiles().get(filePath)?.mtimeMs;
  }

  /**
   * Schedule a single-file watcher poll.
   * @param filePath - Absolute path to poll immediately.
   */
  public triggerImmediatePoll(filePath: string): void {
    this.watcher.triggerImmediatePoll(filePath);
  }

  /**
   * Seed watcher state from persisted cursor positions.
   * @param cursors - Cursor positions used to initialize tracked file state.
   */
  public seedFromCursors(cursors: Array<Pick<ImportCursorPosition, 'filePath' | 'bytesRead' | 'lastModified'>>): void {
    this.watcher.seedFromCursors(cursors);
  }
}
