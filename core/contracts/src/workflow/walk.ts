import type {
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from './schemas.js';

/** How the current node was reached from its parent. */
export type WalkRelationship = 'root' | 'sequence-child' | 'parallel-branch' | 'iterate-body' | 'iterate-chain-body';

/**
 * Context passed to visitor callbacks during workflow definition traversal.
 */
export interface WalkContext {
  /** Parent node, undefined for the root sequence node. */
  parent: WorkflowNode | undefined;
  /** Zero-based depth from the root node. */
  depth: number;
  /** Ordered path of ancestor node IDs (root-first, exclusive of current node). */
  ancestors: readonly string[];
  /** How this node was reached from its parent. */
  relationship: WalkRelationship;
  /** Zero-based index within the parent's child list (sequence children only). */
  index?: number;
  /** Branch key when reached via a parallel branch. */
  branchKey?: string;
}

/**
 * Visitor interface for {@link walkWorkflowDefinition}.
 */
export interface WorkflowNodeVisitor {
  /** Called before visiting children. Return `false` to skip the subtree. */
  enter?(node: WorkflowNode, context: WalkContext): void | false;
  /** Called after all children have been visited. */
  leave?(node: WorkflowNode, context: WalkContext): void;
}

/**
 * Depth-first walk over a workflow definition tree.
 *
 * Visits every node in the tree, calling `enter` before children and `leave`
 * after. Handles all 4 recursive child relationships: `sequence.nodes`,
 * `parallel.branches`, `iterate.body`, and `iterate-chain.body`.
 * @param root - Root sequence node of the workflow definition.
 * @param visitor - Visitor with optional `enter`/`leave` callbacks.
 */
export function walkWorkflowDefinition(root: WorkflowSequenceNode, visitor: WorkflowNodeVisitor): void {
  visitNode(root, visitor, undefined, 0, [], 'root', undefined, undefined);
}

/**
 * @param node - Current node to visit.
 * @param visitor - Visitor callbacks.
 * @param parent - Parent node (undefined for root).
 * @param depth - Zero-based nesting depth.
 * @param ancestors - Ancestor node IDs accumulated so far.
 * @param relationship - How this node was reached from its parent.
 * @param index - Child index within a sequence (undefined otherwise).
 * @param branchKey - Parallel branch key (undefined otherwise).
 */
function visitNode(
  node: WorkflowNode,
  visitor: WorkflowNodeVisitor,
  parent: WorkflowNode | undefined,
  depth: number,
  ancestors: string[],
  relationship: WalkRelationship,
  index: number | undefined,
  branchKey: string | undefined,
): void {
  const ctx: WalkContext = {
    parent,
    depth,
    ancestors,
    relationship,
    ...(index !== undefined && { index }),
    ...(branchKey !== undefined && { branchKey }),
  };

  if (visitor.enter?.(node, ctx) === false) return;

  const childAncestors = [...ancestors, node.id];
  const childDepth = depth + 1;

  switch (node.type) {
    case 'sequence': {
      const seq = node as WorkflowSequenceNode;
      for (let i = 0; i < seq.nodes.length; i++) {
        visitNode(seq.nodes[i]!, visitor, node, childDepth, childAncestors, 'sequence-child', i, undefined);
      }
      break;
    }
    case 'parallel': {
      const par = node as WorkflowParallelNode;
      for (const [key, branch] of Object.entries(par.branches)) {
        visitNode(branch, visitor, node, childDepth, childAncestors, 'parallel-branch', undefined, key);
      }
      break;
    }
    case 'iterate': {
      const iter = node as WorkflowIterateNode;
      visitNode(iter.body, visitor, node, childDepth, childAncestors, 'iterate-body', undefined, undefined);
      break;
    }
    case 'iterate-chain': {
      const chain = node as WorkflowIterateChainNode;
      visitNode(chain.body, visitor, node, childDepth, childAncestors, 'iterate-chain-body', undefined, undefined);
      break;
    }
    // Leaf nodes: station, delegate-agent, delegate-role, gate — no children.
  }

  visitor.leave?.(node, ctx);
}
