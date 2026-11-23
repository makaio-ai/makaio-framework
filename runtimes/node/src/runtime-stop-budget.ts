/**
 * The stop windows of the runtime's own teardown steps, and the steps that
 * carry them.
 *
 * Every step of a runtime shutdown or boot rollback runs inside a window of its
 * own (see `createShutdownSequence` in `@makaio/kernel`), so one stuck step
 * cannot consume the time of the others and the runtime bounds itself by the sum
 * of its steps' windows. The extensions are the largest part: the extension
 * coordinator reports the windows of the extensions it actually started, and
 * each of those is declared by the extension's own stop code. What is left are
 * the fixed steps below. They enforce no limit of their own, so the window is
 * their limit.
 * @packageDocumentation
 */

import { shutdownBudgetMs, type BoundedShutdownStep, type ExtensionCoordinator } from '@makaio/kernel';
import { processStopBudgetMs } from '@makaio/subprocess';
import { outerBoundMs } from '@makaio/utils';
import type { ShutdownStep } from './boot-phase.js';

/**
 * Window of a step that only releases in-process state (unsubscribing bus
 * handlers, uninstalling a resolver). It waits for nothing outside the process,
 * so a step that needs more than a second is stuck, not slow.
 */
export const LOCAL_STEP_STOP_BUDGET_MS = 1_000;

/**
 * Window of a step that closes something a peer holds open: the bus transport
 * and its clients, the database, the worker pool, the telemetry and credential
 * channels, and the cleanups a host registered. It is the unit of one bounded
 * stop, {@link processStopBudgetMs}, the same limit one child process gets, so
 * it follows when the subprocess stop timing changes.
 * @returns The window, in milliseconds.
 */
export function resourceStepStopBudgetMs(): number {
  return processStopBudgetMs();
}

/**
 * Create a teardown step that releases in-process state only.
 * @param name - Name the report of a failure uses.
 * @param run - The cleanup.
 * @returns The step, bounded by {@link LOCAL_STEP_STOP_BUDGET_MS}.
 */
export function localStep(name: string, run: ShutdownStep): BoundedShutdownStep {
  return { name, budgetMs: () => LOCAL_STEP_STOP_BUDGET_MS, run };
}

/**
 * Create a teardown step that closes a resource a peer holds open.
 * @param name - Name the report of a failure uses.
 * @param run - The cleanup.
 * @returns The step, bounded by {@link resourceStepStopBudgetMs}.
 */
export function resourceStep(name: string, run: ShutdownStep): BoundedShutdownStep {
  return { name, budgetMs: resourceStepStopBudgetMs, run };
}

/**
 * Create the teardown step that stops the extensions.
 *
 * The coordinator knows which extensions it started, and each of them its own
 * window, which it enforces itself (see `ExtensionCoordinator.shutdown`). This
 * step wraps that self-bounded work, so its window is the coordinator's bound
 * plus the headroom of an outer bound ({@link outerBoundMs}): the coordinator arms
 * its per-extension timers after this one, and an extension that uses its whole
 * window must not make the runtime report the step as failed, nor close the
 * credential channel and the transport under it.
 * @param coordinator - The coordinator that owns the extensions.
 * @param scheduleNamespaceRelease - Schedules release after runtime transport disconnect.
 * @returns The step.
 */
export function extensionsStep(
  coordinator: Pick<ExtensionCoordinator, 'stopBudgetMs' | 'shutdown'>,
  scheduleNamespaceRelease?: (release: () => void) => void,
): BoundedShutdownStep {
  return {
    name: 'extensions',
    budgetMs: () => outerBoundMs(coordinator.stopBudgetMs()),
    run: () => coordinator.shutdown(scheduleNamespaceRelease),
  };
}

/**
 * Longest a boot may take, once cancelled, to reach the next checkpoint. The
 * phase in flight cannot be interrupted (opening the database, starting an
 * extension's child), so the cancellation waits for it. The default is the unit
 * of one bounded stop, {@link processStopBudgetMs}: the phases that run long are
 * the ones that wait on a peer or a child process, which is what that unit
 * bounds everywhere else, and it moves with the subprocess stop timing instead
 * of being a second number to keep in line with it.
 * @returns The grace, in milliseconds.
 */
export function bootCheckpointGraceMs(): number {
  return processStopBudgetMs();
}

/**
 * Longest the cancellation of a boot takes: the grace for the phase in flight
 * plus the rollback of the steps registered so far, which run one after the
 * other inside windows of their own. Read lazily, since the steps are
 * registered while the boot runs: the phase in flight when the cancellation
 * arrives registers its own cleanup once it finishes, so a host that waits on
 * this bound reads it again when its timer closes (see `boundedWaitReread`)
 * instead of trusting the read it took at the start. A host that wraps the boot
 * in a timer adds `outerBoundMs`, since the rollback bounds itself.
 * @param rollbackSteps - The boot's teardown steps, a live list the boot appends to.
 * @returns The bound, in milliseconds.
 */
export function bootCancellationBudgetMs(rollbackSteps: ReadonlyArray<BoundedShutdownStep>): number {
  return bootCheckpointGraceMs() + shutdownBudgetMs(rollbackSteps);
}
