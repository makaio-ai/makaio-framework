import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  hydrateArtifactContextTree,
  type ArtifactRef,
  type ArtifactRevision,
} from '@makaio/contracts';
import { resolveArtifactContext } from '../context-resolver.js';

/**
 * Create an artifact revision reference for a fixture.
 * @param kind - Artifact kind discriminator.
 * @param id - Stable artifact identity.
 * @param revision - Revision identity.
 * @returns Immutable artifact reference.
 */
function ref(kind: string, id: string, revision: string): ArtifactRef {
  return { refClass: 'artifact', kind, id, revision };
}

/**
 * Create a minimal artifact revision fixture.
 * @param kind - Artifact kind discriminator.
 * @param id - Stable artifact identity.
 * @param revision - Revision identity.
 * @param relations - Outbound relations for the revision.
 * @returns Artifact revision fixture.
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
    scope: { level: 'global' },
    data: { title: id },
    relations,
    actor: { kind: 'agent', id: 'agent-1' },
    timestamp: 1700000000000,
  };
}

describe('resolveArtifactContext relation sources', () => {
  let bus: IMakaioBus;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('keeps part-local and whole-artifact relations distinct while deduplicating target loads', async () => {
    const targetRef = ref('answer', 'a-1', 'rev-a');
    const target = artifact('answer', 'a-1', 'rev-a');
    const rootRef = ref('questionnaire', 'q-1', 'rev-q');
    const root = artifact('questionnaire', 'q-1', 'rev-q', [
      { type: 'answers', sourceLocalId: 'q2A', target: targetRef },
      { type: 'answers', sourceLocalId: 'q3A', target: targetRef },
      { type: 'answers', target: targetRef },
    ]);
    const resolveSpy = vi.fn((requestedRef: ArtifactRef) =>
      requestedRef.id === root.id ? root : requestedRef.id === target.id ? target : null,
    );
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        ctx.setResult({ artifact: resolveSpy(ctx.payload.ref) });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: rootRef,
      selectors: { answers: { hint: 'inline' } },
    });

    expect(context.refs.map((entry) => [entry.relationType, entry.sourceLocalId, entry.status])).toEqual([
      ['answers', 'q2A', 'resolved'],
      ['answers', 'q3A', 'resolved'],
      ['answers', undefined, 'resolved'],
    ]);
    expect(resolveSpy.mock.calls.filter(([target]) => target.id === targetRef.id)).toHaveLength(1);

    const tree = hydrateArtifactContextTree(context);
    expect(tree.root.children.map((child) => ('sourceLocalId' in child ? child.sourceLocalId : undefined))).toEqual([
      'q2A',
      'q3A',
      undefined,
    ]);
  });

  it('preserves local source provenance for missing and unsupported targets without resolving local refs', async () => {
    const rootRef = ref('questionnaire', 'q-1', 'rev-q');
    const targetRef = ref('answer', 'a-1', 'rev-a');
    const root = artifact('questionnaire', 'q-1', 'rev-q', [
      { type: 'answers', sourceLocalId: 'qMissing', target: targetRef },
      {
        type: 'answers',
        sourceLocalId: 'qUnsupported',
        target: { refClass: 'local', artifact: targetRef, localId: 'a-section' },
      },
    ]);
    const resolvedIds: string[] = [];
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        resolvedIds.push(ctx.payload.ref.id);
        ctx.setResult({ artifact: ctx.payload.ref.id === root.id ? root : null });
      }),
    );

    const context = await resolveArtifactContext({
      bus,
      ref: rootRef,
      selectors: { answers: { hint: 'inline' } },
    });

    expect(context.refs.map((entry) => [entry.sourceLocalId, entry.status, entry.reason])).toEqual([
      ['qMissing', 'unresolved', 'not-found'],
      ['qUnsupported', 'unresolved', 'unsupported-ref-class'],
    ]);
    expect(resolvedIds).toEqual(['q-1', 'a-1']);

    const tree = hydrateArtifactContextTree(context);
    expect(tree.root.children.map((child) => [child.sourceLocalId, child.status])).toEqual([
      ['qMissing', 'unresolved'],
      ['qUnsupported', 'unresolved'],
    ]);
  });
});
