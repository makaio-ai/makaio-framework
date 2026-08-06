/**
 * Per-turn token accounting for the qwen ACP connector.
 *
 * Qwen sends *running totals* rather than deltas, on every message chunk, so the
 * per-turn figure is the last value seen for each field. Keeping that merge here
 * makes it a pure function of two values instead of a method reaching into
 * connector state, which is also what makes it directly testable.
 * @packageDocumentation
 */

/**
 * Accumulated token usage for the current turn.
 *
 * Every field is optional because qwen reports whichever counters it has, and a
 * field it never reported must stay absent rather than becoming a zero the
 * consumer cannot tell from a real one.
 */
export interface TurnUsageAccumulator {
  /** Prompt tokens reported for the turn so far. */
  inputTokens?: number;
  /** Completion tokens reported for the turn so far. */
  outputTokens?: number;
  /** Combined total reported for the turn so far. */
  totalTokens?: number;
  /** Reasoning tokens reported for the turn so far. */
  thoughtTokens?: number;
  /** Cache-read tokens reported for the turn so far. */
  cachedReadTokens?: number;
}

/** Counters read out of an ACP update's `_meta.usage`, in accumulator order. */
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'thoughtTokens',
  'cachedReadTokens',
] as const satisfies readonly (keyof TurnUsageAccumulator)[];

/**
 * Merge one ACP update's usage counters into the turn accumulator (last-wins).
 *
 * A counter the update omits leaves the accumulator's value untouched: qwen sends
 * running totals, so an omission means "unchanged", never "zero".
 * @param accumulator - Accumulator for the active turn, mutated in place.
 * @param meta - The `_meta` record from an ACP session update, if present.
 */
export function mergeUsageFromMeta(
  accumulator: TurnUsageAccumulator,
  meta: Record<string, unknown> | null | undefined,
): void {
  const usage = meta?.['usage'];
  if (usage === null || usage === undefined || typeof usage !== 'object') return;
  const reported = usage as Record<string, unknown>;
  for (const field of USAGE_FIELDS) {
    const value = reported[field];
    if (typeof value === 'number') accumulator[field] = value;
  }
}
