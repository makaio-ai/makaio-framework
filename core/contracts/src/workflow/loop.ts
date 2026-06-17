import type { JsonValue } from '../shared/json-value.js';
import type {
  LoopGateOutcome,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from './schemas.js';

// ─────────────────────────────────────────────────────────────
// Loop Gate Context
// ─────────────────────────────────────────────────────────────

/**
 * Contextual data passed to a loop gate handler at evaluation time.
 *
 * The handler receives the current round number, max rounds, and
 * identifying information so it can make convergence decisions.
 */
export interface LoopGateContext {
  /** Execution ID of the running workflow. */
  readonly executionId: string;
  /** Node ID of the loop node being evaluated. */
  readonly nodeId: string;
  /** Current round number (1-based). */
  readonly round: number;
  /** Maximum rounds configured on the loop node. */
  readonly maxRounds: number;
}

/**
 * Gate handler function signature for loop convergence checks.
 *
 * Registered at runtime (not serialized in the definition); the
 * schema stores only the `handler` name string.
 * @param input - Gate input resolved from the `gate.input` expression.
 * @param config - Gate configuration from `gate.config`.
 * @param ctx - Loop gate context with round and execution metadata.
 * @returns The gate outcome determining the next loop action.
 */
export type LoopGateHandler = (input: JsonValue, config: JsonValue, ctx: LoopGateContext) => LoopGateOutcome;

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
