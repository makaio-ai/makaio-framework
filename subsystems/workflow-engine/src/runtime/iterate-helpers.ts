import { evaluateSync } from '@makaio/expression';
import type { JsonValue, WorkflowIterateChainNode, WorkflowIterateNode, WorkflowSequenceNode } from '@makaio/contracts';
import type { NodeOutcome } from './node-execution.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';

// ─────────────────────────────────────────────────────────────
// Shared collection evaluation
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a jexl `collection` expression against the current expression context
 * and return the resolved array.
 *
 * Returns a `NodeOutcome` failure when the expression throws or does not produce
 * an array, so both `iterate` and `iterate-chain` nodes share the same error
 * formatting without duplicating the try-catch block.
 * @param nodeId - Node identifier used in error messages.
 * @param nodeLabel - Human-readable node type label used in error messages (e.g. `'iterate'`).
 * @param collectionExpr - jexl expression string.
 * @param expressionCtx - Expression evaluation context.
 * @returns The resolved array, or a failed {@link NodeOutcome} when evaluation fails.
 */
export function evaluateCollection(
  nodeId: string,
  nodeLabel: string,
  collectionExpr: string,
  expressionCtx: PrimitiveExpressionContext,
): unknown[] | NodeOutcome {
  try {
    const raw = evaluateSync(collectionExpr, buildRuntimeExpressionScope(expressionCtx));
    if (!Array.isArray(raw)) {
      return {
        status: 'failed',
        error: `${nodeLabel} node '${nodeId}': collection expression did not resolve to an array (got ${typeof raw})`,
      };
    }
    return raw;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: `${nodeLabel} node '${nodeId}': collection expression evaluation failed: ${message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Shared body-output extraction
// ─────────────────────────────────────────────────────────────

/**
 * Extract the output of the last completed child frame that is a direct
 * child of the given parent frame.
 *
 * The sequence executor does not carry a single aggregate output; each child
 * node's output is stored individually in the frame registry. This helper
 * finds the last completed frame in sequence declaration order that:
 * - has `parentFrameId === containerFrameId`
 * - has a `nodeId` that appears in `sequence.nodes`
 *
 * Used by `iterate`, `iterate-chain`, and `parallel` to surface the effective
 * output of a body/branch sequence.
 * @param sequence - The sequence whose direct child nodes define the search scope.
 * @param containerFrameId - Frame ID of the enclosing container to scope the lookup.
 * @param ctx - Runtime context providing the frame registry.
 * @returns The last body node's output, or `undefined` if none was found.
 */
export function extractLastSequenceOutput(
  sequence: WorkflowSequenceNode,
  containerFrameId: string,
  ctx: RuntimeContext,
): JsonValue | undefined {
  for (const child of [...sequence.nodes].reverse()) {
    const frames = ctx.getFramesByNodeId(child.id);
    for (const f of frames) {
      if (f.parentFrameId === containerFrameId && f.status === 'completed') {
        return f.output;
      }
    }
  }

  return undefined;
}

/**
 * Extract the output of the last completed child frame within an
 * `iterate` or `iterate-chain` body, scoped to the given iteration frame.
 *
 * Convenience wrapper around {@link extractLastSequenceOutput} for the
 * iterate family of nodes.
 * @param node - The iterate or iterate-chain node (provides the body sequence).
 * @param iterationFrameId - Frame ID of the iteration frame to scope the lookup.
 * @param ctx - Runtime context providing the frame registry.
 * @returns The last body node's output, or `undefined` if none was found.
 */
export function extractLastBodyOutput(
  node: WorkflowIterateNode | WorkflowIterateChainNode,
  iterationFrameId: string,
  ctx: RuntimeContext,
): JsonValue | undefined {
  return extractLastSequenceOutput(node.body as WorkflowSequenceNode, iterationFrameId, ctx);
}
