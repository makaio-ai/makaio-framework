import { describe, expect, it } from 'vitest';
import { hydrateArtifactContextTree } from '../hydrate-context.js';
import type { ArtifactRevision, ResolvedArtifactContextWire } from '../index.js';

/**
 * Create a minimal artifact revision fixture.
 * @param kind - Artifact kind string.
 * @param id - Artifact identity.
 * @param revision - Revision identifier.
 * @param relations - Optional relation list.
 * @returns Artifact revision fixture.
 */
function makeArtifact(
  kind: string,
  id: string,
  revision: string,
  relations: ArtifactRevision['relations'] = [],
): ArtifactRevision {
  return {
    kind,
    id,
    revision,
    schemaVersion: 1,
    scope: { level: 'global' },
    data: { title: id },
    relations,
    actor: { kind: 'agent', id: 'agent-1' },
    timestamp: 1700000000000,
  };
}

describe('hydrateArtifactContextTree', () => {
  it('hydrates resolved and unresolved children from normalized wire entries', () => {
    const rootRef = {
      refClass: 'artifact' as const,
      kind: 'system',
      id: 'system-1',
      revision: 'rev-system',
    };
    const repoRef = {
      refClass: 'artifact' as const,
      kind: 'repo',
      id: 'repo-1',
      revision: 'rev-repo',
    };
    const missingRef = {
      refClass: 'artifact' as const,
      kind: 'repo',
      id: 'repo-2',
      revision: 'rev-missing',
    };
    const wire: ResolvedArtifactContextWire = {
      rootRef,
      refs: [
        {
          sourceRef: rootRef,
          target: repoRef,
          relationType: 'contains',
          hint: 'inline',
          status: 'resolved',
        },
        {
          sourceRef: rootRef,
          target: missingRef,
          relationType: 'contains',
          hint: 'inline',
          status: 'unresolved',
          reason: 'not-found',
        },
      ],
      resolved: [makeArtifact('system', 'system-1', 'rev-system'), makeArtifact('repo', 'repo-1', 'rev-repo')],
    };

    const tree = hydrateArtifactContextTree(wire);

    expect(tree.root.status).toBe('resolved');
    expect('relation' in tree.root).toBe(false);
    expect(tree.root.children).toHaveLength(2);
    expect(tree.flatten().map((artifact) => artifact.id)).toEqual(['system-1', 'repo-1']);
  });

  it('throws when the root artifact is missing from the resolved pool', () => {
    const rootRef = {
      refClass: 'artifact' as const,
      kind: 'system',
      id: 'system-1',
      revision: 'rev-system',
    };

    expect(() => hydrateArtifactContextTree({ rootRef, refs: [], resolved: [] })).toThrow();
  });

  it('throws when a resolved entry targets a non-artifact ref', () => {
    const rootRef = {
      refClass: 'artifact' as const,
      kind: 'system',
      id: 'system-1',
      revision: 'rev-system',
    };

    const wire = {
      rootRef,
      refs: [
        {
          sourceRef: rootRef,
          target: { refClass: 'evidence' as const, kind: 'source-file', id: 'docs/artifacts.md' },
          relationType: 'references',
          hint: 'link',
          status: 'resolved',
        },
      ],
      resolved: [makeArtifact('system', 'system-1', 'rev-system')],
    } as ResolvedArtifactContextWire;

    expect(() => hydrateArtifactContextTree(wire)).toThrow();
  });

  it('throws when a resolved entry omits its artifact from the resolved pool', () => {
    const rootRef = {
      refClass: 'artifact' as const,
      kind: 'system',
      id: 'system-1',
      revision: 'rev-system',
    };
    const missingRef = {
      refClass: 'artifact' as const,
      kind: 'repo',
      id: 'repo-1',
      revision: 'rev-repo',
    };

    const wire: ResolvedArtifactContextWire = {
      rootRef,
      refs: [
        {
          sourceRef: rootRef,
          target: missingRef,
          relationType: 'contains',
          hint: 'inline',
          status: 'resolved',
        },
      ],
      resolved: [makeArtifact('system', 'system-1', 'rev-system')],
    };

    expect(() => hydrateArtifactContextTree(wire)).toThrow();
  });

  it('does not recurse forever when wire entries contain a cycle marker', () => {
    const rootRef = {
      refClass: 'artifact' as const,
      kind: 'system',
      id: 'system-1',
      revision: 'rev-system',
    };
    const wire: ResolvedArtifactContextWire = {
      rootRef,
      refs: [
        {
          sourceRef: rootRef,
          target: rootRef,
          relationType: 'contains',
          hint: 'link',
          status: 'unresolved',
          reason: 'cycle-detected',
        },
      ],
      resolved: [makeArtifact('system', 'system-1', 'rev-system')],
    };

    const tree = hydrateArtifactContextTree(wire);

    expect(tree.root.children[0]?.status).toBe('unresolved');
    expect(tree.flatten()).toHaveLength(1);
  });

  it('detects cycles from resolved wire entries that form a back-edge', () => {
    const rootRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
    const childRef = { refClass: 'artifact' as const, kind: 'repo', id: 'repo-1', revision: 'rev-repo' };
    const wire: ResolvedArtifactContextWire = {
      rootRef,
      refs: [
        { sourceRef: rootRef, target: childRef, relationType: 'contains', hint: 'inline', status: 'resolved' },
        { sourceRef: childRef, target: rootRef, relationType: 'contains', hint: 'inline', status: 'resolved' },
      ],
      resolved: [makeArtifact('system', 'system-1', 'rev-system'), makeArtifact('repo', 'repo-1', 'rev-repo')],
    };

    const tree = hydrateArtifactContextTree(wire);

    expect(tree.root.children).toHaveLength(1);
    const child = tree.root.children[0]!;
    expect(child.status).toBe('resolved');
    if (child.status === 'resolved') {
      expect(child.children).toHaveLength(1);
      expect(child.children[0]?.status).toBe('unresolved');
      if (child.children[0]?.status === 'unresolved') {
        expect(child.children[0].reason).toBe('cycle-detected');
      }
    }
    expect(tree.flatten().map((a) => a.id)).toEqual(['system-1', 'repo-1']);
  });

  it('hydrates artifact refs with collision-safe identity keys', () => {
    const rootRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
    const firstRef = { refClass: 'artifact' as const, kind: 'a:b', id: 'c', revision: 'rev' };
    const secondRef = { refClass: 'artifact' as const, kind: 'a', id: 'b:c', revision: 'rev' };
    const wire: ResolvedArtifactContextWire = {
      rootRef,
      refs: [
        { sourceRef: rootRef, target: firstRef, relationType: 'contains', hint: 'inline', status: 'resolved' },
        { sourceRef: rootRef, target: secondRef, relationType: 'contains', hint: 'inline', status: 'resolved' },
      ],
      resolved: [
        makeArtifact('system', 'system-1', 'rev-system'),
        makeArtifact('a:b', 'c', 'rev'),
        makeArtifact('a', 'b:c', 'rev'),
      ],
    };

    const tree = hydrateArtifactContextTree(wire);

    expect(
      tree.root.children.map((child) => (child.status === 'resolved' ? [child.ref.kind, child.ref.id] : [])),
    ).toEqual([
      ['a:b', 'c'],
      ['a', 'b:c'],
    ]);
  });
});
