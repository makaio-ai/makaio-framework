/** Shared helpers for runtime shutdown ordering. */

/**
 * Async or sync shutdown callback collected during runtime boot.
 */
export type ShutdownStep = () => Promise<void> | void;

/**
 * Remove previously registered shutdown steps after a later phase establishes
 * the final steady-state teardown order.
 * @param shutdownSteps - Shared runtime shutdown list.
 * @param stepsToRemove - Specific step references to remove.
 */
export function removeShutdownSteps(shutdownSteps: ShutdownStep[], stepsToRemove: ReadonlyArray<ShutdownStep>): void {
  const removableCounts = new Map<ShutdownStep, number>();
  for (const step of stepsToRemove) {
    removableCounts.set(step, (removableCounts.get(step) ?? 0) + 1);
  }

  for (let index = shutdownSteps.length - 1; index >= 0; index -= 1) {
    const step = shutdownSteps[index];
    const remaining = removableCounts.get(step);
    if (remaining === undefined) continue;

    shutdownSteps.splice(index, 1);
    if (remaining === 1) removableCounts.delete(step);
    else removableCounts.set(step, remaining - 1);
  }
}
