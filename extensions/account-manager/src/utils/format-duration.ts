/**
 * Format a duration in milliseconds as a human-readable string.
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "2d 5h 3m", "3h 12m", or "45m"
 */
export function formatDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const totalMinutes = Math.max(0, Math.floor(safeMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
