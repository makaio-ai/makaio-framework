/**
 * Create an ordered, idempotent shutdown sequence.
 *
 * Steps run in the order provided. Errors in individual steps are logged
 * but do not prevent subsequent steps from running. Concurrent calls to
 * the returned function share the same promise (idempotent).
 * @param steps - Cleanup functions in shutdown order (typically reverse-startup).
 * @returns An async function that executes all steps once.
 */
export function createShutdownSequence(steps: ReadonlyArray<() => Promise<void> | void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    if (running) return running;
    running = (async () => {
      for (const step of steps) {
        try {
          await step();
        } catch (err) {
          console.warn('[shutdown]', err);
        }
      }
    })();
    return running;
  };
}
