/**
 * Priority-based sorted insertion for handler and interceptor registries.
 */

/**
 * Entry with a priority field for ordering.
 */
interface PriorityEntry {
  priority: number;
}

/**
 * Insert an entry into a sorted array by priority (highest first).
 *
 * Stable insertion: entries with equal priority preserve registration order (FIFO).
 * Uses binary search for O(log n) insertion point lookup.
 * @param entries - Array of priority entries to insert into
 * @param entry - Entry to insert
 */
export function insertSorted<T extends PriorityEntry>(entries: T[], entry: T): void {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid].priority >= entry.priority) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  entries.splice(low, 0, entry);
}
