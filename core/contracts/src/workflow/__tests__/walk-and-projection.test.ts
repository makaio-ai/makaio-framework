import { describe, it, expect } from 'vitest';
import type {
  WorkflowDefinition,
  WorkflowSequenceNode,
  WorkflowStationNode,
  WorkflowGateNode,
  WorkflowParallelNode,
  WorkflowIterateNode,
  WorkflowIterateChainNode,
  WorkflowLoopNode,
  WorkflowDelegateAgentNode,
  WorkflowDelegateRoleNode,
  WorkflowNode,
} from '../schemas.js';
import { walkWorkflowDefinition } from '../walk.js';
import { projectWorkflowGraph } from '../projection.js';

// ── Fixtures ─────────────────────────────────────────────────

function mkStation(id: string): WorkflowStationNode {
  return { type: 'station', id, prompt: `do ${id}` };
}

function mkGate(id: string): WorkflowGateNode {
  return { type: 'gate', id, prompt: 'approve?', autoAction: 'reject', timeoutMs: 60_000 };
}

function mkDelegateAgent(id: string): WorkflowDelegateAgentNode {
  return { type: 'delegate-agent', id, agentId: 'test-agent' };
}

function mkDelegateRole(id: string): WorkflowDelegateRoleNode {
  return { type: 'delegate-role', id, role: 'reviewer', prompt: 'review this' };
}

function mkSequence(id: string, nodes: WorkflowNode[]): WorkflowSequenceNode {
  return { type: 'sequence', id, nodes };
}

function mkParallel(id: string, branches: Record<string, WorkflowSequenceNode>): WorkflowParallelNode {
  return { type: 'parallel', id, branches };
}

function mkIterate(id: string, body: WorkflowSequenceNode): WorkflowIterateNode {
  return { type: 'iterate', id, collection: 'items', body };
}

function mkIterateChain(id: string, body: WorkflowSequenceNode): WorkflowIterateChainNode {
  return { type: 'iterate-chain', id, collection: 'items', body };
}

function mkLoop(id: string, body: WorkflowSequenceNode, maxRounds = 3): WorkflowLoopNode {
  return { type: 'loop', id, maxRounds, body, gate: { handler: 'my-gate' } };
}

function mkDefinition(root: WorkflowSequenceNode): WorkflowDefinition {
  return { id: 'test-wf', name: 'test', root, scope: { type: 'global' } };
}

// ── Walker tests ─────────────────────────────────────────────

describe('walkWorkflowDefinition', () => {
  it('visits a flat sequence in DFS order', () => {
    const root = mkSequence('root', [mkStation('a'), mkStation('b'), mkStation('c')]);
    const visited: string[] = [];
    walkWorkflowDefinition(root, { enter: (node) => void visited.push(node.id) });
    expect(visited).toEqual(['root', 'a', 'b', 'c']);
  });

  it('provides correct relationship and index for sequence children', () => {
    const root = mkSequence('root', [mkStation('a'), mkStation('b')]);
    const entries: Array<{ id: string; relationship: string; index?: number }> = [];
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        entries.push({ id: node.id, relationship: ctx.relationship, index: ctx.index });
      },
    });
    expect(entries).toEqual([
      { id: 'root', relationship: 'root', index: undefined },
      { id: 'a', relationship: 'sequence-child', index: 0 },
      { id: 'b', relationship: 'sequence-child', index: 1 },
    ]);
  });

  it('visits parallel branches with branchKey and relationship', () => {
    const root = mkSequence('root', [
      mkParallel('par', {
        frontend: mkSequence('fe-seq', [mkStation('fe-task')]),
        backend: mkSequence('be-seq', [mkStation('be-task')]),
      }),
    ]);
    const entries: Array<{ id: string; relationship: string; branchKey?: string }> = [];
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        entries.push({ id: node.id, relationship: ctx.relationship, branchKey: ctx.branchKey });
      },
    });
    expect(entries).toContainEqual({ id: 'fe-seq', relationship: 'parallel-branch', branchKey: 'frontend' });
    expect(entries).toContainEqual({ id: 'be-seq', relationship: 'parallel-branch', branchKey: 'backend' });
  });

  it('visits iterate body with correct relationship', () => {
    const body = mkSequence('body', [mkStation('item')]);
    const root = mkSequence('root', [mkIterate('iter', body)]);
    const entries: Array<{ id: string; relationship: string }> = [];
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        entries.push({ id: node.id, relationship: ctx.relationship });
      },
    });
    expect(entries).toContainEqual({ id: 'body', relationship: 'iterate-body' });
  });

  it('visits iterate-chain body with correct relationship', () => {
    const body = mkSequence('chain-body', [mkStation('step')]);
    const root = mkSequence('root', [mkIterateChain('chain', body)]);
    const entries: Array<{ id: string; relationship: string }> = [];
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        entries.push({ id: node.id, relationship: ctx.relationship });
      },
    });
    expect(entries).toContainEqual({ id: 'chain-body', relationship: 'iterate-chain-body' });
  });

  it('walks loop node body with loop-body relationship', () => {
    const root = mkSequence('root', [mkLoop('loop-1', mkSequence('loop-1__body', [mkStation('inner')]))]);
    const visited: Array<{ id: string; relationship: string; depth: number }> = [];
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        visited.push({ id: node.id, relationship: ctx.relationship, depth: ctx.depth });
      },
    });

    expect(visited).toContainEqual({ id: 'loop-1__body', relationship: 'loop-body', depth: 2 });
    expect(visited).toContainEqual({ id: 'inner', relationship: 'sequence-child', depth: 3 });
  });

  it('prunes subtree when enter returns false', () => {
    const root = mkSequence('root', [
      mkParallel('par', {
        a: mkSequence('a-seq', [mkStation('a1'), mkStation('a2')]),
        b: mkSequence('b-seq', [mkStation('b1')]),
      }),
    ]);
    const visited: string[] = [];
    walkWorkflowDefinition(root, {
      enter(node) {
        visited.push(node.id);
        if (node.id === 'a-seq') return false;
      },
    });
    expect(visited).toContain('a-seq');
    expect(visited).not.toContain('a1');
    expect(visited).not.toContain('a2');
    expect(visited).toContain('b1');
  });

  it('calls leave after all children are visited', () => {
    const root = mkSequence('root', [mkStation('a'), mkStation('b')]);
    const events: string[] = [];
    walkWorkflowDefinition(root, {
      enter: (node) => void events.push(`enter:${node.id}`),
      leave: (node) => void events.push(`leave:${node.id}`),
    });
    expect(events).toEqual(['enter:root', 'enter:a', 'leave:a', 'enter:b', 'leave:b', 'leave:root']);
  });

  it('does not call leave when enter prunes', () => {
    const root = mkSequence('root', [mkStation('pruned')]);
    const events: string[] = [];
    walkWorkflowDefinition(root, {
      enter(node) {
        events.push(`enter:${node.id}`);
        if (node.id === 'pruned') return false;
      },
      leave: (node) => void events.push(`leave:${node.id}`),
    });
    expect(events).toEqual(['enter:root', 'enter:pruned', 'leave:root']);
  });

  it('tracks depth and ancestors correctly through nesting', () => {
    const root = mkSequence('root', [
      mkParallel('par', {
        a: mkSequence('a-seq', [mkStation('deep')]),
      }),
    ]);
    const depths: Record<string, number> = {};
    const ancestorPaths: Record<string, readonly string[]> = {};
    walkWorkflowDefinition(root, {
      enter(node, ctx) {
        depths[node.id] = ctx.depth;
        ancestorPaths[node.id] = ctx.ancestors;
      },
    });
    expect(depths['root']).toBe(0);
    expect(depths['par']).toBe(1);
    expect(depths['a-seq']).toBe(2);
    expect(depths['deep']).toBe(3);
    expect(ancestorPaths['deep']).toEqual(['root', 'par', 'a-seq']);
  });

  it('visits all 9 node types', () => {
    const root = mkSequence('root', [
      mkStation('s'),
      mkGate('g'),
      mkDelegateAgent('da'),
      mkDelegateRole('dr'),
      mkParallel('p', { b: mkSequence('p-seq', []) }),
      mkIterate('i', mkSequence('i-body', [])),
      mkIterateChain('ic', mkSequence('ic-body', [])),
      mkLoop('l', mkSequence('l-body', [])),
    ]);
    const types = new Set<string>();
    walkWorkflowDefinition(root, { enter: (node) => void types.add(node.type) });
    expect(types).toEqual(
      new Set([
        'sequence',
        'station',
        'gate',
        'delegate-agent',
        'delegate-role',
        'parallel',
        'iterate',
        'iterate-chain',
        'loop',
      ]),
    );
  });
});

// ── Projection tests ─────────────────────────────────────────

describe('projectWorkflowGraph', () => {
  it('projects a flat sequence into nodes and edges', () => {
    const def = mkDefinition(mkSequence('root', [mkStation('a'), mkStation('b'), mkStation('c')]));
    const { nodes, edges } = projectWorkflowGraph(def);

    expect(nodes).toHaveLength(4);
    expect(nodes.map((n) => n.nodeId)).toEqual(['root', 'a', 'b', 'c']);

    // Sequence children get both contains and sequence edges
    const containsEdges = edges.filter((e) => e.kind === 'contains');
    expect(containsEdges).toHaveLength(3); // root→a, root→b, root→c

    const seqEdges = edges.filter((e) => e.kind === 'sequence');
    expect(seqEdges).toHaveLength(2);
    expect(seqEdges[0]!.sourceKey).toBe(nodes[1]!.key); // a → b
    expect(seqEdges[0]!.targetKey).toBe(nodes[2]!.key);
    expect(seqEdges[1]!.sourceKey).toBe(nodes[2]!.key); // b → c
    expect(seqEdges[1]!.targetKey).toBe(nodes[3]!.key);
  });

  it('classifies node roles correctly', () => {
    const def = mkDefinition(
      mkSequence('root', [
        mkStation('s'),
        mkGate('g'),
        mkDelegateAgent('da'),
        mkDelegateRole('dr'),
        mkParallel('p', { b: mkSequence('p-seq', []) }),
        mkIterate('i', mkSequence('i-body', [])),
        mkIterateChain('ic', mkSequence('ic-body', [])),
        mkLoop('l', mkSequence('l-body', [])),
      ]),
    );
    const { nodes } = projectWorkflowGraph(def);
    const roleMap = Object.fromEntries(nodes.map((n) => [n.nodeId, n.role]));

    expect(roleMap['root']).toBe('structural');
    expect(roleMap['s']).toBe('leaf');
    expect(roleMap['g']).toBe('leaf');
    expect(roleMap['da']).toBe('leaf');
    expect(roleMap['dr']).toBe('leaf');
    expect(roleMap['p']).toBe('control');
    expect(roleMap['i']).toBe('control');
    expect(roleMap['ic']).toBe('control');
    expect(roleMap['l']).toBe('control');
    expect(roleMap['p-seq']).toBe('structural');
    expect(roleMap['i-body']).toBe('structural');
    expect(roleMap['ic-body']).toBe('structural');
    expect(roleMap['l-body']).toBe('structural');
  });

  it('emits branch edges for parallel nodes', () => {
    const def = mkDefinition(
      mkSequence('root', [
        mkParallel('par', {
          fe: mkSequence('fe-seq', [mkStation('fe-task')]),
          be: mkSequence('be-seq', [mkStation('be-task')]),
        }),
      ]),
    );
    const { nodes, edges } = projectWorkflowGraph(def);
    const branchEdges = edges.filter((e) => e.kind === 'branch');

    const parNode = nodes.find((n) => n.nodeId === 'par')!;
    const feNode = nodes.find((n) => n.nodeId === 'fe-seq')!;
    const beNode = nodes.find((n) => n.nodeId === 'be-seq')!;

    expect(branchEdges).toHaveLength(2);
    expect(branchEdges).toContainEqual({ sourceKey: parNode.key, targetKey: feNode.key, kind: 'branch' });
    expect(branchEdges).toContainEqual({ sourceKey: parNode.key, targetKey: beNode.key, kind: 'branch' });

    expect(feNode.branchKey).toBe('fe');
    expect(beNode.branchKey).toBe('be');
  });

  it('emits body edges for iterate and iterate-chain nodes', () => {
    const def = mkDefinition(
      mkSequence('root', [
        mkIterate('iter', mkSequence('iter-body', [mkStation('item')])),
        mkIterateChain('chain', mkSequence('chain-body', [mkStation('step')])),
      ]),
    );
    const { nodes, edges } = projectWorkflowGraph(def);
    const bodyEdges = edges.filter((e) => e.kind === 'body');

    const iterNode = nodes.find((n) => n.nodeId === 'iter')!;
    const iterBody = nodes.find((n) => n.nodeId === 'iter-body')!;
    const chainNode = nodes.find((n) => n.nodeId === 'chain')!;
    const chainBody = nodes.find((n) => n.nodeId === 'chain-body')!;

    expect(bodyEdges).toHaveLength(2);
    expect(bodyEdges).toContainEqual({ sourceKey: iterNode.key, targetKey: iterBody.key, kind: 'body' });
    expect(bodyEdges).toContainEqual({ sourceKey: chainNode.key, targetKey: chainBody.key, kind: 'body' });
  });

  it('projects loop node as control with body edge', () => {
    const def = mkDefinition(mkSequence('root', [mkLoop('loop-1', mkSequence('loop-1__body', [mkStation('inner')]))]));
    const { nodes, edges } = projectWorkflowGraph(def);

    const loopNode = nodes.find((n) => n.nodeId === 'loop-1');
    expect(loopNode?.role).toBe('control');

    const bodyEdge = edges.find((e) => e.sourceKey === loopNode?.key && e.kind === 'body');
    expect(bodyEdge).toBeDefined();

    const bodyNode = nodes.find((n) => n.nodeId === 'loop-1__body');
    expect(bodyEdge?.targetKey).toBe(bodyNode?.key);
  });

  it('generates unique keys using path-derived identity', () => {
    const def = mkDefinition(
      mkSequence('root', [
        mkParallel('par', {
          a: mkSequence('branch-seq', [mkStation('task')]),
        }),
        mkIterate('iter', mkSequence('body-seq', [mkStation('item')])),
      ]),
    );
    const { nodes } = projectWorkflowGraph(def);
    const keys = nodes.map((n) => n.key);

    // All keys should be unique
    expect(new Set(keys).size).toBe(keys.length);

    // Branch node key includes branch segment
    const branchSeqNode = nodes.find((n) => n.nodeId === 'branch-seq')!;
    expect(branchSeqNode.key).toContain('b:a');

    // Body node key includes body segment
    const bodySeqNode = nodes.find((n) => n.nodeId === 'body-seq')!;
    expect(bodySeqNode.key).toContain('body');
  });

  it('encodes rich path segments with relationships', () => {
    const def = mkDefinition(
      mkSequence('root', [
        mkParallel('par', {
          fe: mkSequence('fe-seq', [mkStation('fe-task')]),
        }),
      ]),
    );
    const { nodes } = projectWorkflowGraph(def);
    const feTask = nodes.find((n) => n.nodeId === 'fe-task')!;

    expect(feTask.path).toEqual([
      { kind: 'node', id: 'root' },
      { kind: 'index', value: 0 },
      { kind: 'node', id: 'par' },
      { kind: 'branch', key: 'fe' },
      { kind: 'node', id: 'fe-seq' },
      { kind: 'index', value: 0 },
      { kind: 'node', id: 'fe-task' },
    ]);
  });

  it('sets parentKey correctly through nesting', () => {
    const def = mkDefinition(mkSequence('root', [mkStation('a')]));
    const { nodes } = projectWorkflowGraph(def);

    const rootNode = nodes.find((n) => n.nodeId === 'root')!;
    const aNode = nodes.find((n) => n.nodeId === 'a')!;

    expect(rootNode.parentKey).toBeUndefined();
    expect(aNode.parentKey).toBe(rootNode.key);
  });

  it('derives parentKey from traversal position when node IDs repeat', () => {
    const def = mkDefinition(mkSequence('dup', [mkSequence('container', [mkStation('dup')]), mkStation('after')]));
    const { nodes, edges } = projectWorkflowGraph(def);

    const rootNode = nodes[0]!;
    const afterNode = nodes.find((n) => n.nodeId === 'after')!;

    expect(afterNode.parentKey).toBe(rootNode.key);
    expect(edges).toContainEqual({ sourceKey: rootNode.key, targetKey: afterNode.key, kind: 'contains' });
  });

  it('generates distinct keys when sibling node IDs repeat', () => {
    const def = mkDefinition(mkSequence('root', [mkStation('dup'), mkStation('dup')]));
    const { nodes, edges } = projectWorkflowGraph(def);

    const duplicateNodes = nodes.filter((n) => n.nodeId === 'dup');

    expect(duplicateNodes).toHaveLength(2);
    expect(duplicateNodes[0]!.key).not.toBe(duplicateNodes[1]!.key);
    expect(edges).toContainEqual({
      sourceKey: duplicateNodes[0]!.key,
      targetKey: duplicateNodes[1]!.key,
      kind: 'sequence',
    });
  });
});
