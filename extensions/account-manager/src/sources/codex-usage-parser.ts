import { UsageWindowSchema } from '../bus/schemas.js';
import type { AccountUsage } from '../bus/schemas.js';

/**
 * Safely extract a usage window from a Codex WHAM API window entry.
 *
 * Returns null if required fields are missing or malformed. The Codex API
 * uses `used_percent`, `reset_after_seconds`, and `limit_window_seconds`
 * to describe each window.
 * @param raw - The raw API response object for this window.
 * @param id - Window identifier slug.
 * @param label - Human-readable label.
 * @param group - Logical group.
 * @returns A valid UsageWindow, or null if the data is malformed.
 */
export function parseUsageWindow(
  raw: Record<string, unknown>,
  id: string,
  label: string,
  group: string,
): AccountUsage['windows'][number] | null {
  const usedPercent = raw['used_percent'];
  const resetAfterSeconds = raw['reset_after_seconds'];
  const limitWindowSeconds = raw['limit_window_seconds'];
  if (
    typeof usedPercent !== 'number' ||
    !Number.isFinite(usedPercent) ||
    typeof resetAfterSeconds !== 'number' ||
    !Number.isFinite(resetAfterSeconds) ||
    typeof limitWindowSeconds !== 'number' ||
    !Number.isFinite(limitWindowSeconds)
  ) {
    return null;
  }
  const candidate: AccountUsage['windows'][number] = {
    id,
    label,
    group,
    utilization: usedPercent,
    resetsAt: Date.now() + resetAfterSeconds * 1000,
    windowSeconds: limitWindowSeconds,
  };
  return UsageWindowSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * Parses model-specific rate limits from the `additional_rate_limits` array.
 *
 * Each entry contains a `limit_name`, `metered_feature`, and nested
 * `rate_limit` with the same window structure as the top-level rate limit.
 * Appends valid windows to the provided array with `group: "model"`.
 * Malformed entries and windows that fail schema validation (e.g.
 * utilization outside 0–100) are silently skipped so they cannot poison
 * the downstream `AccountUsageSchema.safeParse` that gates the entire
 * snapshot.
 * @param data - The full usage API response.
 * @param windows - The windows array to append to.
 */
export function parseAdditionalRateLimits(data: Record<string, unknown>, windows: AccountUsage['windows']): void {
  const additional = data['additional_rate_limits'];
  if (!Array.isArray(additional)) return;

  for (const entry of additional) {
    if (entry == null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const limitName = rec['limit_name'];
    if (typeof limitName !== 'string' || limitName.length === 0) continue;
    // Only process model-usage limits; non-model entries (e.g. request-count
    // or token-count limits) must not be labelled with group:'model'.
    if (rec['metered_feature'] !== 'model_usage') continue;

    const nestedLimit = rec['rate_limit'] as Record<string, unknown> | null | undefined;
    if (nestedLimit == null) continue;

    const nestedDefs = [
      { key: 'primary_window', suffix: '5h', label: '5 Hour' },
      { key: 'secondary_window', suffix: '7d', label: '7 Day' },
    ] as const;
    for (const def of nestedDefs) {
      const rawWindow = nestedLimit[def.key] as Record<string, unknown> | null | undefined;
      if (rawWindow == null) continue;
      const win = parseUsageWindow(rawWindow, `${limitName}-${def.suffix}`, `${limitName} (${def.label})`, 'model');
      if (win) windows.push(win);
    }
  }
}
