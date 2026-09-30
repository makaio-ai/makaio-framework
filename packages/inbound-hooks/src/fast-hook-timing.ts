const DEFAULT_TIMEOUT_MS = 250;

/**
 * Normalize a user-provided timeout to the default fast-path budget.
 * @param value - User-provided timeout in milliseconds.
 * @returns A non-negative finite timeout in milliseconds.
 */
export function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * Start a monotonic deadline, immune to wall-clock jumps.
 * @param timeoutMs - Total budget in milliseconds, counted from now.
 * @returns A function that returns the remaining budget in milliseconds (never negative).
 */
export function startDeadline(timeoutMs: number): () => number {
  const deadline = performance.now() + timeoutMs;
  return () => Math.max(0, deadline - performance.now());
}

/**
 * Run a bus disconnect without letting cleanup extend the hook fast path.
 * @param disconnect - Disconnect callback for the bus instance; it returns void and swallows transport rejections itself.
 */
export function disconnectBestEffort(disconnect: () => void): void {
  try {
    disconnect();
  } catch {
    // Best-effort cleanup must not affect native hook execution.
  }
}
