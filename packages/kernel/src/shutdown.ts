/**
 * Create an ordered, idempotent shutdown sequence.
 *
 * Steps run in the order provided. A failing step never prevents the ones after
 * it from running, and it is never swallowed either: every failure is collected
 * and reported together once the last step has been attempted. The caller that
 * owns process termination therefore learns that the teardown was incomplete
 * instead of being told it finished, and must treat the rejection as an unclean
 * exit rather than a completed drain.
 *
 * Repeated calls share the one sequence, and therefore its rejection.
 * @param steps - Cleanup functions in shutdown order (typically reverse-startup).
 * @returns An async function that executes all steps once.
 * @throws An AggregateError when any step failed.
 */
export function createShutdownSequence(steps: ReadonlyArray<() => Promise<void> | void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= (async () => {
      const failures: unknown[] = [];
      for (const step of steps) {
        try {
          await step();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Shutdown completed with ${failures.length} of ${steps.length} steps failing`,
        );
      }
    })();
    return running;
  };
}
