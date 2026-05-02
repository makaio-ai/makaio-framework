import type { HandlerEntry } from '../types/index.js';

/**
 * Merge multiple sorted handler entry arrays into a single sorted array of entries.
 * Each input array is sorted by priority (highest first).
 * The result maintains priority order with stable ordering for equal priorities.
 * @param arrays - Arrays of handler entries to merge
 * @returns Merged array of handler entries sorted by priority (highest first)
 */
export function mergeSortedHandlerArrays<H>(arrays: Array<Array<HandlerEntry<H>>>): Array<HandlerEntry<H>> {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return arrays[0].slice();

  // Collect all entries and sort by priority (stable sort preserves order within equal priorities)
  const allEntries: Array<HandlerEntry<H>> = [];
  for (const arr of arrays) {
    for (const entry of arr) {
      allEntries.push(entry);
    }
  }

  // Sort by priority descending (higher runs first)
  // Use stable sort to preserve registration order within equal priorities
  allEntries.sort((a, b) => b.priority - a.priority);

  return allEntries;
}
