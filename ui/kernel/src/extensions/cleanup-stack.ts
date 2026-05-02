/**
 * Cleanup-stack helper for browser extension registration.
 *
 * Registrations are treated as transactional stacks: when a later step fails,
 * already-registered resources are unwound in reverse order.
 * @packageDocumentation
 */

/**
 * Runs all cleanup callbacks in reverse registration order.
 *
 * Errors are logged and suppressed so teardown continues for the remaining
 * callbacks.
 * @param cleanups - Registered cleanup callbacks.
 * @param scope - Log prefix describing the failing teardown scope.
 */
export function runCleanupsInReverse(cleanups: ReadonlyArray<() => void>, scope: string): void {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch (error) {
      console.error(`${scope} Cleanup failed:`, error);
    }
  }
}
