import type { WorkflowExecution, WorkflowStep } from '@makaio/contracts';
import { validateAuthoredWorkflowSteps } from './dag-utils.js';
import type { SchedulerNode } from './types.js';
import { isTerminalSatisfied } from './workflow-scheduler-state.js';

/**
 * Build the initial scheduler graph from authored steps.
 *
 * Composite for-each nodes are included as-is; they expand when scheduled.
 * @param steps - Authored workflow steps.
 * @param nodes - Mutable scheduler node map to populate.
 */
export function buildInitialSchedulerGraph(steps: WorkflowStep[], nodes: Map<string, SchedulerNode>): void {
  validateAuthoredWorkflowSteps(steps);

  for (const step of steps) {
    const needs = new Set(step.needs ?? []);
    nodes.set(step.id, {
      step,
      needs,
      dependents: new Set(),
    });
  }

  // Wire reverse (dependent) edges.
  for (const [nodeId, node] of nodes) {
    for (const depId of node.needs) {
      const depNode = nodes.get(depId);
      if (!depNode) {
        throw new Error(`Step '${nodeId}' depends on unknown step '${depId}'`);
      }
      depNode.dependents.add(nodeId);
    }
  }
}

/**
 * Find all graph nodes that are ready to schedule.
 *
 * A node is ready when:
 * - All its `needs` have reached a terminal-satisfied state (completed or skipped)
 * - It is not already in-flight
 * - Its execution state is still `pending`
 * @param nodes - Current scheduler graph.
 * @param execution - Mutable workflow execution state.
 * @param inFlight - Currently executing node promises keyed by step ID.
 * @returns Array of step IDs ready for scheduling.
 */
export function findReadySchedulerNodes(
  nodes: ReadonlyMap<string, SchedulerNode>,
  execution: WorkflowExecution,
  inFlight: ReadonlyMap<string, Promise<unknown>>,
): string[] {
  const ready: string[] = [];

  for (const [nodeId, node] of nodes) {
    if (inFlight.has(nodeId)) continue;

    const state = execution.steps[nodeId];
    if (!state || state.status !== 'pending') continue;

    let allNeedsMet = true;
    for (const depId of node.needs) {
      const depState = execution.steps[depId];
      if (!depState || !isTerminalSatisfied(depState.status)) {
        allNeedsMet = false;
        break;
      }
    }

    if (allNeedsMet) {
      ready.push(nodeId);
    }
  }

  return ready;
}

/**
 * Insert expanded child steps as new nodes in the scheduler graph.
 * @param nodes - Mutable scheduler graph.
 * @param childSteps - Expanded child step definitions.
 */
export function insertExpandedChildNodes(nodes: Map<string, SchedulerNode>, childSteps: WorkflowStep[]): void {
  // Create all nodes first.
  for (const child of childSteps) {
    if (nodes.has(child.id)) {
      throw new Error(`Runtime expanded step ID collision: '${child.id}'`);
    }
    const needs = new Set(child.needs ?? []);
    nodes.set(child.id, {
      step: child,
      needs,
      dependents: new Set(),
    });
  }

  // Wire bidirectional edges among children.
  for (const child of childSteps) {
    const childNode = nodes.get(child.id)!;
    for (const depId of childNode.needs) {
      const depNode = nodes.get(depId);
      if (!depNode) {
        throw new Error(`Runtime expanded step '${child.id}' depends on unknown step '${depId}'`);
      }
      depNode.dependents.add(child.id);
    }
  }
}

/**
 * Rewire all downstream dependents of a composite node to depend on `leafIds` instead.
 *
 * If `leafIds` is empty (skipped or empty collection), downstream steps have their
 * dependency on the composite node removed entirely, making them immediately schedulable.
 * @param nodes - Mutable scheduler graph.
 * @param compositeId - The composite step ID being replaced.
 * @param leafIds - The leaf step IDs to substitute as dependencies.
 */
export function rewireCompositeDownstreamDependencies(
  nodes: Map<string, SchedulerNode>,
  compositeId: string,
  leafIds: string[],
): void {
  const compositeNode = nodes.get(compositeId);
  if (!compositeNode) return;

  for (const dependentId of compositeNode.dependents) {
    const dependentNode = nodes.get(dependentId);
    if (!dependentNode) continue;

    // Replace the composite dependency with the leaf dependencies.
    dependentNode.needs.delete(compositeId);
    for (const leafId of leafIds) {
      const leafNode = nodes.get(leafId);
      if (!leafNode) {
        throw new Error(`Composite '${compositeId}' rewired '${dependentId}' to unknown leaf '${leafId}'`);
      }
      dependentNode.needs.add(leafId);
      // Register the reverse edge from leaf to dependent.
      leafNode.dependents.add(dependentId);
    }
  }
}
