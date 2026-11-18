/**
 * Signal-driven host shutdown: one coordinator that owns the process signals
 * for the whole life of a host, from before its runtime boots until its
 * teardown has finished.
 * @packageDocumentation
 */

import { writeSync } from 'node:fs';
import { boundedWait, boundedWaitReread } from '@makaio/utils';

/**
 * Process signals a host can stop on. `SIGINT` and `SIGTERM` are the ordinary
 * stop requests; `SIGHUP` is the terminal hangup, which a host either stops on
 * like the others or, by an explicit policy, ignores.
 */
export type HostStopSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** One named stage of a host teardown. */
export interface HostShutdownStep {
  /** Name the report of a stage that did not finish uses. */
  readonly name: string;
  /**
   * Window the stage may take, in milliseconds, read when the stage is about to
   * run, and again each time it closes: a stage whose limit is only known by then
   * (the runtime's, once it has booted) supplies what it knows at that time, and
   * one whose work was still registering cleanup (a boot that was in the middle of
   * a phase) keeps the time that cleanup needs. A stage that wraps work which
   * bounds itself reports `outerBoundMs(...)` from `@makaio/utils`. `undefined` gives the stage no
   * window of the host's: it enforces its own limits, and a second timer on top
   * of the owner's could only end the host while the owner is still within them.
   */
  readonly budgetMs: () => number | undefined;
  /**
   * Run the stage. It may be called before what it tears down exists (a
   * shutdown can arrive while the runtime is still booting), so it must find
   * out for itself whether there is anything to do. A rejection fails the
   * stage, never the teardown: the later stages still run.
   */
  readonly run: () => Promise<void> | void;
}

/** Inputs to {@link installHostShutdown}. */
export interface HostShutdownOptions {
  /** Log prefix without brackets, e.g. `serve`. */
  readonly label: string;
  /** Signals that request the shutdown; those listed in neither list keep their disposition untouched. */
  readonly signals: readonly HostStopSignal[];
  /**
   * Signals the host survives. Each gets a listener that does nothing but log
   * the first delivery, held until the teardown has finished. A real listener, unlike an inherited ignore, is not reset when
   * Node starts, and it keeps libraries that re-raise a signal when theirs is
   * the only listener (`signal-exit`) from ending the host. A signal listed in
   * {@link signals} too is rejected: a signal either stops the host or is ignored.
   */
  readonly ignoredSignals?: readonly HostStopSignal[];
  /** Teardown stages, run one after the other in this order. */
  readonly steps: readonly HostShutdownStep[];
}

/** Control of the signal handling installed by {@link installHostShutdown}. */
export interface HostShutdown {
  /**
   * Aborted as soon as a shutdown is requested, with the cause as reason, so
   * `cancellation.aborted` tells whether one was requested. Pass it to a boot so
   * a request that arrives while the runtime starts cancels the boot through
   * the boot's own rollback.
   */
  readonly cancellation: AbortSignal;
  /**
   * Request the shutdown. The first request starts it; every later one, from
   * whatever source, joins it and only reports that it is in progress. Never
   * rejects: failing stages set the exit code and are logged.
   * @param reason - What asked for the shutdown, e.g. a signal name.
   * @returns Settles when the teardown has finished.
   */
  request(reason: string): Promise<void>;
  /**
   * The teardown, once requested.
   * @returns Settles when the teardown has finished; already settled when no shutdown was requested.
   */
  finished(): Promise<void>;
}

/**
 * Take over the process signals for a host and tie them to its teardown.
 *
 * The listeners stay installed until the teardown has finished, so a signal
 * that arrives while it runs cannot take the default action and end the host
 * in the middle of it (which would leave the children it has not stopped yet
 * running): it joins the shutdown in progress instead.
 *
 * Every stage runs inside the window it declares ({@link HostShutdownStep.budgetMs}),
 * so one stage that never settles cannot consume the time of the ones after it.
 * A stage that runs out of its window is named, left behind, and the next one
 * runs. Once every stage has been handled, a teardown in which any stage failed
 * or ran out of its window ends the host with status 1 right away, after the
 * output is flushed: what such a stage left running would otherwise hold the
 * host open forever.
 *
 * Signals the options do not list are left alone.
 * @param options - Signals and teardown stages.
 * @returns Control of the installed handling.
 */
export function installHostShutdown(options: HostShutdownOptions): HostShutdown {
  const { label, steps } = options;
  const ignoredSignals = options.ignoredSignals ?? [];
  const overlapping = ignoredSignals.filter((signal) => options.signals.includes(signal));
  if (overlapping.length > 0) {
    throw new Error(`[${label}] ${overlapping.join(', ')} cannot both stop the host and be ignored`);
  }

  const controller = new AbortController();
  let shutdown: Promise<void> | undefined;
  // The abort reason is an Error that wraps this; later requests name the initiator.
  let initiator = '';

  const request = (reason: string): Promise<void> => {
    if (shutdown !== undefined) {
      console.info(`[${label}] ${reason} received; shutdown already in progress (requested by ${initiator})`);
      return shutdown;
    }
    initiator = reason;
    console.info(`[${label}] ${reason} received, shutting down...`);
    // Published before the abort: abort listeners run synchronously and may call
    // `request()` or `finished()`, which must find this one shutdown. The teardown
    // itself starts on the next microtask, so it still begins after the abort.
    shutdown = Promise.resolve()
      .then(() => runTeardown(label, steps))
      .finally(release);
    controller.abort(new Error(`[${label}] startup cancelled: ${reason} received`));
    return shutdown;
  };

  const handlers: ReadonlyArray<readonly [HostStopSignal, () => void]> = [
    ...options.signals.map((signal) => [signal, (): void => void request(signal)] as const),
    ...ignoredSignals.map((signal) => [signal, createIgnoringListener(label, signal)] as const),
  ];
  /** Give the signals back once the teardown has finished. */
  function release(): void {
    for (const [signal, listener] of handlers) process.off(signal, listener);
  }
  for (const [signal, listener] of handlers) process.on(signal, listener);

  return { cancellation: controller.signal, request, finished: () => shutdown ?? Promise.resolve() };
}

/**
 * Create the listener of a signal the host survives: it logs the first
 * delivery and does nothing else.
 * @param label - Log prefix without brackets.
 * @param signal - Signal the listener is installed for.
 * @returns The listener.
 */
function createIgnoringListener(label: string, signal: HostStopSignal): () => void {
  let logged = false;
  return () => {
    if (logged) return;
    logged = true;
    console.info(`[${label}] ${signal} received and ignored (further ${signal} signals are ignored silently)`);
  };
}

/**
 * Longest the host waits for its output to be handed to the OS before it exits
 * anyway; a reader that has stopped reading must not hold the exit.
 */
const OUTPUT_FLUSH_WINDOW_MS = 1_000;

/**
 * Run one stage inside its window.
 * @param step - Teardown stage.
 * @returns The window the stage ran out of, or `undefined` when it settled inside its window or has none.
 * @throws The stage's rejection.
 */
async function runInWindow(step: HostShutdownStep): Promise<number | undefined> {
  const firstWindowMs = step.budgetMs();
  if (firstWindowMs === undefined) {
    await step.run();
    return undefined;
  }
  // `budgetMs` may turn `undefined` later; the last window that was a number
  // holds, starting with the one read above.
  let lastWindowMs = firstWindowMs;
  const outcome = await boundedWaitReread(
    async () => step.run(),
    () => (lastWindowMs = step.budgetMs() ?? lastWindowMs),
  );
  return outcome.settled ? undefined : outcome.windowMs;
}

/**
 * Wait until what was written to a stream has been handed to the OS.
 * @param stream - Output stream.
 * @returns Settles once earlier writes have been flushed, or once {@link OUTPUT_FLUSH_WINDOW_MS} has passed.
 */
async function flush(stream: NodeJS.WriteStream): Promise<void> {
  await boundedWait(new Promise<void>((resolve) => stream.write('', () => resolve())), OUTPUT_FLUSH_WINDOW_MS);
}

/**
 * Run the stages in order, each inside its window.
 * @param label - Log prefix without brackets.
 * @param steps - Teardown stages.
 * @returns Settles when every stage has been handled and the teardown was clean;
 *   never rejects. A teardown with a failed stage or a stage that ran out of its
 *   window exits the process with status 1 instead.
 */
async function runTeardown(label: string, steps: readonly HostShutdownStep[]): Promise<void> {
  const overran: string[] = [];
  let failed = false;

  for (const step of steps) {
    try {
      const windowMs = await runInWindow(step);
      if (windowMs !== undefined) overran.push(`${step.name} (did not settle within ${windowMs} ms)`);
    } catch (err) {
      // The exit status is the only channel a supervisor reads, so a teardown
      // that could not release everything must not leave a status that says
      // the drain completed.
      failed = true;
      console.error(`[${label}] Shutdown step "${step.name}" did not complete cleanly:`, err);
    }
  }

  if (!failed && overran.length === 0) return;
  process.exitCode = 1;
  if (overran.length > 0) {
    // Written synchronously: a buffered write to a pipe is lost by the exit below.
    try {
      writeSync(2, `[${label}] Shutdown steps did not finish: ${overran.join(', ')}. Exiting.\n`);
    } catch {
      // stderr is unwritable; the exit must still happen, it is the whole point of the windows.
    }
  }
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(1);
}
