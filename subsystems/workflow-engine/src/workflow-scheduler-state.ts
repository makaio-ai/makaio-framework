import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowExecution, WorkflowStep } from '@makaio/contracts';
import type { WorkflowExpressionContext } from '@makaio/expression';
import type { ActiveExecution, SchedulerNode } from './types.js';
import { persistStepStates } from './workflow-execution-persistence.js';

/**
 * Whether a step's execution status is terminal and satisfies downstream deps.
 * @param status - Step status to check.
 * @returns True when the status is `completed` or `skipped`.
 */
export function isTerminalSatisfied(status: string): boolean {
  return status === 'completed' || status === 'skipped';
}

/**
 * Build local step aliases for an expanded for-each body.
 * @param nodeId - Runtime namespaced node ID.
 * @param steps - Base expression step map keyed by runtime step ID.
 * @returns Aliases keyed by authored sibling step ID.
 */
export function buildLocalStepAliases(
  nodeId: string,
  steps: WorkflowExpressionContext['steps'],
): WorkflowExpressionContext['steps'] {
  const lastDot = nodeId.lastIndexOf('.');
  if (lastDot === -1) return {};

  const namespace = nodeId.slice(0, lastDot);
  const prefix = `${namespace}.`;
  const aliases: WorkflowExpressionContext['steps'] = {};

  for (const [stepId, stepValue] of Object.entries(steps)) {
    if (!stepId.startsWith(prefix)) continue;
    const localId = stepId.slice(prefix.length);
    if (localId.includes('.')) continue;
    aliases[localId] = stepValue;
  }

  return aliases;
}

/**
 * Validate runtime expanded child IDs before mutating execution or graph state.
 * @param childSteps - Expanded child steps.
 * @param execution - Mutable execution state.
 * @param active - Active execution registry entry.
 * @param nodes - Current scheduler graph nodes.
 */
export function assertChildStepIdsAvailable(
  childSteps: WorkflowStep[],
  execution: WorkflowExecution,
  active: ActiveExecution,
  nodes: ReadonlyMap<string, SchedulerNode>,
): void {
  const seen = new Set<string>();
  for (const childStep of childSteps) {
    if (seen.has(childStep.id)) {
      throw new Error(`Duplicate runtime expanded step ID: '${childStep.id}'`);
    }
    seen.add(childStep.id);
    if (nodes.has(childStep.id) || execution.steps[childStep.id] || active.stepMap.has(childStep.id)) {
      throw new Error(`Runtime expanded step ID collision: '${childStep.id}'`);
    }
  }
}

/**
 * Mark expanded composite nodes completed once their leaf nodes have settled.
 * @param bus - Message bus for persistence.
 * @param execution - Mutable execution state.
 * @returns Composite step IDs settled to completed.
 */
export async function settleCompletedCompositeNodes(bus: IMakaioBus, execution: WorkflowExecution): Promise<string[]> {
  const settledIds: string[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    const now = Date.now();

    for (const [stepId, stepState] of Object.entries(execution.steps)) {
      if (stepState.kind !== 'composite' || stepState.status !== 'expanding' || !stepState.expansion) continue;
      if (
        stepState.expansion.leafStepIds.every((leafId) => {
          const leafState = execution.steps[leafId];
          return leafState ? isTerminalSatisfied(leafState.status) : false;
        })
      ) {
        stepState.status = 'completed';
        stepState.completedAt = now;
        settledIds.push(stepId);
        changed = true;
      }
    }
  }

  if (settledIds.length > 0) {
    await persistStepStates(bus, execution, settledIds);
  }

  return settledIds;
}

/**
 * Mark expanded composite ancestors failed when one of their descendants fails.
 * @param execution - Mutable execution state.
 * @param failedStepId - Step that caused the execution failure.
 * @param error - Failure reason.
 * @returns Composite IDs changed to failed.
 */
export function markFailedAncestorCompositeNodes(
  execution: WorkflowExecution,
  failedStepId: string | undefined,
  error: string,
): string[] {
  if (!failedStepId) return [];

  const changedIds: string[] = [];
  const now = Date.now();

  for (const [stepId, stepState] of Object.entries(execution.steps)) {
    if (stepState.kind !== 'composite' || stepState.status !== 'expanding') continue;
    if (failedStepId !== stepId && !failedStepId.startsWith(`${stepId}.`)) continue;

    stepState.status = 'failed';
    stepState.error = error;
    stepState.completedAt = now;
    changedIds.push(stepId);
  }

  return changedIds;
}
