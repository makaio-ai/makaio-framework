import type { WorkflowDefinition, WorkflowExecution, WorkflowStep } from '@makaio/contracts';
import type { ForEachStepContext } from './runtime-for-each.js';
import type { SchedulerGraph, SchedulerNode } from './types.js';
import { validateAuthoredWorkflowSteps } from './dag-utils.js';

/**
 * Parameters for rebuilding a scheduler graph from persisted state.
 */
export interface RebuildSchedulerGraphParams {
  /** The authored workflow definition (provides the initial step list). */
  workflow: WorkflowDefinition;
  /** The persisted execution state (step states carry expansion snapshots). */
  execution: WorkflowExecution;
}

/**
 * Reconstruct the mutable scheduler DAG from a persisted execution snapshot.
 *
 * Used for crash recovery and test verification. Restores the full node map
 * (authored steps + all expanded children) without re-evaluating `collection`
 * expressions — child steps are read directly from `CompositeStepState.expansion`.
 *
 * Steps performed:
 * 1. Collect all step definitions: authored steps + children from expansion snapshots.
 * 2. Wire all reverse (dependents) edges from `needs` sets.
 * 3. Apply parent-to-leaf rewiring (replace composite IDs with leaf IDs in downstream `needs`).
 *
 * The returned {@link SchedulerGraph} is read-only — mutations are only made by
 * a live `WorkflowScheduler` instance during an active execution.
 * @param params - Workflow definition and persisted execution state.
 * @returns Reconstructed scheduler graph.
 */
export function rebuildSchedulerGraph(params: RebuildSchedulerGraphParams): SchedulerGraph {
  const { workflow, execution } = params;
  const nodes = new Map<string, SchedulerNode>();
  const stepContext = new Map<string, ForEachStepContext>();

  validateAuthoredWorkflowSteps(workflow.steps);
  collectGraphNodes(nodes, stepContext, workflow.steps, execution.steps);
  wireReverseDependentEdges(nodes);
  rewireCompositesToLeaves(nodes, execution.steps);

  return { nodes, stepContext };
}

/**
 * Phase 1: Populate the node map with authored steps and all children found in
 * persisted expansion snapshots, without re-evaluating collection expressions.
 * @param nodes - Mutable node map to populate.
 * @param stepContext - Mutable item/index context map to populate.
 * @param authoredSteps - Top-level authored steps from the workflow definition.
 * @param stepStates - Persisted step states (carry expansion snapshots).
 */
function collectGraphNodes(
  nodes: Map<string, SchedulerNode>,
  stepContext: Map<string, ForEachStepContext>,
  authoredSteps: WorkflowStep[],
  stepStates: WorkflowExecution['steps'],
): void {
  const stepQueue: WorkflowStep[] = [...authoredSteps];
  const enqueued = new Set<string>(authoredSteps.map((s) => s.id));

  while (stepQueue.length > 0) {
    const step = stepQueue.shift()!;
    if (nodes.has(step.id)) {
      throw new Error(`Duplicate scheduler graph step ID: '${step.id}'`);
    }
    nodes.set(step.id, { step, needs: new Set(step.needs ?? []), dependents: new Set() });

    if (step.type === 'for-each') {
      const state = stepStates[step.id];
      if (state?.kind === 'composite' && state.expansion) {
        for (const [stepId, context] of Object.entries(state.expansion.stepContext)) {
          stepContext.set(stepId, context);
        }
        for (const childStep of state.expansion.childSteps) {
          if (enqueued.has(childStep.id)) {
            throw new Error(`Duplicate scheduler graph step ID: '${childStep.id}'`);
          }
          enqueued.add(childStep.id);
          stepQueue.push(childStep);
        }
      }
    }
  }
}

/**
 * Phase 2: Wire all reverse (dependents) edges from the populated `needs` sets.
 * @param nodes - Mutable node map with `needs` already populated.
 */
function wireReverseDependentEdges(nodes: Map<string, SchedulerNode>): void {
  for (const [id, node] of nodes) {
    for (const depId of node.needs) {
      const depNode = nodes.get(depId);
      if (!depNode) {
        throw new Error(`Step '${id}' depends on unknown step '${depId}'`);
      }
      depNode.dependents.add(id);
    }
  }
}

/**
 * Phase 3: Replace each composite node's ID in downstream `needs` with its leaf IDs,
 * mirroring the live scheduler's `rewireDownstreamDependencies` expansion step.
 * @param nodes - Mutable node map with `dependents` already wired.
 * @param stepStates - Persisted step states (carry expansion snapshots).
 */
function rewireCompositesToLeaves(nodes: Map<string, SchedulerNode>, stepStates: WorkflowExecution['steps']): void {
  for (const [, node] of nodes) {
    if (node.step.type !== 'for-each') continue;

    const state = stepStates[node.step.id];
    if (!state || state.kind !== 'composite' || !state.expansion) continue;

    const { leafStepIds } = state.expansion;
    const compositeId = node.step.id;

    for (const dependentId of node.dependents) {
      const dependentNode = nodes.get(dependentId);
      if (!dependentNode) continue;

      dependentNode.needs.delete(compositeId);
      for (const leafId of leafStepIds) {
        const leafNode = nodes.get(leafId);
        if (!leafNode) {
          throw new Error(`Composite '${compositeId}' expansion references unknown leaf step '${leafId}'`);
        }
        dependentNode.needs.add(leafId);
        leafNode.dependents.add(dependentId);
      }
    }
  }
}
