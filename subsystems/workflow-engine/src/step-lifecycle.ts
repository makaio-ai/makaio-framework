import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowStep } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';

type ExecutableStep = Exclude<WorkflowStep, { type: 'for-each' }>;

/**
 * Emit `step.beforeStart` so interceptors can reject the step before state mutation.
 * @param bus - Message bus
 * @param executionId - Execution identifier
 * @param step - Step about to start
 */
export async function emitBeforeStepStart(bus: IMakaioBus, executionId: string, step: ExecutableStep): Promise<void> {
  await bus.emit(WorkflowSubjects.step.beforeStart, {
    executionId,
    stepId: step.id,
    stepType: step.type,
  });
}
