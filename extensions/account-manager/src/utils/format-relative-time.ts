/**
 * Format a past epoch timestamp as a relative time string.
 * @param epochMs - Timestamp in milliseconds since epoch
 * @returns Relative string like "just now", "5m ago", "2h ago", "3d ago", or "unknown" for invalid input
 */
export function formatRelativeTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    return 'unknown';
  }

  const deltaMs = Date.now() - epochMs;
  // Clock skew can make a persisted last-seen timestamp appear slightly in the
  // future. Clamp that case to "just now" so this past-tense formatter never
  // emits a misleading negative relative bucket.
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1_000));

  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3_600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3_600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}
