/**
 * Discovery orchestrator for shallow session discovery.
 *
 * Overrides `handleFileChange` to bypass the full parse pipeline, using
 * `extractDiscoveryMetadata` for optimized lightweight discovery. Full message
 * processing is deferred until the user triggers lazy-load import.
 *
 * Once a session is imported, this orchestrator also handles incremental
 * message ingestion for active (modified) files, transitioning the adapter
 * session status between `'imported'` and `'tracking'` as files change or
 * become inactive.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterSessionStorageSubjects } from '@makaio/services-core/session';

import type { LogImporter } from './types.js';
import { BaseLogOrchestrator } from './base-orchestrator.js';
import type { LogOrchestratorConfig } from './base-orchestrator.js';
import { ImportCursorStorageSubjects } from './cursor-storage.js';
import type { LogFileChangeEvent } from './log-import-watcher.js';

/**
 * Number of consecutive no-change polls before a `'tracking'` session reverts
 * to `'imported'`. At the default 10s poll interval this equals ~30s of inactivity.
 */
const TRACKING_INACTIVE_THRESHOLD = 3;

/**
 * Abstract discovery orchestrator for shallow session discovery.
 *
 * Overrides `handleFileChange` to call `importer.extractDiscoveryMetadata(filePath)`
 * directly, bypassing the parseFile → validateRecords → extractSessionContext pipeline.
 * Emits only `adapter.session.discovered` and saves a stub cursor (bytesRead: 0)
 * so the full import starts from byte 0 when the user triggers lazy-load pick-up.
 *
 * For files that have already been imported, the orchestrator delegates `'modified'`
 * events to the base class for incremental processing and manages the
 * `'imported' ↔ 'tracking'` status lifecycle.
 * @typeParam TRecord - The adapter's native log record type
 * @typeParam TState - The adapter's resumable state type (default: unknown)
 * @see {@link BaseLogOrchestrator} - Parent class with full import behavior
 */
export abstract class DiscoveryOrchestrator<TRecord, TState = unknown> extends BaseLogOrchestrator<TRecord, TState> {
  /**
   * Paths of files whose adapter sessions are currently in `'tracking'` status.
   * Maintained locally to avoid per-poll DB lookups.
   */
  protected readonly trackingFilePaths = new Set<string>();

  /**
   * Per-file count of consecutive poll cycles with no mtime change while in
   * `'tracking'` status. Reset on each `'modified'` event; incremented by the
   * `polled` handler when mtime is unchanged.
   */
  protected readonly trackingInactiveCount = new Map<string, number>();

  /**
   * Last observed mtime (ms) per tracked file path.
   * Used by the `polled` handler to detect inactivity without re-reading disk.
   */
  protected readonly lastSeenMtimeMs = new Map<string, number>();

  /** Cleanup for the `polled` event subscription. */
  private unsubscribePolled?: () => void;

  protected constructor(config: LogOrchestratorConfig, importer: LogImporter<TRecord, TState>) {
    super(config, importer);
  }

  /**
   * Clear all in-memory tracking collections for a single file path.
   * @param filePath - File path to remove from local tracking state
   */
  protected clearTrackingState(filePath: string): void {
    this.trackingFilePaths.delete(filePath);
    this.trackingInactiveCount.delete(filePath);
    this.lastSeenMtimeMs.delete(filePath);
  }

  /**
   * Persist the steady-state imported status for a tracked file.
   * @param filePath - Absolute path to the tracked log file
   * @returns `true` when the file can be removed from local tracking state
   */
  protected async persistImportedStatus(filePath: string): Promise<boolean> {
    const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.getByLogFilePath, {
      logFilePath: filePath,
    });

    if (!session || session.status !== 'tracking') {
      return true;
    }

    const statusUpdate = await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
      adapterSessionId: session.adapterSessionId,
      status: 'imported',
    });
    if (!statusUpdate.success) {
      console.warn(`${this.logPrefix} Failed to persist imported status for ${filePath}`);
      return false;
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  public override async start(): Promise<void> {
    if (!this.isEnabled() || this.isRunning()) {
      return;
    }

    await super.start();
    this.unsubscribePolled = this.watcher.onPolled((trackedFilePaths) => {
      void this.onPollCycle(trackedFilePaths).catch((error) => {
        console.error(
          `${this.logPrefix} Error handling poll cycle:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    });
    await this.restorePersistedTrackingState();
  }

  public override async stop(): Promise<void> {
    this.unsubscribePolled?.();
    this.unsubscribePolled = undefined;
    await super.stop();
  }

  public override async dispose(): Promise<void> {
    this.trackingFilePaths.clear();
    this.trackingInactiveCount.clear();
    this.lastSeenMtimeMs.clear();
    await super.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Abstract contract
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Simplified file change handler for discovery mode.
   *
   * Dispatches to two paths:
   * 1. No cursor exists → lightweight discovery (emit `adapter.session.discovered`,
   *    write stub cursor).
   * 2. Cursor exists + `changeType === 'modified'` + session status is `'imported'`
   *    or `'tracking'` → delegate to base class for incremental import, then
   *    transition status to `'tracking'` if it was `'imported'`.
   *
   * All other cases (e.g., cursor exists but status is `'discovered'`, or
   * `changeType` is not `'modified'`) are silently skipped.
   * @param event - File change event from the watcher
   */
  protected override async handleFileChange(event: LogFileChangeEvent): Promise<void> {
    const { filePath, changeType, stat } = event;

    if (this.shouldSkipFile(filePath)) {
      return;
    }

    const { cursor } = await MakaioBus.request(ImportCursorStorageSubjects.get, { filePath });

    if (!cursor) {
      // New file — run lightweight discovery
      await this.discoverNewFile(event);
      return;
    }

    if (changeType === 'modified') {
      await this.handleModifiedImportedFile(filePath, event, stat.mtime);
    }
    // changeType 'created' with existing cursor or 'rotated': skip
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Rehydrate `tracking` file state from persisted adapter-session rows after startup.
   *
   * The watcher state is process-local, but adapter-session status is persisted.
   * Without this rehydration, a restart can strand sessions in `'tracking'` forever
   * because no in-memory file state exists to drive the inactivity timeout.
   */
  protected async restorePersistedTrackingState(): Promise<void> {
    this.trackingFilePaths.clear();
    this.trackingInactiveCount.clear();
    this.lastSeenMtimeMs.clear();

    try {
      const { sessions } = await MakaioBus.request(AdapterSessionStorageSubjects.list, {});
      for (const session of sessions) {
        if (session.status !== 'tracking' || !session.logFilePath) {
          continue;
        }
        const trackedMtimeMs = this.watcher.getTrackedFileMtimeMs(session.logFilePath);
        if (trackedMtimeMs === undefined) {
          continue;
        }
        this.trackingFilePaths.add(session.logFilePath);
        this.trackingInactiveCount.set(session.logFilePath, 0);
        this.lastSeenMtimeMs.set(session.logFilePath, trackedMtimeMs);
      }
    } catch (error) {
      console.warn(
        '[DiscoveryOrchestrator] Failed to restore persisted tracking state:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Perform shallow discovery for a newly seen file.
   *
   * Calls `importer.extractDiscoveryMetadata`, skips Makaio-managed sessions,
   * emits `adapter.session.discovered`, and writes a stub cursor (bytesRead=0).
   * @param event - File change event for the new file
   */
  private async discoverNewFile(event: LogFileChangeEvent): Promise<void> {
    const { filePath, stat } = event;

    // Lightweight metadata extraction — adapter does its own optimised I/O
    const metadata = await this.importer.extractDiscoveryMetadata(filePath);

    // Skip files with no importable messages (e.g. only system/metadata records)
    // Write stub cursor so the watcher doesn't re-check on every poll cycle.
    if (!(metadata.hasMessages ?? false)) {
      await this.updateCursor(filePath, 0, stat.mtime);
      return;
    }

    // Skip sessions already managed by Makaio — write stub cursor to avoid re-checking
    if (await this.isSessionSkipped(metadata.adapterSessionId)) {
      await this.updateCursor(filePath, 0, stat.mtime);
      return;
    }

    // Emit adapter.session.discovered event
    const discoveredEvent = this.queueEvent({
      subject: AdapterSubjects.session.discovered,
      payload: {
        adapterId: this.config.adapterId,
        adapterName: this.config.adapterName,
        adapterSessionId: metadata.adapterSessionId,
        model: metadata.model ?? null,
        cwd: metadata.cwd ?? null,
        title: metadata.title,
        parentAdapterSessionId: metadata.parentAdapterSessionId ?? null,
        forkPointMessageId: metadata.forkPointMessageId ?? null,
        kind: metadata.kind ?? 'root',
        startedAt: metadata.startedAt,
        logFilePath: filePath,
      },
    });

    // Stub cursor: bytesRead=0 signals lazy-load to import from byte 0.
    // Enqueued after the discovered event so the cursor advances only once
    // the event has been emitted (FIFO guarantee from PQueue concurrency=1).
    // Uses updateCursor directly (not queueCursorUpdate) because stub cursors
    // always write bytesRead=0 unconditionally — not subject to the
    // maybeUpdateCursor guard that skips writes when bytesRead <= startOffset.
    await this.eventQueue.queueAfterEvents(() => this.updateCursor(filePath, 0, stat.mtime), [discoveredEvent]);
  }

  /**
   * Handle a `'modified'` event for a file whose session is already imported.
   *
   * Looks up the adapter session by file path. If the session status is
   * `'imported'` or `'tracking'`, delegates to the base class for incremental
   * processing. Transitions status from `'imported'` to `'tracking'` on success.
   *
   * Sessions with status `'discovered'` (not yet fully imported) are skipped —
   * the cursor only has `bytesRead=0` and no `sessionContext`, so incremental
   * import cannot resume.
   * @param filePath - Absolute path to the log file
   * @param event - Full file change event (passed to super)
   * @param mtime - Current file modification time
   */
  private async handleModifiedImportedFile(filePath: string, event: LogFileChangeEvent, mtime: Date): Promise<void> {
    const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.getByLogFilePath, {
      logFilePath: filePath,
    });

    if (!session) {
      // Discovery can legitimately see a file before it has importable messages.
      // Re-enter lightweight discovery so a later modification can surface it.
      await this.discoverNewFile(event);
      return;
    }

    if (session.status !== 'imported' && session.status !== 'tracking') {
      // Not yet imported, or not an import-tracked session — skip
      return;
    }

    // Delegate to base class for incremental import (cursor has sessionContext from full import)
    await super.handleFileChange(event);

    // Transition to 'tracking' if the session was previously just 'imported'
    if (session.status === 'imported') {
      const statusUpdate = await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: session.adapterSessionId,
        status: 'tracking',
      });
      if (!statusUpdate.success) {
        console.warn(`${this.logPrefix} Failed to persist tracking status for ${filePath}`);
        return;
      }
    }

    this.trackingFilePaths.add(filePath);
    // Only mark the file as active after incremental import succeeded.
    this.lastSeenMtimeMs.set(filePath, mtime.getTime());
    this.trackingInactiveCount.delete(filePath);

    // Trigger an immediate re-check so rapid writes are caught without waiting
    // for the next poll interval.
    this.watcher.triggerImmediatePoll(filePath);
  }

  /**
   * React to a completed poll cycle for inactivity-based `tracking → imported` transitions.
   *
   * For each file in `trackingFilePaths`, checks if the watcher's last-known mtime
   * matches our stored `lastSeenMtimeMs`. If unchanged, increments the inactive
   * counter. When the counter reaches the tracking inactivity threshold, the
   * adapter session reverts to `'imported'` and the file is removed from tracking.
   * @param trackedFilePaths - All file paths observed by the watcher in this cycle
   */
  protected async onPollCycle(trackedFilePaths: ReadonlySet<string>): Promise<void> {
    for (const filePath of [...this.trackingFilePaths]) {
      if (!trackedFilePaths.has(filePath)) {
        // File disappeared — only drop local state after the persisted status rolls back.
        if (await this.persistImportedStatus(filePath)) {
          this.clearTrackingState(filePath);
        }
        continue;
      }

      const trackedMtimeMs = this.watcher.getTrackedFileMtimeMs(filePath);
      const lastSeen = this.lastSeenMtimeMs.get(filePath);

      if (trackedMtimeMs === undefined || lastSeen === undefined) {
        continue;
      }

      try {
        if (trackedMtimeMs === lastSeen) {
          // mtime unchanged since last modification event — increment inactive counter
          const count = (this.trackingInactiveCount.get(filePath) ?? 0) + 1;

          if (count >= TRACKING_INACTIVE_THRESHOLD) {
            // Sufficient inactivity — revert to 'imported'
            if (await this.persistImportedStatus(filePath)) {
              this.clearTrackingState(filePath);
            }
          } else {
            this.trackingInactiveCount.set(filePath, count);
          }
        } else {
          // mtime changed — a 'modified' event will have already reset the counter
          // (handled in handleModifiedImportedFile). Just update our reference.
          this.lastSeenMtimeMs.set(filePath, trackedMtimeMs);
          this.trackingInactiveCount.delete(filePath);
        }
      } catch (error) {
        console.warn(
          `${this.logPrefix} Failed to process tracked file ${filePath}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
