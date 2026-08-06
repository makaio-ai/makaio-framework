/**
 * Run every registered cleanup, letting none of them stop the others.
 *
 * The teardown discipline this repository applies everywhere, in its smallest
 * form: **in a teardown every step is best-effort and the classification is the
 * result, never the last write.** A loop that let the first failing
 * unsubscribe skip the rest would leak every listener behind it, and there were
 * three hand-written copies of this loop before it had a name.
 * @param cleanups - Cleanup callbacks to run, in registration order
 * @param context - What failed, for the diagnostic when one of them throws
 */
export function runBestEffortCleanups(cleanups: readonly (() => void)[], context: string): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      console.warn(`[AIAgent] ${context} cleanup failed:`, error);
    }
  }
}
