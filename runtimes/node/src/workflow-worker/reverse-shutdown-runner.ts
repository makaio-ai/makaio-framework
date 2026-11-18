import { JoinedOperation } from '@makaio/utils';
import type { ShutdownStep } from '../boot-phase.js';

/**
 * Create an idempotent reverse-order shutdown runner over a mutable startup stack.
 *
 * The steps are read when the run starts, so a stack that keeps growing while
 * the runtime boots is torn down as it stood when shutdown was requested. A step
 * that fails never prevents the ones after it; the failures are reported once the
 * last step has run.
 *
 * The run is published before the first step starts. A step may call the runner
 * again (a signal handler it triggers, a nested teardown) and must join the run
 * under way instead of running every step a second time. Such a step must not
 * await the returned promise, which settles only after that step has returned.
 * @param steps - Startup-owned cleanup steps appended as resources activate.
 * @returns Idempotent shutdown function.
 * @throws The failure of the single failing step, or an AggregateError of every failing step, from the returned promise.
 */
export function createReverseShutdownRunner(steps: readonly ShutdownStep[]): () => Promise<void> {
  const run = new JoinedOperation<void>();
  return () =>
    run.join(async () => {
      const errors: unknown[] = [];
      for (const step of [...steps].reverse()) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Isolated workflow runtime shutdown reported errors');
    });
}
