import type { AccountUsage } from '../bus/schemas.js';
import type { UsageEntry } from '../bus/usage-entry.js';

/**
 * Minimal append seam used by live usage persistence.
 */
export interface IUsageEntryAppender {
  /**
   * Appends one usage entry.
   * @param entry - Usage entry to persist
   * @returns Whether the append succeeded
   */
  append(entry: UsageEntry): Promise<boolean>;
}

/**
 * Baseline state for a single usage window, used for delta detection
 * across consecutive fetch cycles.
 */
export type PersistedWindowState = {
  utilization: number;
  resetsAt: number;
  blocked: boolean;
};

/**
 * Compares each window in a fresh usage snapshot against the last successfully
 * persisted baseline and appends only the windows that actually changed.
 *
 * The baseline advances per window only after that specific append succeeds.
 * This avoids losing retry information when one write in a batch fails, even
 * if a writer unexpectedly throws for one of the later windows.
 *
 * A window is considered changed when any of the following differ from the
 * last persisted state: `utilization`, `resetsAt`, or the account-level
 * `blocked` flag. When `blocked` flips, every window in the current snapshot
 * is written so that the new blocked state is recorded for each window.
 * New windows (absent from the previous snapshot) are always written.
 * @param writer - Persistence backend for appending usage entries
 * @param current - Freshly fetched usage snapshot
 * @param previousWindows - Last successfully persisted baseline per window
 * @param shouldAbort - Called before each write; returns `true` to bail out early
 * @returns Updated baseline reflecting successful writes, or `null` when aborted
 */
export async function persistChangedWindows(
  writer: IUsageEntryAppender,
  current: AccountUsage,
  previousWindows: Map<string, PersistedWindowState>,
  shouldAbort: () => boolean,
): Promise<Map<string, PersistedWindowState> | null> {
  if (shouldAbort()) return null;

  const blocked = current.blocked ?? false;
  const nextWindows = new Map<string, PersistedWindowState>();
  const ts = current.fetchedAt;

  for (const window of current.windows) {
    if (shouldAbort()) return null;

    const prev = previousWindows.get(window.id);
    if (
      prev !== undefined &&
      prev.utilization === window.utilization &&
      prev.resetsAt === window.resetsAt &&
      prev.blocked === blocked
    ) {
      nextWindows.set(window.id, prev);
      continue;
    }

    const entry: UsageEntry = {
      ts,
      windowId: window.id,
      utilization: window.utilization,
      resetsAt: window.resetsAt,
      blocked,
    };

    let persisted: boolean;
    try {
      persisted = await writer.append(entry);
    } catch (error) {
      // Keep the original Error object so append failures retain stack/context.
      console.error(`[UsagePersistence] append failed for windowId=${window.id}:`, error);
      persisted = false;
    }
    if (shouldAbort()) return null;
    if (persisted) {
      nextWindows.set(window.id, { utilization: window.utilization, resetsAt: window.resetsAt, blocked });
    } else if (prev !== undefined) {
      nextWindows.set(window.id, prev);
    }
  }

  return nextWindows;
}
