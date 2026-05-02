/**
 * Inner-logic helpers for the first-read and incremental-read pipelines.
 *
 * These functions extract the event-building, compaction-detection, and
 * cursor-context construction steps from the orchestrator's `handleFirstRead`
 * and `handleIncrementalRead` protected methods so the class bodies stay lean
 * while keeping the `protected` override surface intact for subclasses.
 * @packageDocumentation
 */
import type { NormalizedEvent, LogImportSessionContext, ImportCursorPosition } from './types.js';

/**
 * Build the event-promise array for a first-read pass.
 *
 * Optionally emits session and started lifecycle events, then processes
 * all records from the importer into queued event promises.
 * @param records - Parsed records to process
 * @param context - Session context extracted by the importer on first read
 * @param emitLifecycleEvents - When true, session and started events are queued
 * @param processRecords - Delegate that converts records into normalized events
 * @param queueEvent - Delegate that queues a single normalized event and returns its delivery promise
 * @returns Array of delivery promises for all queued events
 */
export function buildFirstReadEventPromises<TRecord, TState>(
  records: TRecord[],
  context: LogImportSessionContext<TState>,
  emitLifecycleEvents: boolean,
  processRecords: (records: TRecord[], context: LogImportSessionContext<TState>) => NormalizedEvent[],
  queueEvent: (event: NormalizedEvent) => Promise<void>,
): Promise<void>[] {
  const eventPromises: Promise<void>[] = [];

  if (emitLifecycleEvents) {
    eventPromises.push(queueEvent(context.sessionEvent));
    eventPromises.push(queueEvent(context.startedEvent));
  }

  const messageEvents = processRecords(records, context);
  for (const event of messageEvents) {
    eventPromises.push(queueEvent(event));
  }

  return eventPromises;
}

/**
 * Build the event-promise array for an incremental-read pass.
 *
 * Accepts pre-processed normalized events (i.e. the result of calling
 * `importer.processRecords` before this function). Keeping record processing
 * outside this helper ensures the caller can inspect the updated state for
 * compaction detection before committing to event emission.
 * @param events - Normalized events already produced by `importer.processRecords`
 * @param queueEvent - Delegate that queues a single normalized event
 * @returns Array of delivery promises for all queued events
 */
export function buildIncrementalReadEventPromises(
  events: NormalizedEvent[],
  queueEvent: (event: NormalizedEvent) => Promise<void>,
): Promise<void>[] {
  const eventPromises: Promise<void>[] = [];

  for (const event of events) {
    eventPromises.push(queueEvent(event));
  }

  return eventPromises;
}

/**
 * Detect whether the importer's state signals a compaction boundary.
 *
 * Adapters set `state.compactionDetected = true` when they encounter a
 * compaction summary record mid-file. The orchestrator must then re-parse
 * the whole file from byte 0 to reconstruct the pre-compaction history.
 * @param state - Adapter-specific state, typed as `unknown` since the check is
 *   structural (duck-typed) to avoid a generic parameter on a pure function
 * @returns True when the state carries a truthy `compactionDetected` flag
 */
export function detectCompactionInState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    'compactionDetected' in state &&
    (state as Record<string, unknown>)['compactionDetected'] === true
  );
}

/**
 * Build the updated session context written to the cursor after an incremental read.
 *
 * Merges the existing cursor context with the serialized state produced by
 * processing the new records.
 * @param cursorContext - Existing cursor session context to base the update on
 * @param updatedState - The adapter's state after processing this batch of records
 * @param serializeState - Delegate that serializes the adapter state for storage
 * @returns Updated cursor session context ready for persistence
 */
export function buildIncrementalCursorContext<TState>(
  cursorContext: NonNullable<ImportCursorPosition['sessionContext']>,
  updatedState: TState,
  serializeState: (state: TState) => NonNullable<ImportCursorPosition['sessionContext']>['state'],
): NonNullable<ImportCursorPosition['sessionContext']> {
  return {
    ...cursorContext,
    state: serializeState(updatedState),
  };
}
