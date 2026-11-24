import type {
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from './schemas.js';

import { WorkflowErrorCode } from './errors.js';
import { walkWorkflowDefinition } from './walk.js';

/**
 * Check that the convergence step belongs to the body and produces step output.
 * @param loop - Loop definition and its referenced step.
 * @returns An explanation when the reference does not identify an executable step in the body.
 */
export function validateLoopCheckStep(
  loop: WorkflowLoopNode,
): { message: string; code?: WorkflowErrorCode } | undefined {
  let matches = 0;
  let iteratorDepth = 0;
  let repeated = false;
  const isIterator = (node: WorkflowNode): boolean => node.type === 'iterate' || node.type === 'iterate-chain';
  walkWorkflowDefinition(loop.body, {
    enter(node) {
      if (isIterator(node)) iteratorDepth++;
      if ((node.type === 'code-step' || node.type === 'agent-step') && node.id === loop.check) {
        matches++;
        repeated ||= iteratorDepth > 0;
      }
    },
    leave(node) {
      if (isIterator(node)) iteratorDepth--;
    },
  });
  // Each round consumes one output. Iterators can execute the same check multiple times.
  if (repeated || matches > 1) {
    return {
      message: `Loop check '${loop.check}' must execute at most once per round`,
      code: WorkflowErrorCode.LOOP_CHECK_MULTIPLE,
    };
  }
  if (matches === 0) return { message: `Loop check '${loop.check}' must reference a step in its body` };
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// Nested Loop Validation
// ─────────────────────────────────────────────────────────────

/**
 * Validate that a loop node's body does not contain nested loop nodes.
 *
 * V1 of the workflow engine does not support nested loops. This function
 * walks the loop's body tree recursively, checking all container node
 * types (sequence, parallel, iterate, iterate-chain) for descendant
 * loop nodes.
 * @param loopNode - The loop node to validate.
 * @returns An error message if nested loops are found, or `undefined` if valid.
 */
export function validateNoNestedLoops(loopNode: WorkflowLoopNode): string | undefined {
  return findNestedLoop(loopNode.body.nodes, loopNode.id);
}

/**
 * Recursively search a node array for a loop node descendant.
 * @param nodes - The array of workflow nodes to search.
 * @param outerLoopId - The ID of the outer loop for error messages.
 * @returns An error message if a nested loop is found, or `undefined`.
 */
function findNestedLoop(nodes: WorkflowNode[], outerLoopId: string): string | undefined {
  for (const node of nodes) {
    if (node.type === 'loop') {
      return `Nested loop '${node.id}' found inside loop '${outerLoopId}' — V1 does not support nested loops`;
    }
    if (node.type === 'sequence') {
      const result = findNestedLoop((node as WorkflowSequenceNode).nodes, outerLoopId);
      if (result) return result;
    }
    if (node.type === 'parallel') {
      for (const branch of Object.values((node as WorkflowParallelNode).branches)) {
        const result = findNestedLoop(branch.nodes, outerLoopId);
        if (result) return result;
      }
    }
    if (node.type === 'iterate' || node.type === 'iterate-chain') {
      const body = (node as WorkflowIterateNode | WorkflowIterateChainNode).body;
      const result = findNestedLoop(body.nodes, outerLoopId);
      if (result) return result;
    }
  }
  return undefined;
}
