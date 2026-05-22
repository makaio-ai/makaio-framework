import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowStep } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { WorkflowExecution } from './storage/namespace.js';

type ExecutableStep = Exclude<WorkflowStep, { type: 'for-each' }>;

/**
 * Emit the `step.beforeStart` lifecycle event before any step state mutation.
 * Interceptors registered on this subject may throw to reject the step.
 * @param bus - Message bus for event emission.
 * @param executionId - Execution identifier.
 * @param step - The step about to start (agent, shell, or gate).
 */
export async function emitBeforeStepStart(bus: IMakaioBus, executionId: string, step: ExecutableStep): Promise<void> {
  await bus.emit(WorkflowSubjects.step.beforeStart, {
    executionId,
    stepId: step.id,
    stepType: step.type,
  });
}

/**
 * Transition a step's storage state to running (or waiting for gate steps).
 * @param bus - Message bus for storage writes.
 * @param execution - Mutable workflow execution state.
 * @param step - The step being started.
 */
export async function markStepRunning(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  step: ExecutableStep,
): Promise<void> {
  const state = execution.steps[step.id];
  state.status = step.type === 'gate' ? 'waiting' : 'running';
  state.startedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
}

/**
 * Emit the `step.started` lifecycle event after step state has been persisted.
 * @param bus - Message bus for event emission.
 * @param executionId - Execution identifier.
 * @param step - The step that has started.
 * @param sessionId - Optional coordinator session ID.
 * @param subagentId - Optional spawned subagent ID (agent steps only).
 */
export async function emitStepStarted(
  bus: IMakaioBus,
  executionId: string,
  step: ExecutableStep,
  sessionId?: string,
  subagentId?: string,
): Promise<void> {
  await bus.emit(WorkflowSubjects.step.started, {
    executionId,
    stepId: step.id,
    stepType: step.type,
    sessionId,
    subagentId,
  });
}
