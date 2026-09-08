import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, type ArtifactRef, type ArtifactRevision } from '@makaio/contracts';
import { ArtifactSchemaRegistry } from '../artifact-schema-registry.js';
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
    schemaVersion: '1',
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

describe('resolveArtifactContext', () => {
  let bus: IMakaioBus;
  let registry: ArtifactSchemaRegistry;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new ArtifactSchemaRegistry(bus);
    await registry.init();
    await bus.request(ArtifactSubjects.kind.register, {
      kind: 'system',
      description: 'System kind.',
      schemaVersion: '1',
      dataSchema: { type: 'object' },
      conflictPolicy: 'supersedes',
      defaultContext: {
        contains: { kinds: ['repo'], hint: 'inline' },
      },
    });
    await bus.request(ArtifactSubjects.kind.register, {
      kind: 'repo',
      description: 'Repository kind.',
      schemaVersion: '1',
      dataSchema: { type: 'object' },
      conflictPolicy: 'supersedes',
      defaultContext: {
        contains: { kinds: ['contributor'], hint: 'summary' },
      },
    });
    await bus.request(ArtifactSubjects.kind.register, {
      kind: 'contributor',
      description: 'Contributor kind.',
      schemaVersion: '1',
      dataSchema: { type: 'object' },
      conflictPolicy: 'coexist',
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await registry.destroy();
  });

  it('walks kind default selectors across outbound artifact relations', async () => {
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
      kindRegistry: registry,
      ref: ref('system', 'system-1', 'rev-system'),
    });

    expect(context.resolved.map((entry) => entry.id)).toEqual(['system-1', 'repo-1', 'contributor-1']);
    expect(context.refs.map((entry) => [entry.relationType, entry.hint, entry.status])).toEqual([
      ['contains', 'inline', 'resolved'],
      ['contains', 'summary', 'resolved'],
    ]);
  });

  it('uses caller selectors to override kind defaults per relation type', async () => {
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
      kindRegistry: registry,
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

  it('replaces a relation default when caller selector broadens the kind filter', async () => {
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
      ref: ref('system', 'system-1', 'rev-system'),
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      ['contains', 'summary', 'unresolved', 'not-selected'],
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
      kindRegistry: registry,
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

  it('omits relation types when caller overrides with hint omit', async () => {
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
      ref: ref('system', system.id, system.revision),
      selectors: { contains: { hint: 'inline' } },
    });
    expect(selected.refs[0]).toMatchObject({ target, status: 'unresolved', reason: 'unsupported-ref-class' });

    const filtered = await resolveArtifactContext({
      bus,
      kindRegistry: registry,
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
      kindRegistry: registry,
      ref: ref('system', 'system-1', 'rev-system'),
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
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
      kindRegistry: registry,
      ref: ref('system', 'system-1', 'rev-system'),
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
        kindRegistry: registry,
        ref: ref('system', 'missing', 'rev-missing'),
      }),
    ).rejects.toThrow("root artifact 'system:missing:rev-missing' not found");
  });
});
