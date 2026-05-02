import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Emittery from 'emittery';
import { globby } from 'globby';
import type { FileWatcherCursor } from './types.js';

/**
 * Default polling interval in milliseconds.
 * @remarks
 * 10 seconds provides a balance between responsiveness and system load.
 * Can be overridden via {@link FileWatcherOptions.pollIntervalMs}.
 */
const DEFAULT_POLL_INTERVAL_MS = 10000;

/**
 * Configuration options for the file watcher.
 * @remarks
 * The watcher polls a directory at regular intervals, discovering files
 * matching the glob pattern and tracking their modification times.
 * @see {@link LogFileWatcher} - The watcher implementation
 */
export interface FileWatcherOptions {
  /**
   * Directory to watch for log files.
   * Must be an absolute path.
   */
  directory: string;

  /**
   * Glob pattern for file discovery.
   * @example '*.jsonl' - Match JSONL files in directory
   * @example '**\/*.jsonl' - Match JSONL files recursively
   */
  pattern: string;

  /**
   * Polling interval in milliseconds.
   * @defaultValue 10000 (10 seconds)
   */
  pollIntervalMs?: number;
}

/**
 * Type of change detected for a file.
 * @remarks
 * - `created`: File is new (not previously tracked)
 * - `modified`: File mtime changed and size is \>= previous
 * - `rotated`: File mtime changed but size is smaller (log rotation)
 */
export type FileChangeType = 'created' | 'modified' | 'rotated';

/**
 * Event emitted when a file change is detected.
 * @remarks
 * The consumer should use this information to decide how to process the file:
 * - `created`/`modified`: Read from cursor position (or beginning if no cursor)
 * - `rotated`: Clear cursor and re-read from beginning
 * @see {@link LogFileWatcher} - Emitter of these events
 * @see {@link FileWatcherCursor} - Related cursor tracking
 */
export interface FileChangeEvent {
  /** Absolute path to the changed file */
  filePath: string;

  /** Current file stats (size and mtime) */
  stat: {
    /** File size in bytes */
    size: number;
    /** Last modification time */
    mtime: Date;
  };

  /** Type of change detected */
  changeType: FileChangeType;
}

/**
 * Event emitted when a tracked file is deleted.
 * @see {@link LogFileWatcher} - Emitter of these events
 */
export interface FileDeletedEvent {
  /** Absolute path to the deleted file */
  filePath: string;
}

/**
 * Event emitted after a full poll cycle completes.
 */
export interface FileWatcherPolledEvent {
  /**
   * File paths present after deletions were pruned for the current cycle.
   */
  trackedFilePaths: ReadonlySet<string>;
}

/**
 * Typed events for the file watcher.
 * @see {@link LogFileWatcher} - Uses these event types via Emittery
 */
export interface FileWatcherEvents {
  /**
   * Emitted when a file is created, modified, or rotated.
   * Handlers receive a {@link FileChangeEvent} with file details.
   */
  change: FileChangeEvent;

  /**
   * Emitted when a tracked file is deleted.
   * Handlers should clean up any associated state (cursors, etc.).
   */
  deleted: FileDeletedEvent;

  /**
   * Emitted when the watcher encounters an error.
   * Non-fatal errors (e.g., permission denied on single file) are logged
   * but don't stop the watcher.
   */
  error: { error: Error; filePath?: string };

  /**
   * Emitted after each complete poll cycle, regardless of whether any files changed.
   *
   * Seam for consumers that need to react to poll ticks (e.g., tracking timeout
   * detection). Provides the set of file paths observed in this poll cycle.
   * @remarks
   * The `trackedFilePaths` set reflects all files present after deletions are
   * pruned for this poll cycle. Consumers implementing inactivity logic should
   * compare current mtimes against their own stored value using this post-prune set.
   */
  polled: FileWatcherPolledEvent;
}

/**
 * State tracked for a discovered file.
 *
 * Exposed as a named package contract because orchestrators need to compare
 * mtime progress across poll cycles without depending on an anonymous internal
 * shape.
 */
export interface FileWatcherTrackedFileState {
  /** Last known file size in bytes */
  size: number;
  /** Last known modification time in milliseconds since the Unix epoch */
  mtimeMs: number;
}

/**
 * Watches directories for log file changes using polling.
 *
 * ## Why Polling Over fs.watch/chokidar?
 *
 * Polling was chosen for: (1) cross-platform reliability (fs.watch varies across OS),
 * (2) network filesystem support (NFS/CIFS), (3) simpler error handling (no reconnection
 * logic), (4) controllable resource usage, (5) natural rotation detection via mtime+size.
 * For ~10s polling on session logs, the latency tradeoff is acceptable.
 * @remarks
 * Emits 'change' for created/modified/rotated files, 'deleted' for removed files.
 * Use {@link dispose} for full cleanup, {@link stop} to pause while preserving state.
 * @example
 * ```typescript
 * const watcher = new LogFileWatcher({ directory: '/logs', pattern: '*.jsonl' });
 * watcher.on('change', (e) => console.log(e.changeType, e.filePath));
 * watcher.on('deleted', (e) => console.log('deleted', e.filePath));
 * await watcher.start();
 * // Later: watcher.dispose();
 * ```
 * @see {@link FileWatcherOptions} - Configuration options
 * @see {@link FileChangeEvent} - Change event details
 */
export class LogFileWatcher {
  private readonly options: Required<FileWatcherOptions>;
  private readonly emittery = new Emittery<FileWatcherEvents>();

  /** Tracked state per file path */
  private readonly trackedFiles = new Map<string, FileWatcherTrackedFileState>();

  /** Timer handle for polling, undefined when stopped */
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** Flag to prevent concurrent poll execution */
  private isPolling = false;

  /** Lifecycle guard preventing post-dispose state mutation or event emission. */
  private isDisposed = false;

  /**
   * File paths currently undergoing an immediate single-file check.
   *
   * Immediate polls are a fast path for active files, not a separate work queue.
   * At most one in-flight check per file preserves the same state machine as the
   * normal poll loop and avoids duplicate change/error emission.
   */
  private readonly inFlightChecks = new Map<string, Promise<void>>();

  /**
   * Create a new file watcher.
   * @param options - Watcher configuration
   * @throws Error if directory is not an absolute path
   */
  public constructor(options: FileWatcherOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error(`Directory must be an absolute path: ${options.directory}`);
    }

    this.options = {
      directory: options.directory,
      pattern: options.pattern,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    };
  }

  /**
   * Subscribe to file change events.
   * @param event - Event type to subscribe to ('change' or 'error')
   * @param handler - Called when a file is created, modified, or rotated
   * @returns Unsubscribe function
   */
  public on<Event extends keyof FileWatcherEvents>(
    event: Event,
    handler: (data: FileWatcherEvents[Event]) => void | Promise<void>,
  ): () => void {
    return this.emittery.on(event, handler);
  }

  /**
   * Wait for a single event matching an optional predicate.
   * @param event - Event type to wait for
   * @param predicate - Optional filter function
   * @returns Promise resolving to the event data
   */
  public once<Event extends keyof FileWatcherEvents>(
    event: Event,
    predicate?: (data: FileWatcherEvents[Event]) => boolean,
  ): Promise<FileWatcherEvents[Event]> {
    return this.emittery.once(event, predicate);
  }

  /**
   * Start watching the directory.
   * @remarks
   * Performs an initial poll immediately, then schedules recurring polls.
   * Does nothing if already started.
   */
  public async start(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    if (this.pollTimer !== undefined) {
      return; // Already running
    }

    // Initial poll
    await this.poll();

    // Schedule recurring polls
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  /**
   * Stop watching the directory.
   * @remarks
   * Clears the polling timer but preserves tracked file state.
   * Safe to call multiple times or when not started.
   * @see {@link dispose} - For complete cleanup including event listeners
   */
  public stop(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Fully dispose the watcher - stops polling, clears listeners and tracked state.
   * Instance should not be reused after dispose. Use {@link stop} to pause instead.
   */
  public dispose(): void {
    this.isDisposed = true;
    this.stop();
    this.emittery.clearListeners();
    this.trackedFiles.clear();
    this.inFlightChecks.clear();
  }

  /**
   * Check if the watcher is currently running.
   * @returns True if started and not stopped
   */
  public isRunning(): boolean {
    return this.pollTimer !== undefined;
  }

  /**
   * Get the current set of tracked files.
   * @remarks
   * Useful for debugging or inspecting watcher state.
   * @returns Map of file paths to their tracked state
   */
  public getTrackedFiles(): ReadonlyMap<string, Readonly<FileWatcherTrackedFileState>> {
    return this.trackedFiles;
  }

  /**
   * Initialize tracked state from existing cursors.
   * @remarks
   * Call this before start() to seed the watcher with known cursor positions.
   * Files with existing cursors will only emit 'modified' events when they
   * change, rather than 'created' events on first detection.
   * @param cursors - Array of cursor positions to seed
   */
  public seedFromCursors(cursors: FileWatcherCursor[]): void {
    for (const cursor of cursors) {
      this.trackedFiles.set(cursor.filePath, {
        size: cursor.bytesRead,
        mtimeMs: new Date(cursor.lastModified).getTime(),
      });
    }
  }

  /**
   * Perform a single poll of the directory.
   * @remarks
   * Discovers files matching the pattern, compares against tracked state,
   * and emits events for changes. Also detects deleted files (tracked but
   * no longer present) and emits 'deleted' events. Handles errors gracefully
   * to avoid stopping the watcher due to transient issues.
   */
  private async poll(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    // Prevent concurrent polls (if previous poll is slow)
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      // Discover files matching pattern
      const files = await this.discoverFiles();
      const discoveredSet = new Set(files);

      // Detect deleted files: tracked but no longer discovered
      for (const trackedPath of this.trackedFiles.keys()) {
        if (!discoveredSet.has(trackedPath)) {
          if (this.isDisposed) {
            return;
          }
          this.trackedFiles.delete(trackedPath);
          await this.emittery.emit('deleted', { filePath: trackedPath });
        }
      }

      // Check each file for changes
      for (const filePath of files) {
        try {
          await this.runFileCheck(filePath);
        } catch (error) {
          // Non-fatal: emit error event and continue with other files
          await this.emitWatcherError(error, filePath);
        }
      }

      // Notify consumers that a full poll cycle completed (seam for inactivity tracking)
      if (this.isDisposed) {
        return;
      }
      await this.emittery.emit('polled', { trackedFilePaths: new Set(this.trackedFiles.keys()) });
    } catch (error) {
      // Fatal error in discovery (e.g., directory doesn't exist)
      await this.emitWatcherError(error);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Discover files matching the configured pattern.
   * @returns Array of absolute file paths
   */
  private async discoverFiles(): Promise<string[]> {
    return globby(this.options.pattern, {
      cwd: this.options.directory,
      absolute: true,
      onlyFiles: true,
    });
  }

  /**
   * Check a single file for changes and emit events if needed.
   * @param filePath - Absolute path to the file
   */
  private async checkFile(filePath: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const stat = await fs.stat(filePath);
    if (this.isDisposed) {
      return;
    }

    const currentState: FileWatcherTrackedFileState = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };

    const previousState = this.trackedFiles.get(filePath);

    if (!previousState) {
      // New file - emit created event
      this.trackedFiles.set(filePath, currentState);
      if (this.isDisposed) {
        this.trackedFiles.delete(filePath);
        return;
      }
      await this.emittery.emit('change', {
        filePath,
        stat: { size: stat.size, mtime: stat.mtime },
        changeType: 'created',
      });
      return;
    }

    // Check if file has changed (mtime is different)
    if (currentState.mtimeMs !== previousState.mtimeMs) {
      // Determine change type based on size
      const changeType: FileChangeType = currentState.size < previousState.size ? 'rotated' : 'modified';

      this.trackedFiles.set(filePath, currentState);
      if (this.isDisposed) {
        return;
      }
      await this.emittery.emit('change', {
        filePath,
        stat: { size: stat.size, mtime: stat.mtime },
        changeType,
      });
    }
  }

  /**
   * Clear tracked state for a specific file.
   * @remarks
   * Useful when a file is deleted or when forcing a re-scan.
   * The file will be treated as 'created' on next detection.
   * @param filePath - Absolute path to the file
   * @returns True if the file was tracked and removed
   */
  public clearTrackedFile(filePath: string): boolean {
    return this.trackedFiles.delete(filePath);
  }

  /**
   * Clear all tracked file state.
   * @remarks
   * All files will be treated as 'created' on next poll.
   */
  public clearAllTrackedFiles(): void {
    this.trackedFiles.clear();
  }

  /**
   * Schedule an immediate poll for a specific file.
   * @remarks
   * **Seam for future optimization.** The current implementation invokes
   * `runFileCheck` for the given path, reusing the same per-file in-flight
   * gating as the regular poll loop while still bypassing the normal poll interval.
   * A future implementation could maintain a priority queue of files needing
   * immediate attention (e.g., for actively tracked sessions that receive new
   * writes) and process them at a shorter interval (e.g., 2s) while leaving
   * the global poll interval unchanged for other files.
   *
   * Safe to call for paths not currently tracked — emits a `change` event
   * with `changeType: 'created'` on first detection.
   * @param filePath - Absolute path to the file to poll immediately
   */
  public triggerImmediatePoll(filePath: string): void {
    void this.runFileCheck(filePath).catch((error) => {
      void this.emitWatcherError(error, filePath);
    });
  }

  /**
   * Execute a single-file change check unless that file is already in flight.
   *
   * Poll and immediate checks share this gate so the same file cannot be
   * processed concurrently through different entry points.
   * @param filePath - Absolute path to the file being checked
   */
  private async runFileCheck(filePath: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const inFlight = this.inFlightChecks.get(filePath);
    if (inFlight) {
      await inFlight;
      return;
    }

    const checkPromise = (async () => {
      try {
        await this.checkFile(filePath);
      } finally {
        this.inFlightChecks.delete(filePath);
      }
    })();
    this.inFlightChecks.set(filePath, checkPromise);
    await checkPromise;
  }

  /**
   * Normalize and emit watcher errors through the single error channel.
   * @param error - Unknown error raised during file discovery or checking
   * @param filePath - Optional file associated with the error
   */
  private async emitWatcherError(error: unknown, filePath?: string): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    try {
      await this.emittery.emit('error', { error: normalizedError, filePath });
    } catch (emitError) {
      console.error(
        '[LogFileWatcher] Error listener failed:',
        emitError instanceof Error ? emitError.message : String(emitError),
      );
    }
  }
}
