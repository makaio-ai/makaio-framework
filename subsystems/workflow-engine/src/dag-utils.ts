import type { WorkflowStep, StepState } from '@makaio/contracts';

/**
 * Internal graph representation built from a set of workflow steps.
 */
interface StepGraph {
  /** In-degree count per step. */
  inDegree: Map<string, number>;
  /** List of step IDs that depend on each step. */
  dependents: Map<string, string[]>;
  /** Set of all step IDs. */
  idSet: Set<string>;
}

/**
 * Validate steps and build adjacency graph for topological processing.
 * @param steps - Workflow steps to validate and graph
 * @returns Graph structure with in-degree and dependents maps
 * @throws Error on duplicate step IDs or unknown dependencies
 */
function buildStepGraph(steps: WorkflowStep[]): StepGraph {
  const idSet = new Set<string>();
  for (const step of steps) {
    if (idSet.has(step.id)) {
      throw new Error(`Duplicate step ID: '${step.id}'`);
    }
    idSet.add(step.id);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.needs ?? []) {
      if (!idSet.has(dep)) {
        throw new Error(`Step '${step.id}' depends on unknown step '${dep}'`);
      }
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      dependents.get(dep)!.push(step.id);
    }
  }

  return { inDegree, dependents, idSet };
}

/**
 * Topologically sort workflow steps using Kahn's algorithm.
 * @param steps - The workflow steps to sort
 * @returns Array of step IDs in topological order
 * @throws Error if duplicate step IDs, a cycle is detected, or a step references an unknown dependency
 */
export function topologicalSort(steps: WorkflowStep[]): string[] {
  const { inDegree, dependents } = buildStepGraph(steps);

  const queue: string[] = [];
  for (const [stepId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(stepId);
    }
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of dependents.get(current) ?? []) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);

      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== steps.length) {
    throw new Error('Cycle detected in workflow step dependencies');
  }

  return sorted;
}

/**
 * Group step IDs into topological levels for parallel execution.
 * Steps at the same level have no inter-dependencies and can run concurrently.
 * @param steps - Workflow steps with dependency edges
 * @returns Array of levels, each level is an array of step IDs
 * @throws Error if duplicate IDs, unknown dependency, or cycle detected
 */
export function groupByTopoLevel(steps: WorkflowStep[]): string[][] {
  const { inDegree, dependents } = buildStepGraph(steps);

  const levels: string[][] = [];
  let currentLevel = steps.filter((s) => inDegree.get(s.id) === 0).map((s) => s.id);
  let processed = 0;

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    processed += currentLevel.length;

    const nextLevel: string[] = [];
    for (const id of currentLevel) {
      for (const dependent of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextLevel.push(dependent);
        }
      }
    }
    currentLevel = nextLevel;
  }

  if (processed !== steps.length) {
    throw new Error('Cycle detected in workflow step dependencies');
  }

  return levels;
}

/**
 * Check whether all dependencies of a step are satisfied.
 * Dependencies are satisfied when their status is either 'completed' or 'skipped'.
 * @param stepId - The step ID to check
 * @param steps - All workflow steps
 * @param stepStates - Current state of all steps
 * @returns True when all dependencies are either 'completed' or 'skipped'; otherwise false
 */
export function areDependenciesMet(
  stepId: string,
  steps: WorkflowStep[],
  stepStates: Record<string, StepState>,
): boolean {
  const step = steps.find((s) => s.id === stepId);
  if (!step) {
    return false;
  }

  const dependencies = step.needs ?? [];
  if (dependencies.length === 0) {
    return true;
  }

  return dependencies.every((depId) => {
    const depState = stepStates[depId];
    return depState?.status === 'completed' || depState?.status === 'skipped';
  });
}
