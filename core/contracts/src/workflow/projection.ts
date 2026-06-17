import type { WorkflowNodeType, WorkflowDefinition } from './schemas.js';
import { walkWorkflowDefinition, type WalkContext } from './walk.js';

// ── Path segments ────────────────────────────────────────────

/** A segment in the definition-tree path encoding the relationship to the parent. */
export type WorkflowDefinitionPathSegment =
  | { kind: 'node'; id: string }
  | { kind: 'branch'; key: string }
  | { kind: 'index'; value: number }
  | { kind: 'body' };

/**
 * Ordered sequence of path segments from the root to a given node.
 * Encodes identity, position, and structural relationships.
 */
export type WorkflowDefinitionPath = readonly WorkflowDefinitionPathSegment[];

// ── Node role ────────────────────────────────────────────────

/**
 * Node role in the static projection.
 *
 * - `leaf` — observable nodes that produce spans: station, delegate-agent, delegate-role, gate.
 * - `control` — container nodes with fan-out/fan-in semantics: parallel, iterate, iterate-chain.
 * - `structural` — organizational nodes in the static projection. Runtime frame
 *   correlation is only emitted when the runtime creates frames for that node type.
 */
export type ProjectedNodeRole = 'leaf' | 'control' | 'structural';

// ── Projected graph types ────────────────────────────────────

/**
 * A generic, UI-neutral projection of a workflow definition node.
 */
export interface ProjectedNode {
  /** Unique projection identity, derived from the definition-tree path. */
  key: string;
  /** Definition node ID — correlates with `WorkflowFrameState.nodeId` at runtime. */
  nodeId: string;
  /** Node type discriminant. */
  type: WorkflowNodeType;
  /** Node role in the static projection. */
  role: ProjectedNodeRole;
  /** Structured path encoding ancestor identities and relationships. */
  path: WorkflowDefinitionPath;
  /** Parent node's projection key, undefined for the root node. */
  parentKey: string | undefined;
  /** Branch key when this node is a direct child of a parallel branch. */
  branchKey?: string;
}

/** Edge kind describing the structural relationship between two projected nodes. */
export type ProjectedEdgeKind = 'sequence' | 'contains' | 'branch' | 'body';

/**
 * A generic, UI-neutral edge between two projected workflow nodes.
 *
 * Edge kinds describe static structural relationships, not runtime
 * execution flow. Consumers that need fan-in/fan-out edges should
 * derive them from the structural graph.
 */
export interface ProjectedEdge {
  /** Source node projection key. */
  sourceKey: string;
  /** Target node projection key. */
  targetKey: string;
  /** Structural relationship kind. */
  kind: ProjectedEdgeKind;
}

/**
 * Result of projecting a workflow definition into a flat graph.
 */
export interface ProjectedWorkflowGraph {
  /** All nodes in the definition tree, in DFS order. */
  nodes: ProjectedNode[];
  /** All structural edges between nodes. */
  edges: ProjectedEdge[];
}

// ── Internals ────────────────────────────────────────────────

/**
 * @param type - Workflow node type to classify.
 * @returns The role category for the given node type.
 */
function classifyRole(type: WorkflowNodeType): ProjectedNodeRole {
  switch (type) {
    case 'station':
    case 'delegate-agent':
    case 'delegate-role':
    case 'gate':
      return 'leaf';
    case 'parallel':
    case 'iterate':
    case 'iterate-chain':
    case 'loop':
      return 'control';
    case 'sequence':
      return 'structural';
  }
}

/**
 * @param relationship - How the node was reached.
 * @param branchKey - Branch key for parallel branches.
 * @param index - Sequence-child index.
 * @returns Relationship segment(s) to prepend before the node segment, if any.
 */
function relationshipSegments(
  relationship: WalkContext['relationship'],
  branchKey: string | undefined,
  index: number | undefined,
): WorkflowDefinitionPathSegment[] {
  if (relationship === 'parallel-branch' && branchKey !== undefined) {
    return [{ kind: 'branch', key: branchKey }];
  }
  if (relationship === 'sequence-child' && index !== undefined) {
    return [{ kind: 'index', value: index }];
  }
  if (relationship === 'iterate-body' || relationship === 'iterate-chain-body' || relationship === 'loop-body') {
    return [{ kind: 'body' }];
  }
  return [];
}

/**
 * @param raw - Raw string to escape for use in a `/`-separated key.
 * @returns Escaped string with `/` and `\` characters backslash-escaped.
 */
function escapeKeyComponent(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/\//g, '\\/');
}

/**
 * @param path - Structured path segments.
 * @returns Canonical `/`-separated string key for projection identity.
 */
function pathToKey(path: WorkflowDefinitionPath): string {
  return path
    .map((seg) => {
      switch (seg.kind) {
        case 'node':
          return `n:${escapeKeyComponent(seg.id)}`;
        case 'branch':
          return `b:${escapeKeyComponent(seg.key)}`;
        case 'index':
          return `i:${seg.value}`;
        case 'body':
          return 'body';
      }
    })
    .join('/');
}

// ── Public API ───────────────────────────────────────────────

/**
 * Project a workflow definition into a flat, UI-neutral graph of nodes and edges.
 *
 * The projection walks the definition tree and emits:
 * - One {@link ProjectedNode} per definition node (DFS order).
 * - Structural {@link ProjectedEdge}s describing sequence ordering,
 *   containment, branch, and body relationships.
 *
 * Edge kinds are structural — they describe the static definition topology,
 * not the runtime execution flow. Consumers that need execution-flow
 * semantics (e.g. fan-in/fan-out) should derive them from the structural graph.
 * @param definition - Workflow definition to project.
 * @returns Projected graph with nodes and edges.
 */
export function projectWorkflowGraph(definition: WorkflowDefinition): ProjectedWorkflowGraph {
  const nodes: ProjectedNode[] = [];
  const edges: ProjectedEdge[] = [];

  const lastChildKeyByParent = new Map<string, string>();

  // Mutable path stack: enter pushes segments, leave pops them.
  const pathStack: WorkflowDefinitionPathSegment[] = [];
  const keyStack: string[] = [];
  const pushCounts: number[] = [];

  walkWorkflowDefinition(definition.root, {
    enter(node, ctx: WalkContext) {
      // Push relationship segment(s) then the node segment.
      const relSegs = relationshipSegments(ctx.relationship, ctx.branchKey, ctx.index);
      const nodeSeg: WorkflowDefinitionPathSegment = { kind: 'node', id: node.id };
      pathStack.push(...relSegs, nodeSeg);
      pushCounts.push(relSegs.length + 1);

      const path: WorkflowDefinitionPath = [...pathStack];
      const key = pathToKey(path);
      const parentKey = keyStack.at(-1);

      nodes.push({
        key,
        nodeId: node.id,
        type: node.type,
        role: classifyRole(node.type),
        path,
        parentKey,
        ...(ctx.branchKey !== undefined && { branchKey: ctx.branchKey }),
      });

      if (parentKey !== undefined && ctx.parent !== undefined) {
        switch (ctx.parent.type) {
          case 'sequence': {
            edges.push({ sourceKey: parentKey, targetKey: key, kind: 'contains' });
            const lastSiblingKey = lastChildKeyByParent.get(parentKey);
            if (lastSiblingKey !== undefined) {
              edges.push({ sourceKey: lastSiblingKey, targetKey: key, kind: 'sequence' });
            }
            lastChildKeyByParent.set(parentKey, key);
            break;
          }
          case 'parallel':
            edges.push({ sourceKey: parentKey, targetKey: key, kind: 'branch' });
            break;
          case 'iterate':
          case 'iterate-chain':
          case 'loop':
            edges.push({ sourceKey: parentKey, targetKey: key, kind: 'body' });
            break;
          default:
            edges.push({ sourceKey: parentKey, targetKey: key, kind: 'contains' });
            break;
        }
      }

      keyStack.push(key);
    },
    leave() {
      const count = pushCounts.pop() ?? 0;
      pathStack.splice(pathStack.length - count, count);
      keyStack.pop();
    },
  });

  return { nodes, edges };
}
