import type { WorkflowExecution, WorkflowStep } from '@makaio/contracts';

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
 * Validate authored workflow step IDs and dependency graphs recursively.
 *
 * Runtime for-each expansion uses dot-delimited generated IDs, so authored IDs
 * must not contain dots at any nesting level.
 * @param steps - Authored steps to validate.
 * @throws Error when IDs are duplicated, dotted, cyclic, or depend on unknown IDs.
 */
export function validateAuthoredWorkflowSteps(steps: WorkflowStep[]): void {
  for (const step of steps) {
    if (step.id.includes('.')) {
      throw new Error(`Step ID '${step.id}' cannot contain '.'`);
    }
  }

  topologicalSort(steps);

  for (const step of steps) {
    if (step.type === 'for-each') {
      validateAuthoredWorkflowSteps(step.steps);
    }
  }
}

/**
 * Build initial runtime step states from authored workflow steps.
 * @param steps - Authored workflow DAG nodes.
 * @returns Initial execution step-state map.
 */
export function buildInitialStepStates(steps: WorkflowStep[]): WorkflowExecution['steps'] {
  return Object.fromEntries(
    steps.map((step) => [
      step.id,
      step.type === 'for-each'
        ? { kind: 'composite' as const, status: 'pending' as const }
        : { kind: 'executable' as const, status: 'pending' as const },
    ]),
  );
}
