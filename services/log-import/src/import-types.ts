/** Shared types for the log-import pipeline. @packageDocumentation */

import type { TurnIngestionMarker } from '@makaio/contracts';

/** Result of a file import operation. */
export interface ImportFromFileContentResult {
  /** Makaio session ID that was populated. */
  sessionId: string;
  /** Number of messages written (created + already-present). */
  messageCount: number;
  /**
   * Number of NEWLY created turns across the segment tree in this call.
   * Re-imported turns (anchor already present) do not count.
   */
  turnCount: number;
}

/** Session context required to persist an imported segment tree. */
export interface ImportSegmentTreeContext {
  /** Owning adapter instance ID. */
  adapterId: string;
  /** Canonical adapter name used for linkage. */
  adapterName: string;
  /** Optional model metadata captured during import. */
  model: string | null;
  /** Optional working directory metadata captured during import. */
  cwd: string | null;
  /** Log file path on disk; only the root segment owns it. */
  logFilePath?: string | null;
  /**
   * Marker stamped on the `session.turn.*` events emitted for ingested turns.
   * Defaults to `'backfill'` (historical/watcher imports); hook-triggered
   * live ingestion passes `'live'`.
   */
  ingestionMarker?: TurnIngestionMarker;
}

/** Result returned after persisting an imported segment subtree. */
export interface ImportSegmentTreeResult {
  /** Makaio session ID created or reused for the imported segment. */
  sessionId: string;
  /** Total messages persisted across the segment subtree. */
  messageCount: number;
  /**
   * Number of NEWLY created turns across the segment subtree in this call.
   * Re-imported turns (anchor already present) do not count.
   */
  turnCount: number;
}

/** Minimal caller context required to persist a processed import result tree. */
export interface PersistImportResultContext {
  /** Owning adapter instance ID. */
  adapterId: string;
  /** Canonical adapter name used for linkage. */
  adapterName: string;
  /** Log file path on disk; only the root segment owns it. */
  logFilePath?: string | null;
  /**
   * Marker stamped on the `session.turn.*` events emitted for ingested turns.
   * Defaults to `'backfill'` (historical/watcher imports); hook-triggered
   * live ingestion passes `'live'`.
   */
  ingestionMarker?: TurnIngestionMarker;
}
