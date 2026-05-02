/**
 * Pure helper functions for the log-import file-change pipeline.
 *
 * All functions in this module are free of `this` context. They accept explicit
 * parameters so they can be unit-tested in isolation and reused across
 * orchestrator subclasses.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';

import { ImportCursorStorageSubjects } from './cursor-storage.js';
import type { LogFileChangeEvent } from './log-import-watcher.js';
import type { ImportCursorPosition } from './types.js';
import type { ParseFileResult } from './orchestrator-config.js';

/**
 * Determine whether a JSON-format file should be skipped because its mtime has
 * not advanced since the cursor was last written.
 *
 * Only applicable to JSON (mtime-based) format files. JSONL files use byte
 * offsets and are never skipped by this check.
 * @param lastModified - ISO 8601 string from the existing cursor, or undefined
 * @param mtime - Current file modification time
 * @param isJsonFormat - True when the file uses JSON (mtime-based) cursors
 * @param changeType - Watcher-reported change type for the file
 * @returns True when the file should be skipped (mtime unchanged)
 */
export function shouldSkipUnchangedFile(
  lastModified: string | undefined,
  mtime: Date,
  isJsonFormat: boolean,
  changeType: string,
): boolean {
  if (!isJsonFormat || !lastModified || changeType === 'rotated') return false;
  return new Date(lastModified) >= mtime;
}

/**
 * Emit a console warning for each parse error found in a log file.
 * @param logPrefix - Orchestrator log prefix (e.g. `[ClaudeCodeOrchestrator]`)
 * @param filePath - Path of the file that produced the errors
 * @param errors - Array of parse errors, or undefined when none occurred
 */
export function logParseErrors(logPrefix: string, filePath: string, errors: ParseFileResult<unknown>['errors']): void {
  for (const error of errors ?? []) {
    const location = error.line !== undefined ? ` at line ${error.line}` : '';
    console.warn(`${logPrefix} Parse error in ${filePath}${location}: ${error.error}`);
  }
}

/**
 * Retrieve the cursor for a file, migrating legacy JSONL cursors that lack
 * session context.
 *
 * Old JSONL cursors saved before the `sessionContext` field was introduced have
 * a non-zero `bytesRead` but no context. They cannot be resumed incrementally,
 * so this function deletes them and schedules a fresh read via `scheduleRetry`.
 * @param filePath - Path to the log file
 * @param isJsonFormat - True when the file uses JSON (mtime-based) cursors
 * @param event - Original file-change event (forwarded to `scheduleRetry`)
 * @param scheduleRetry - Callback that re-queues the file-change event for
 *   re-processing after the stale cursor has been removed
 * @returns The cursor position, `null` when no cursor exists, or the string
 *   `'retry'` when a migration was triggered (caller should return immediately)
 */
export async function getCursorWithMigration(
  filePath: string,
  isJsonFormat: boolean,
  event: LogFileChangeEvent,
  scheduleRetry: (event: LogFileChangeEvent) => void,
): Promise<ImportCursorPosition | null | 'retry'> {
  const { cursor } = await MakaioBus.request(ImportCursorStorageSubjects.get, { filePath });
  // Old JSONL cursor without context needs migration — delete and re-read from start
  if (cursor && cursor.bytesRead > 0 && !cursor.sessionContext && !isJsonFormat) {
    await MakaioBus.request(ImportCursorStorageSubjects.delete, { filePath }).catch(() => {});
    scheduleRetry(event);
    return 'retry';
  }
  return cursor;
}

/**
 * Parameters for {@link reParseAndHandleFirstRead}.
 * @typeParam TRecord - The adapter's native log record type
 */
export interface ReParseHandlers<TRecord> {
  /** Parse a file from a given byte offset, returning records and byte count. */
  parseFile: (filePath: string, startOffset: number) => Promise<ParseFileResult<TRecord>>;
  /** Validate/filter parsed records before processing. */
  validateRecords: (records: TRecord[]) => TRecord[];
  /** Handle the first read of a file with the supplied records. */
  handleFirstRead: (
    filePath: string,
    records: TRecord[],
    bytesRead: number,
    mtime: Date,
    isJsonFormat: boolean,
    startOffset: number,
    emitLifecycleEvents: boolean,
  ) => Promise<void>;
}

/**
 * Re-parse a file from byte 0 and delegate to `handleFirstRead`.
 *
 * Used by both the corrupted-cursor recovery path and the compaction recovery
 * path to avoid duplicating the parse → validate → handleFirstRead sequence.
 * @param filePath - Path to the log file
 * @param mtime - File modification time
 * @param isJsonFormat - True when the file uses JSON (mtime-based) format
 * @param emitLifecycleEvents - Forwarded to `handleFirstRead` (default: `true`)
 * @param logPrefix - Orchestrator log prefix for parse-error reporting
 * @param handlers - Callbacks that bridge back to the orchestrator instance
 */
export async function reParseAndHandleFirstRead<TRecord>(
  filePath: string,
  mtime: Date,
  isJsonFormat: boolean,
  emitLifecycleEvents: boolean,
  logPrefix: string,
  handlers: ReParseHandlers<TRecord>,
): Promise<void> {
  const result = await handlers.parseFile(filePath, 0);
  logParseErrors(logPrefix, filePath, result.errors);
  const validRecords = handlers.validateRecords(result.records);
  if (validRecords.length > 0) {
    await handlers.handleFirstRead(
      filePath,
      validRecords,
      result.bytesRead ?? 0,
      mtime,
      isJsonFormat,
      0,
      emitLifecycleEvents,
    );
  }
}
