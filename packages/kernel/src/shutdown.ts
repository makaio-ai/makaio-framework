import { boundedWaitReread } from '@makaio/utils';

/** One named stage of a runtime teardown, with the window it must finish in. */
export interface BoundedShutdownStep {
  /** Name the report of a failed or overrunning stage uses. */
  readonly name: string;
  /**
   * Window the stage may take, in milliseconds. Read when the stage is about to
   * run, again each time the window closes (a stage whose work was still being
   * registered when it started, such as an extension that was being enabled,
   * keeps the time the work it found needs) and when {@link shutdownBudgetMs}
   * adds the windows up, so a stage whose work only becomes known while the
   * runtime boots (the extensions it will stop) reports what it has by then.
   *
   * A stage that wraps work which bounds itself reports
   * `outerBoundMs(whatThoseBoundsAddUpTo)` from `@makaio/utils`, so the wrapper
   * cannot close before the work it wraps has used its own bounds in full.
   */
  readonly budgetMs: () => number;
  /**
   * Run the stage. A rejection fails the stage, never the sequence: the later
   * stages still run.
   */
  readonly run: () => Promise<void> | void;
}

/** An ordered, idempotent teardown that bounds each of its stages. */
export interface ShutdownSequence {
  /**
   * Run the stages, once; every call shares that run and its rejection.
   * @returns Settles when every stage has finished or run out of its window.
   * @throws An AggregateError when any stage failed or did not finish inside its window.
   */
  readonly run: () => Promise<void>;
  /**
   * Longest time {@link run} takes: the windows of the stages, added up, since
   * they run one after the other.
   * @returns The bound, in milliseconds.
   */
  readonly budgetMs: () => number;
}

/**
 * Add up the windows of stages that run one after the other.
 * @param steps - Teardown stages.
 * @returns The longest time running them takes, in milliseconds.
 */
export function shutdownBudgetMs(steps: ReadonlyArray<BoundedShutdownStep>): number {
  return steps.reduce((total, step) => total + step.budgetMs(), 0);
}

/**
 * Start a stage, turning a synchronous throw into a rejection.
 * @param step - Stage to run.
 * @returns Settles with the stage.
 */
async function runStep(step: BoundedShutdownStep): Promise<void> {
  await step.run();
}

/**
 * Run teardown stages one after the other, each inside its own window.
 *
 * A stage that fails never prevents the ones after it from running. A stage
 * that does not settle inside its window is recorded as failed, named, and left
 * behind: the stage it was running is not cancelled, but the next one starts, so
 * one stuck stage cannot consume the time of the others.
 * @param steps - Teardown stages in the order they run.
 * @returns The failures, in stage order, each stage at most once; empty when every stage finished cleanly.
 */
export async function runBoundedShutdownSteps(steps: ReadonlyArray<BoundedShutdownStep>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      const outcome = await boundedWaitReread(() => runStep(step), step.budgetMs);
      if (!outcome.settled) {
        failures.push(new Error(`Shutdown step "${step.name}" did not finish within ${outcome.windowMs} ms`));
      }
    } catch (err) {
      failures.push(err);
    }
  }
  return failures;
}

/**
 * Run the stages and report their failures together.
 * @param steps - Teardown stages in the order they run.
 * @returns Settles once every stage has been handled.
 * @throws An AggregateError when any stage failed or did not finish inside its window.
 */
async function runAllSteps(steps: ReadonlyArray<BoundedShutdownStep>): Promise<void> {
  const failures = await runBoundedShutdownSteps(steps);
  if (failures.length > 0) {
    throw new AggregateError(failures, `Shutdown completed with ${failures.length} of ${steps.length} steps failing`);
  }
}

/**
 * Create an ordered, idempotent shutdown sequence whose stages are bounded.
 *
 * Stages run in the order provided, each inside its own window (see
 * {@link runBoundedShutdownSteps}). A failure is never swallowed: every failure
 * is collected and reported together once the last stage has been handled. The
 * caller that owns process termination therefore learns that the teardown was
 * incomplete instead of being told it finished, and must treat the rejection as
 * an unclean exit rather than a completed drain.
 *
 * Repeated calls of {@link ShutdownSequence.run} share the one run, and
 * therefore its rejection.
 * @param steps - Teardown stages in shutdown order (typically reverse-startup).
 * @returns The sequence and its bound.
 */
export function createShutdownSequence(steps: ReadonlyArray<BoundedShutdownStep>): ShutdownSequence {
  let running: Promise<void> | undefined;
  return {
    run: () => {
      if (running !== undefined) return running;
      // Published before the first stage starts: a stage may call `run()` again
      // (a signal handler it triggers, a nested teardown), and must join this run
      // instead of starting a second one that runs every stage again.
      const shared = Promise.withResolvers<void>();
      running = shared.promise;
      void runAllSteps(steps).then(shared.resolve, shared.reject);
      return running;
    },
    budgetMs: () => shutdownBudgetMs(steps),
  };
}
