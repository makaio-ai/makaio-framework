import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';

/**
 * Wrap a projection write in a try-catch so failures are logged but never
 * propagate to the event dispatch layer.
 *
 * WorkLog is a PROJECTION — runtime execution must never be blocked by a
 * failing WorkLog write. This wrapper enforces that invariant at every
 * call-site without requiring every handler to repeat the try-catch.
 * @param label - Human-readable label for log messages.
 * @param fn - Async projection function to execute.
 */
export async function safeProject(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[WorklogProjection] Write failed (${label}):`, error);
  }
}

/**
 * Emit `workflow.worklog.changed` for the given execution.
 *
 * Observers (e.g., the GUI) subscribe to this event to invalidate cached
 * WorkLog data after each projection update.
 *
 * Emit failures are swallowed because `worklog.changed` is advisory — a missed
 * notification only causes a temporary stale cache, not data loss.
 * @param bus - Message bus to emit on.
 * @param executionId - Execution whose WorkLog record changed.
 */
export async function emitWorklogChanged(bus: IMakaioBus, executionId: string): Promise<void> {
  try {
    await bus.emit(WorkflowSubjects.worklog.changed, { executionId });
  } catch (error) {
    console.error(`[WorklogProjection] worklog.changed emit failed for ${executionId}:`, error);
  }
}
