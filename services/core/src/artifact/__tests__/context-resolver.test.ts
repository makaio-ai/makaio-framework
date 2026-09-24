import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  hydrateArtifactContextTree,
  type ArtifactRef,
  type ArtifactRevision,
  type ResolvedArtifactContextWire,
} from '@makaio/contracts';
import { ArtifactRelationQueryTargetSchema } from '@makaio/contracts/artifact';
import { resolveArtifactContext } from '../context-resolver.js';

/**
 * Build a minimal artifact ref for test fixtures.
 * @param kind - Kind discriminator string.
 * @param id - Stable artifact identity.
 * @param revision - Revision identifier.
 * @returns An artifact ref.
 */
function ref(kind: string, id: string, revision: string): ArtifactRef {
  return { refClass: 'artifact', kind, id, revision };
}

/**
 * Build an unambiguous fixture map key from artifact identity fields.
 * @param target - Artifact identity fields to key.
 * @returns Stable fixture lookup key.
 */
function refKey(target: Pick<ArtifactRef, 'kind' | 'id' | 'revision'>): string {
  return JSON.stringify([target.kind, target.id, target.revision]);
}

/**
 * Build a minimal artifact revision for test fixtures.
 * @param kind - Kind discriminator string.
 * @param id - Stable artifact identity.
 * @param revision - Revision identifier.
 * @param relations - Optional outbound relations.
 * @returns A minimal valid artifact revision.
 */
function artifact(
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
    scope: {
      level: kind === 'system' ? 'global' : 'project',
      ids: kind === 'system' ? undefined : { projectId: 'p1' },
    },
    data: { title: id },
    relations,
    actor: { kind: 'agent', id: 'agent-1' },
    timestamp: 1700000000000,
  };
}

/**
 * Serve a fixture artifact store on the bus: `resolve` by exact revision and
 * `query` by relation type and target identity (whole-artifact or part targets).
 * @param bus - Bus to register the handlers on.
 * @param revisions - Revisions held by the fixture store.
 * @returns Unsubscribe callbacks and the log of received query payloads.
 */
function serveStore(
  bus: IMakaioBus,
  revisions: readonly ArtifactRevision[],
): { readonly cleanups: Array<() => void>; readonly queries: unknown[] } {
  const byKey = new Map(revisions.map((entry) => [refKey(entry), entry]));
  const queries: unknown[] = [];
  const cleanups = [
    bus.on(ArtifactSubjects.resolve, (ctx) => {
      ctx.setResult({ artifact: byKey.get(refKey(ctx.payload.ref)) ?? null });
    }),
    bus.on(ArtifactSubjects.query, (ctx) => {
      queries.push(ctx.payload);
      const wanted = ctx.payload.relation;
      const target = wanted ? ArtifactRelationQueryTargetSchema.parse(wanted.target) : undefined;
      ctx.setResult({
        artifacts: revisions.filter((entry) =>
          entry.relations.some((relation) => {
            if (relation.type !== wanted?.type || target?.refClass !== 'artifact') return false;
            const identity = relation.target.refClass === 'local' ? relation.target.artifact : relation.target;
            return identity.refClass === 'artifact' && identity.kind === target.kind && identity.id === target.id;
          }),
        ),
      });
    }),
  ];
  return { cleanups, queries };
}

/**
 * Project wire entries onto the fields the inbound traversal tests assert.
 * @param refs - Wire entries to project.
 * @returns Tuples of source id, target id, direction, status, and reason.
 */
function edges(refs: ResolvedArtifactContextWire['refs']): Array<Array<string | null>> {
  return refs.map((entry) => [
    entry.sourceRef.id,
    entry.target.refClass === 'artifact' ? entry.target.id : null,
    entry.direction ?? 'outbound',
    entry.status,
    entry.reason ?? null,
  ]);
}

describe('resolveArtifactContext', () => {
  let bus: IMakaioBus;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('walks explicitly nested selectors across outbound artifact relations', async () => {
    const contributor = artifact('contributor', 'contributor-1', 'rev-contributor');
    const repo = artifact('repo', 'repo-1', 'rev-repo', [
      {
        type: 'contains',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'repo-1', 'rev-repo') },
    ]);
    const artifacts = new Map(
      [system, repo, contributor].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: {
          kinds: ['repo'],
          hint: 'inline',
          nested: { contains: { kinds: ['contributor'], hint: 'summary' } },
        },
      },
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['system-1', 'repo-1', 'contributor-1']);
    expect(context.refs.map((entry) => [entry.relationType, entry.hint, entry.status])).toEqual([
      ['contains', 'inline', 'resolved'],
      ['contains', 'summary', 'resolved'],
    ]);
  });

  it('selects only the explicitly requested relation types', async () => {
    const repo = artifact('repo', 'repo-1', 'rev-repo');
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'repo-1', 'rev-repo') },
      {
        type: 'derives_from',
        target: ref('design', 'design-1', 'rev-design'),
      },
    ]);
    const artifacts = new Map([system, repo].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'link' } },
    });

    expect(context.refs).toEqual([
      expect.objectContaining({
        relationType: 'contains',
        hint: 'link',
        status: 'resolved',
      }),
      expect.objectContaining({
        relationType: 'derives_from',
        status: 'unresolved',
        reason: 'not-selected',
      }),
    ]);
  });

  it('resolves any artifact kind when the selector has no kind filter', async () => {
    const design = artifact('design', 'design-1', 'rev-design');
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('design', 'design-1', 'rev-design'),
      },
    ]);
    const artifacts = new Map([system, design].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'link' } },
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        relationType: 'contains',
        hint: 'link',
        status: 'resolved',
      }),
    );
    expect(context.resolved.map((entry) => entry.id)).toEqual(['system-1', 'design-1']);
  });

  it('applies selector kind filters before unsupported-ref-class for evidence refs', async () => {
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'evidenced_by',
        target: {
          refClass: 'evidence',
          kind: 'url',
          id: 'doc',
          locator: 'https://example.com',
        },
      },
    ]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const mismatchContext = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { evidenced_by: { kinds: ['commit'], hint: 'inline' } },
    });

    expect(mismatchContext.refs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'not-selected',
      }),
    );

    const selectedContext = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { evidenced_by: { hint: 'inline' } },
    });

    expect(selectedContext.refs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'unsupported-ref-class',
      }),
    );
  });

  it('emits not-selected before unsupported-ref-class for unselected evidence refs', async () => {
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'evidenced_by',
        target: {
          refClass: 'evidence',
          kind: 'url',
          id: 'doc',
          locator: 'https://example.com',
        },
      },
    ]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'not-selected',
      }),
    );
  });

  it('uses a per-call cache for shared immutable artifact refs', async () => {
    const shared = artifact('repo', 'shared-repo', 'rev-shared');
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'shared-repo', 'rev-shared'),
      },
      {
        type: 'contains',
        target: ref('repo', 'shared-repo', 'rev-shared'),
      },
    ]);
    const resolveSpy = vi.fn((target: { id: string }) =>
      target.id === 'system-1' ? system : target.id === 'shared-repo' ? shared : null,
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({ artifact: resolveSpy(ctx.payload.ref) });
      }),
    );

    await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'inline' } },
    });

    expect(resolveSpy.mock.calls.filter(([target]) => target.id === 'shared-repo')).toHaveLength(1);
  });

  it('keeps per-call artifact ref cache keys collision-safe', async () => {
    const firstRef = ref('a:b', 'c', 'rev');
    const secondRef = ref('a', 'b:c', 'rev');
    const first = artifact(firstRef.kind, firstRef.id, firstRef.revision);
    const second = artifact(secondRef.kind, secondRef.id, secondRef.revision);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: firstRef,
      },
      {
        type: 'contains',
        target: secondRef,
      },
    ]);
    const artifacts = new Map([system, first, second].map((entry) => [refKey(entry), entry]));
    const resolveSpy = vi.fn(
      (target: Pick<ArtifactRef, 'kind' | 'id' | 'revision'>) => artifacts.get(refKey(target)) ?? null,
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({ artifact: resolveSpy(ctx.payload.ref) });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: { kinds: ['a:b', 'a'], hint: 'inline' },
      },
    });

    expect(resolveSpy.mock.calls.map(([target]) => [target.kind, target.id])).toEqual([
      ['system', 'system-1'],
      ['a:b', 'c'],
      ['a', 'b:c'],
    ]);
    expect(context.resolved.map((entry) => [entry.kind, entry.id])).toEqual([
      ['system', 'system-1'],
      ['a:b', 'c'],
      ['a', 'b:c'],
    ]);
  });

  it('follows relations across multiple hops when depth exceeds 1', async () => {
    const contributor = artifact('contributor', 'contributor-1', 'rev-contributor');
    const repo = artifact('repo', 'repo-1', 'rev-repo', [
      {
        type: 'contains',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'repo-1', 'rev-repo'),
      },
    ]);
    const artifacts = new Map([system, repo, contributor].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: { depth: 2, hint: 'inline', kinds: ['repo', 'contributor'] },
      },
    });

    expect(context.resolved.map((e) => e.id)).toEqual(['system-1', 'repo-1', 'contributor-1']);
  });

  it('applies nested selectors at depth 1 without continuing the parent selector', async () => {
    const contributor = artifact('contributor', 'contributor-1', 'rev-contributor');
    const repo = artifact('repo', 'repo-1', 'rev-repo', [
      {
        type: 'contains',
        target: ref('design', 'design-1', 'rev-design'),
      },
      {
        type: 'derives_from',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'repo-1', 'rev-repo'),
      },
    ]);
    const artifacts = new Map([system, repo, contributor].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: {
          depth: 1,
          hint: 'inline',
          nested: {
            derives_from: { kinds: ['contributor'], hint: 'summary' },
          },
        },
      },
    });

    expect(context.refs.map((entry) => [entry.relationType, entry.hint, entry.status, entry.reason])).toEqual([
      ['contains', 'inline', 'resolved', undefined],
      ['contains', 'link', 'unresolved', 'not-selected'],
      ['derives_from', 'summary', 'resolved', undefined],
    ]);
  });

  it('applies nested selectors at the next traversal level', async () => {
    const contributor = artifact('contributor', 'contributor-1', 'rev-contributor');
    const repo = artifact('repo', 'repo-1', 'rev-repo', [
      {
        type: 'contains',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'repo-1', 'rev-repo'),
      },
    ]);
    const artifacts = new Map([system, repo, contributor].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: {
          hint: 'inline',
          nested: {
            contains: { kinds: ['contributor'], hint: 'summary' },
          },
        },
      },
    });

    expect(context.refs).toEqual([
      expect.objectContaining({
        relationType: 'contains',
        hint: 'inline',
        status: 'resolved',
      }),
      expect.objectContaining({
        relationType: 'contains',
        hint: 'summary',
        status: 'resolved',
      }),
    ]);
  });

  it('omits relation types explicitly marked omit', async () => {
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'repo-1', 'rev-repo'),
      },
    ]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'omit' } },
    });

    expect(context.refs).toEqual([]);
  });

  it('emits shared descendant refs once in the pathless wire graph', async () => {
    const contributor = artifact('contributor', 'contributor-1', 'rev-contributor');
    const sharedRepo = artifact('repo', 'shared-repo', 'rev-shared', [
      {
        type: 'contains',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'shared-repo', 'rev-shared'),
      },
      {
        type: 'derives_from',
        target: ref('repo', 'shared-repo', 'rev-shared'),
      },
    ]);
    const artifacts = new Map([system, sharedRepo, contributor].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: { kinds: ['repo'], hint: 'inline' },
        derives_from: { kinds: ['repo'], hint: 'inline' },
      },
    });

    expect(
      context.refs.map((entry) => [
        entry.sourceRef.id,
        entry.relationType,
        entry.target.refClass === 'artifact' ? entry.target.id : '',
      ]),
    ).toEqual([
      ['system-1', 'contains', 'shared-repo'],
      ['shared-repo', 'contains', 'contributor-1'],
      ['system-1', 'derives_from', 'shared-repo'],
    ]);
  });

  it('emits artifact cycle back-edges as resolved wire refs', async () => {
    const systemRef = ref('system', 'system-1', 'rev-system');
    const system = artifact('system', 'system-1', 'rev-system', [{ type: 'contains', target: systemRef }]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: systemRef,
      selectors: { contains: { kinds: ['system'], hint: 'inline' } },
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        status: 'resolved',
        target: systemRef,
      }),
    );
  });

  it('emits artifact cycle back-edges as resolved even at max depth', async () => {
    const systemRef = ref('system', 'system-1', 'rev-system');
    const system = artifact('system', 'system-1', 'rev-system', [{ type: 'contains', target: systemRef }]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: systemRef,
      maxDepth: 0,
      selectors: { contains: { kinds: ['system'], hint: 'inline' } },
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        status: 'resolved',
        target: systemRef,
      }),
    );
  });

  it('keeps shared-descendant back-edges path-local by emitting resolved refs', async () => {
    const parentARef = ref('repo', 'parent-a', 'rev-a');
    const parentBRef = ref('repo', 'parent-b', 'rev-b');
    const sharedRef = ref('contributor', 'shared', 'rev-shared');
    const shared = artifact('contributor', 'shared', 'rev-shared', [
      {
        type: 'contains',
        target: parentARef,
      },
    ]);
    const parentA = artifact('repo', 'parent-a', 'rev-a', [
      {
        type: 'contains',
        target: sharedRef,
      },
    ]);
    const parentB = artifact('repo', 'parent-b', 'rev-b', [
      {
        type: 'contains',
        target: sharedRef,
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: parentARef,
      },
      {
        type: 'derives_from',
        target: parentBRef,
      },
    ]);
    const artifacts = new Map(
      [system, parentA, parentB, shared].map((entry) => [refKey(ref(entry.kind, entry.id, entry.revision)), entry]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: artifacts.get(refKey(ctx.payload.ref)) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        contains: { depth: 3, kinds: ['repo', 'contributor'], hint: 'inline' },
        derives_from: {
          kinds: ['repo'],
          hint: 'inline',
          nested: {
            contains: { depth: 2, kinds: ['repo', 'contributor'], hint: 'inline' },
          },
        },
      },
    });

    expect(
      context.refs
        .filter((entry) => entry.sourceRef.id === 'shared')
        .map((entry) => [
          entry.relationType,
          entry.status,
          entry.target.refClass === 'artifact' ? entry.target.id : '',
        ]),
    ).toEqual([['contains', 'resolved', 'parent-a']]);
  });

  it('expands a shared source again when a later path makes its back-edge acyclic', async () => {
    const parentARef = ref('repo', 'parent-a', 'rev-a');
    const parentCRef = ref('repo', 'parent-c', 'rev-c');
    const sharedRef = ref('contributor', 'shared', 'rev-shared');
    const leafRef = ref('contributor', 'leaf', 'rev-leaf');
    const parentA = artifact('repo', 'parent-a', 'rev-a', [
      {
        type: 'contains',
        target: sharedRef,
      },
      {
        type: 'links',
        target: leafRef,
      },
    ]);
    const parentC = artifact('repo', 'parent-c', 'rev-c', [
      {
        type: 'contains',
        target: sharedRef,
      },
    ]);
    const shared = artifact('contributor', 'shared', 'rev-shared', [
      {
        type: 'contains',
        target: parentARef,
      },
    ]);
    const leaf = artifact('contributor', 'leaf', 'rev-leaf');
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'starts',
        target: parentARef,
      },
      {
        type: 'starts',
        target: parentCRef,
      },
    ]);
    const artifacts = new Map(
      [system, parentA, parentC, shared, leaf].map((entry) => [
        refKey(ref(entry.kind, entry.id, entry.revision)),
        entry,
      ]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: artifacts.get(refKey(ctx.payload.ref)) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        starts: {
          kinds: ['repo'],
          hint: 'inline',
          nested: {
            contains: {
              depth: 2,
              kinds: ['repo', 'contributor'],
              hint: 'inline',
              nested: {
                links: { kinds: ['contributor'], hint: 'inline' },
              },
            },
          },
        },
      },
    });

    expect(
      context.refs.map((entry) => [
        entry.sourceRef.id,
        entry.relationType,
        entry.status,
        entry.target.refClass === 'artifact' ? entry.target.id : '',
      ]),
    ).toContainEqual(['parent-a', 'links', 'resolved', 'leaf']);
  });

  it('marks selected non-artifact targets as unsupported-ref-class', async () => {
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: {
          refClass: 'evidence',
          kind: 'url',
          id: 'doc',
          locator: 'https://example.com',
        },
      },
    ]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'inline' } },
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'unsupported-ref-class',
      }),
    );
  });

  it('retains entity refs without resolving them as artifacts or matching their type as an artifact kind', async () => {
    const target = { refClass: 'entity' as const, entityType: 'repo', id: 'core-entity-1' };
    const system = artifact('system', 'system-1', 'rev-system', [{ type: 'contains', target }]);
    const resolvedIds: string[] = [];
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        resolvedIds.push(ctx.payload.ref.id);
        ctx.setResult({ artifact: ctx.payload.ref.id === system.id ? system : null });
      }),
    );

    const selected = await resolveArtifactContext({
      bus,
      ref: ref('system', system.id, system.revision),
      selectors: { contains: { hint: 'inline' } },
    });
    expect(selected.refs[0]).toMatchObject({ target, status: 'unresolved', reason: 'unsupported-ref-class' });

    const filtered = await resolveArtifactContext({
      bus,
      ref: ref('system', system.id, system.revision),
      selectors: { contains: { kinds: ['repo'], hint: 'inline' } },
    });
    expect(filtered.refs[0]).toMatchObject({ target, status: 'unresolved', reason: 'not-selected' });
    expect(resolvedIds).toEqual([system.id, system.id]);
  });

  it('marks relations as depth-exceeded when maxDepth is reached', async () => {
    const repo = artifact('repo', 'repo-1', 'rev-repo', [
      {
        type: 'contains',
        target: ref('contributor', 'contributor-1', 'rev-contributor'),
      },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'repo-1', 'rev-repo') },
    ]);
    const artifacts = new Map([system, repo].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'inline', depth: 2 } },
      maxDepth: 1,
    });

    expect(context.refs[1]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'depth-exceeded',
      }),
    );
  });

  it('keeps depth-exceeded over resolved back-edges for the same pathless relation', async () => {
    const a = artifact('repo', 'a', 'rev-a', [{ type: 'contains', target: ref('repo', 'c', 'rev-c') }]);
    const b = artifact('repo', 'b', 'rev-b', [{ type: 'contains', target: ref('repo', 'c', 'rev-c') }]);
    const c = artifact('repo', 'c', 'rev-c', [{ type: 'contains', target: ref('repo', 'a', 'rev-a') }]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'a', 'rev-a') },
      { type: 'contains', target: ref('repo', 'b', 'rev-b') },
    ]);
    const artifacts = new Map([system, a, b, c].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      maxDepth: 2,
      selectors: {
        contains: {
          kinds: ['repo'],
          hint: 'inline',
          nested: {
            contains: {
              kinds: ['repo'],
              hint: 'inline',
              nested: {
                contains: { kinds: ['repo'], hint: 'inline' },
              },
            },
          },
        },
      },
    });

    expect(context.refs).toContainEqual(
      expect.objectContaining({
        sourceRef: ref('repo', 'c', 'rev-c'),
        target: ref('repo', 'a', 'rev-a'),
        status: 'unresolved',
        reason: 'depth-exceeded',
      }),
    );
  });

  it('keeps normally resolved refs when the same source relation is later depth-exceeded', async () => {
    const sharedRef = ref('repo', 'shared', 'rev-shared');
    const parentRef = ref('repo', 'parent', 'rev-parent');
    const targetRef = ref('contributor', 'target', 'rev-target');
    const target = artifact('contributor', 'target', 'rev-target');
    const shared = artifact('repo', 'shared', 'rev-shared', [{ type: 'contains', target: targetRef }]);
    const parent = artifact('repo', 'parent', 'rev-parent', [{ type: 'contains', target: sharedRef }]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: sharedRef },
      { type: 'contains', target: parentRef },
    ]);
    const artifacts = new Map([system, parent, shared, target].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      maxDepth: 2,
      selectors: {
        contains: { depth: 3, kinds: ['repo', 'contributor'], hint: 'inline' },
      },
    });

    expect(context.refs).toContainEqual(
      expect.objectContaining({
        sourceRef: sharedRef,
        target: targetRef,
        status: 'resolved',
      }),
    );
  });

  it('lets later shallow resolutions replace depth-exceeded refs for the same source relation', async () => {
    const sharedRef = ref('repo', 'shared', 'rev-shared');
    const parentRef = ref('repo', 'parent', 'rev-parent');
    const targetRef = ref('contributor', 'target', 'rev-target');
    const target = artifact('contributor', 'target', 'rev-target');
    const shared = artifact('repo', 'shared', 'rev-shared', [{ type: 'contains', target: targetRef }]);
    const parent = artifact('repo', 'parent', 'rev-parent', [{ type: 'contains', target: sharedRef }]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: parentRef },
      { type: 'contains', target: sharedRef },
    ]);
    const artifacts = new Map([system, parent, shared, target].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      maxDepth: 2,
      selectors: {
        contains: { depth: 3, kinds: ['repo', 'contributor'], hint: 'inline' },
      },
    });

    expect(context.refs).toContainEqual(
      expect.objectContaining({
        sourceRef: sharedRef,
        target: targetRef,
        status: 'resolved',
      }),
    );
  });

  it('keeps precise unresolved refs when the same source relation is later depth-exceeded', async () => {
    const sharedRef = ref('repo', 'shared', 'rev-shared');
    const parentRef = ref('repo', 'parent', 'rev-parent');
    const missingRef = ref('contributor', 'missing', 'rev-missing');
    const shared = artifact('repo', 'shared', 'rev-shared', [{ type: 'contains', target: missingRef }]);
    const parent = artifact('repo', 'parent', 'rev-parent', [{ type: 'contains', target: sharedRef }]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: sharedRef },
      { type: 'contains', target: parentRef },
    ]);
    const artifacts = new Map([system, parent, shared].map((e) => [`${e.kind}:${e.id}:${e.revision}`, e]));
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const t = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${t.kind}:${t.id}:${t.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      maxDepth: 2,
      selectors: {
        contains: { depth: 3, kinds: ['repo', 'contributor'], hint: 'inline' },
      },
    });

    const sharedMissingRefs = context.refs.filter(
      (entry) =>
        refKey(entry.sourceRef) === refKey(sharedRef) &&
        entry.relationType === 'contains' &&
        entry.target.refClass === 'artifact' &&
        refKey(entry.target) === refKey(missingRef),
    );
    expect(sharedMissingRefs).toHaveLength(1);
    expect(sharedMissingRefs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'not-found',
      }),
    );
  });

  it('lets selected precise unresolved refs replace earlier not-selected refs', async () => {
    const sharedRef = ref('repo', 'shared', 'rev-shared');
    const firstParentRef = ref('repo', 'first-parent', 'rev-first-parent');
    const secondParentRef = ref('repo', 'second-parent', 'rev-second-parent');
    const missingRef = ref('contributor', 'missing', 'rev-missing');
    const shared = artifact('repo', 'shared', 'rev-shared', [{ type: 'contains', target: missingRef }]);
    const firstParent = artifact('repo', 'first-parent', 'rev-first-parent', [{ type: 'contains', target: sharedRef }]);
    const secondParent = artifact('repo', 'second-parent', 'rev-second-parent', [
      { type: 'contains', target: sharedRef },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'first_path', target: firstParentRef },
      { type: 'second_path', target: secondParentRef },
    ]);
    const artifacts = new Map(
      [system, firstParent, secondParent, shared].map((entry) => [
        `${entry.kind}:${entry.id}:${entry.revision}`,
        entry,
      ]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: {
        first_path: {
          depth: 2,
          kinds: ['repo'],
          nested: {
            contains: { depth: 2, kinds: ['repo'], hint: 'summary' },
          },
        },
        second_path: {
          depth: 2,
          kinds: ['repo'],
          nested: {
            contains: {
              depth: 2,
              kinds: ['repo'],
              hint: 'inline',
              nested: {
                contains: { kinds: ['contributor'], hint: 'inline' },
              },
            },
          },
        },
      },
    });

    const sharedMissingRefs = context.refs.filter(
      (entry) =>
        refKey(entry.sourceRef) === refKey(sharedRef) &&
        entry.relationType === 'contains' &&
        entry.target.refClass === 'artifact' &&
        refKey(entry.target) === refKey(missingRef),
    );
    expect(sharedMissingRefs).toHaveLength(1);
    expect(sharedMissingRefs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'not-found',
      }),
    );
  });

  it('keeps depth-exceeded refs when the same source relation is later not-selected', async () => {
    const sharedRef = ref('repo', 'shared', 'rev-shared');
    const firstParentRef = ref('repo', 'first-parent', 'rev-first-parent');
    const secondParentRef = ref('repo', 'second-parent', 'rev-second-parent');
    const missingRef = ref('contributor', 'missing', 'rev-missing');
    const shared = artifact('repo', 'shared', 'rev-shared', [{ type: 'contains', target: missingRef }]);
    const firstParent = artifact('repo', 'first-parent', 'rev-first-parent', [{ type: 'contains', target: sharedRef }]);
    const secondParent = artifact('repo', 'second-parent', 'rev-second-parent', [
      { type: 'contains', target: sharedRef },
    ]);
    const system = artifact('system', 'system-1', 'rev-system', [
      { type: 'first_path', target: firstParentRef },
      { type: 'second_path', target: secondParentRef },
    ]);
    const artifacts = new Map(
      [system, firstParent, secondParent, shared].map((entry) => [
        `${entry.kind}:${entry.id}:${entry.revision}`,
        entry,
      ]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({
          artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      maxDepth: 2,
      selectors: {
        first_path: {
          depth: 2,
          kinds: ['repo'],
          nested: {
            contains: {
              depth: 2,
              kinds: ['repo'],
              hint: 'inline',
              nested: {
                contains: { kinds: ['contributor'], hint: 'inline' },
              },
            },
          },
        },
        second_path: {
          depth: 2,
          kinds: ['repo'],
          nested: {
            contains: { depth: 2, kinds: ['repo'], hint: 'summary' },
          },
        },
      },
    });

    const sharedMissingRefs = context.refs.filter(
      (entry) =>
        refKey(entry.sourceRef) === refKey(sharedRef) &&
        entry.relationType === 'contains' &&
        entry.target.refClass === 'artifact' &&
        refKey(entry.target) === refKey(missingRef),
    );
    expect(sharedMissingRefs).toHaveLength(1);
    expect(sharedMissingRefs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'depth-exceeded',
      }),
    );
  });

  it('marks child artifacts as not-found when resolution returns null', async () => {
    const system = artifact('system', 'system-1', 'rev-system', [
      {
        type: 'contains',
        target: ref('repo', 'missing-repo', 'rev-missing'),
      },
    ]);
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({
          artifact: ctx.payload.ref.id === 'system-1' ? system : null,
        });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { hint: 'inline' } },
    });

    expect(context.refs[0]).toEqual(
      expect.objectContaining({
        status: 'unresolved',
        reason: 'not-found',
      }),
    );
  });

  it('throws when the root artifact is not found', async () => {
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({ artifact: null });
      }),
    );

    await expect(
      resolveArtifactContext({
        bus,
        ref: ref('system', 'missing', 'rev-missing'),
      }),
    ).rejects.toThrow("root artifact 'system:missing:rev-missing' not found");
  });

  it('selects artifacts whose relations point at the walked artifact when the selector is inbound', async () => {
    const parent = artifact('knowledge-document', 'parent-1', 'rev-2');
    const childA = artifact('knowledge-document', 'child-a', 'rev-1', [
      { type: 'part_of', target: ref('knowledge-document', 'parent-1', 'rev-1') },
    ]);
    const childB = artifact('knowledge-document', 'child-b', 'rev-3', [
      { type: 'part_of', target: ref('knowledge-document', 'parent-1', 'rev-2'), sourceLocalId: 'section-2' },
    ]);
    const other = artifact('note', 'note-1', 'rev-1', [
      { type: 'part_of', target: ref('knowledge-document', 'parent-1', 'rev-2') },
    ]);
    const artifacts = new Map(
      [parent, childA, childB, other].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]),
    );
    const queries: unknown[] = [];
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({ artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null });
      }),
      bus.on(ArtifactSubjects.query, (ctx) => {
        queries.push(ctx.payload);
        ctx.setResult({ artifacts: [childA, childB, other] });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('knowledge-document', 'parent-1', 'rev-2'),
      selectors: { part_of: { direction: 'inbound', kinds: ['knowledge-document'], hint: 'section' } },
    });

    expect(queries).toEqual([
      {
        relation: { type: 'part_of', target: { refClass: 'artifact', kind: 'knowledge-document', id: 'parent-1' } },
        currentOnly: true,
      },
    ]);
    expect(context.resolved.map((entry) => entry.id)).toEqual(['parent-1', 'child-a', 'child-b']);
    expect(
      context.refs.map((entry) => [
        entry.sourceRef.id,
        entry.target.refClass === 'artifact' ? entry.target.id : null,
        entry.direction,
        entry.sourceLocalId ?? null,
        entry.hint,
        entry.status,
        entry.reason ?? null,
      ]),
    ).toEqual([
      ['parent-1', 'child-a', 'inbound', null, 'section', 'resolved', null],
      // The child's own stored relation back to the parent is walked outbound and stays unselected.
      ['child-a', 'parent-1', undefined, null, 'link', 'unresolved', 'not-selected'],
      ['parent-1', 'child-b', 'inbound', 'section-2', 'section', 'resolved', null],
      ['child-b', 'parent-1', undefined, 'section-2', 'link', 'unresolved', 'not-selected'],
      ['parent-1', 'note-1', 'inbound', null, 'section', 'unresolved', 'not-selected'],
    ]);

    const tree = hydrateArtifactContextTree(context);
    expect(
      tree.root.children.map((node) => [
        node.status,
        node.relation,
        node.direction,
        node.status === 'resolved' ? node.ref.id : null,
      ]),
    ).toEqual([
      ['resolved', 'part_of', 'inbound', 'child-a'],
      ['resolved', 'part_of', 'inbound', 'child-b'],
      ['unresolved', 'part_of', 'inbound', null],
    ]);
  });

  it('does not select the stored outbound relation of a type declared inbound', async () => {
    const referenced = artifact('repo', 'repo-1', 'rev-repo');
    const root = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'repo-1', 'rev-repo') },
    ]);
    const artifacts = new Map(
      [root, referenced].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({ artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null });
      }),
      bus.on(ArtifactSubjects.query, (ctx) => {
        ctx.setResult({ artifacts: [] });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { direction: 'inbound' } },
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['system-1']);
    expect(context.refs.map((entry) => [entry.direction ?? 'outbound', entry.status, entry.reason])).toEqual([
      ['outbound', 'unresolved', 'not-selected'],
    ]);
  });

  it('ignores inbound relations that target a part of the walked artifact', async () => {
    const parent = artifact('knowledge-document', 'parent-1', 'rev-1');
    const partSource = artifact('note', 'note-1', 'rev-1', [
      {
        type: 'part_of',
        target: { refClass: 'local', artifact: ref('knowledge-document', 'parent-1', 'rev-1'), localId: 'section-1' },
      },
    ]);
    const store = serveStore(bus, [parent, partSource]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('knowledge-document', 'parent-1', 'rev-1'),
      selectors: { part_of: { direction: 'inbound' } },
    });

    expect(store.queries).toHaveLength(1);
    expect(context.refs).toEqual([]);
    expect(context.resolved.map((entry) => entry.id)).toEqual(['parent-1']);
  });

  it('issues one inbound query per relation type and identity across a diamond graph', async () => {
    const detail = artifact('note', 'd', 'rev-d', [{ type: 'part_of', target: ref('doc', 'c', 'rev-c') }]);
    const shared = artifact('doc', 'c', 'rev-c');
    const left = artifact('doc', 'a', 'rev-a', [{ type: 'contains', target: ref('doc', 'c', 'rev-c') }]);
    const right = artifact('doc', 'b', 'rev-b', [{ type: 'contains', target: ref('doc', 'c', 'rev-c') }]);
    const root = artifact('doc', 'root', 'rev-root', [
      { type: 'contains', target: ref('doc', 'a', 'rev-a') },
      { type: 'contains', target: ref('doc', 'b', 'rev-b') },
    ]);
    const store = serveStore(bus, [root, left, right, shared, detail]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'root', 'rev-root'),
      selectors: { contains: { nested: { contains: { nested: { part_of: { direction: 'inbound' } } } } } },
    });

    expect(store.queries).toHaveLength(1);
    expect(context.resolved.map((entry) => entry.id)).toEqual(['root', 'a', 'c', 'd', 'b']);
    expect(edges(context.refs)).toEqual([
      ['root', 'a', 'outbound', 'resolved', null],
      ['a', 'c', 'outbound', 'resolved', null],
      ['c', 'd', 'inbound', 'resolved', null],
      ['d', 'c', 'outbound', 'unresolved', 'not-selected'],
      ['root', 'b', 'outbound', 'resolved', null],
      ['b', 'c', 'outbound', 'resolved', null],
    ]);
  });

  it('follows inbound relations of inbound sources when the inbound selector has depth 2', async () => {
    const root = artifact('doc', 'root', 'rev-root');
    const child = artifact('doc', 'child', 'rev-child', [{ type: 'part_of', target: ref('doc', 'root', 'rev-root') }]);
    const grandchild = artifact('doc', 'grandchild', 'rev-grandchild', [
      { type: 'part_of', target: ref('doc', 'child', 'rev-child') },
    ]);
    const store = serveStore(bus, [root, child, grandchild]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'root', 'rev-root'),
      selectors: { part_of: { direction: 'inbound', depth: 2 } },
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['root', 'child', 'grandchild']);
    expect(edges(context.refs)).toEqual([
      ['root', 'child', 'inbound', 'resolved', null],
      ['child', 'root', 'outbound', 'unresolved', 'not-selected'],
      ['child', 'grandchild', 'inbound', 'resolved', null],
      ['grandchild', 'child', 'outbound', 'unresolved', 'not-selected'],
    ]);
    const tree = hydrateArtifactContextTree(context);
    const [childNode] = tree.root.children;
    expect(childNode?.status === 'resolved' ? childNode.ref.id : null).toBe('child');
    expect(
      childNode?.status === 'resolved'
        ? childNode.children.map((node) => [node.direction, node.status === 'resolved' ? node.ref.id : null])
        : null,
    ).toEqual([
      [undefined, null],
      ['inbound', 'grandchild'],
    ]);
  });

  it('applies nested outbound selectors to an inbound source', async () => {
    const root = artifact('doc', 'root', 'rev-root');
    const tool = artifact('tool', 'tool-1', 'rev-tool');
    const child = artifact('doc', 'child', 'rev-child', [
      { type: 'part_of', target: ref('doc', 'root', 'rev-root') },
      { type: 'uses', target: ref('tool', 'tool-1', 'rev-tool') },
    ]);
    const store = serveStore(bus, [root, child, tool]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'root', 'rev-root'),
      selectors: { part_of: { direction: 'inbound', nested: { uses: { hint: 'inline' } } } },
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['root', 'child', 'tool-1']);
    expect(edges(context.refs)).toEqual([
      ['root', 'child', 'inbound', 'resolved', null],
      ['child', 'root', 'outbound', 'unresolved', 'not-selected'],
      ['child', 'tool-1', 'outbound', 'resolved', null],
    ]);
    expect(context.refs[2]?.hint).toBe('inline');
  });

  it('records an inbound edge back to the root as resolved without walking the root again', async () => {
    const root = artifact('doc', 'root', 'rev-root', [{ type: 'part_of', target: ref('doc', 'child', 'rev-child') }]);
    const child = artifact('doc', 'child', 'rev-child', [{ type: 'part_of', target: ref('doc', 'root', 'rev-root') }]);
    const store = serveStore(bus, [root, child]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'root', 'rev-root'),
      selectors: { part_of: { direction: 'inbound', depth: 5 } },
    });

    expect(store.queries).toHaveLength(2);
    expect(context.resolved.map((entry) => entry.id)).toEqual(['root', 'child']);
    expect(edges(context.refs)).toEqual([
      ['root', 'child', 'outbound', 'unresolved', 'not-selected'],
      ['root', 'child', 'inbound', 'resolved', null],
      ['child', 'root', 'outbound', 'unresolved', 'not-selected'],
      ['child', 'root', 'inbound', 'resolved', null],
    ]);
  });

  it('keeps the unselected outbound edge beside the resolved inbound edge of a mutual pair', async () => {
    const parent = artifact('doc', 'p', 'rev-p', [{ type: 'contains', target: ref('doc', 'c', 'rev-c') }]);
    const child = artifact('doc', 'c', 'rev-c', [{ type: 'contains', target: ref('doc', 'p', 'rev-p') }]);
    const store = serveStore(bus, [parent, child]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'p', 'rev-p'),
      selectors: { contains: { direction: 'inbound' } },
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['p', 'c']);
    expect(edges(context.refs)).toEqual([
      ['p', 'c', 'outbound', 'unresolved', 'not-selected'],
      ['p', 'c', 'inbound', 'resolved', null],
      ['c', 'p', 'outbound', 'unresolved', 'not-selected'],
    ]);
    const tree = hydrateArtifactContextTree(context);
    expect(tree.root.children.map((node) => [node.direction, node.status])).toEqual([
      [undefined, 'unresolved'],
      ['inbound', 'resolved'],
    ]);
  });

  it('marks inbound edges as depth-exceeded when maxDepth is reached', async () => {
    const root = artifact('doc', 'root', 'rev-root');
    const child = artifact('doc', 'child', 'rev-child', [{ type: 'part_of', target: ref('doc', 'root', 'rev-root') }]);
    const grandchild = artifact('doc', 'grandchild', 'rev-grandchild', [
      { type: 'part_of', target: ref('doc', 'child', 'rev-child') },
    ]);
    const store = serveStore(bus, [root, child, grandchild]);
    cleanups.push(...store.cleanups);

    const context = await resolveArtifactContext({
      bus,
      ref: ref('doc', 'root', 'rev-root'),
      selectors: { part_of: { direction: 'inbound', depth: 2 } },
      maxDepth: 1,
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['root', 'child']);
    expect(edges(context.refs)).toEqual([
      ['root', 'child', 'inbound', 'resolved', null],
      ['child', 'root', 'outbound', 'unresolved', 'not-selected'],
      ['child', 'grandchild', 'inbound', 'unresolved', 'depth-exceeded'],
    ]);
  });

  it('suppresses the stored outbound relation when the inbound selector of that type is omit', async () => {
    const referenced = artifact('repo', 'repo-1', 'rev-repo');
    const root = artifact('system', 'system-1', 'rev-system', [
      { type: 'contains', target: ref('repo', 'repo-1', 'rev-repo') },
    ]);
    const artifacts = new Map(
      [root, referenced].map((entry) => [`${entry.kind}:${entry.id}:${entry.revision}`, entry]),
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        const target = ctx.payload.ref;
        ctx.setResult({ artifact: artifacts.get(`${target.kind}:${target.id}:${target.revision}`) ?? null });
      }),
      bus.on(ArtifactSubjects.query, (ctx) => {
        ctx.setResult({ artifacts: [] });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: ref('system', 'system-1', 'rev-system'),
      selectors: { contains: { direction: 'inbound', hint: 'omit' } },
    });

    expect(context.refs).toEqual([]);
    expect(context.resolved.map((entry) => entry.id)).toEqual(['system-1']);
  });
});
