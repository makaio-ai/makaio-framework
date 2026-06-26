import { describe, expect, it } from 'vitest';
import { ArtifactContextSelectorSchema } from '../context-selectors.js';
import { ArtifactContextRefEntrySchema, ResolvedArtifactContextWireSchema } from '../context-resolution.js';

const actor = { kind: 'agent', id: 'agent-1' };
const rootRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
const repoRef = { refClass: 'artifact' as const, kind: 'repo', id: 'repo-1', revision: 'rev-repo' };

function artifactRevision(ref: typeof rootRef) {
  return {
    ...ref,
    schemaVersion: '1',
    scope: { level: 'global' },
    data: { name: ref.id },
    relations: [],
    actor,
    timestamp: 1700000000000,
  };
}

describe('artifact context resolution schemas', () => {
  it('accepts selector maps with relation-specific kind filters, hints, depth, and nested selectors', () => {
    const parsed = ArtifactContextSelectorSchema.parse({
      contains: {
        kinds: ['repo'],
        hint: 'inline',
        depth: 2,
        nested: {
          contains: { kinds: ['contributor'], hint: 'summary' },
        },
      },
      derives_from: { hint: 'link' },
    });

    expect(parsed.contains?.kinds).toEqual(['repo']);
    expect(parsed.contains?.nested?.contains?.hint).toBe('summary');
  });

  it('allows runtime render hint strings while preserving the known initial vocabulary', () => {
    expect(ArtifactContextSelectorSchema.parse({ references: { hint: 'compact-card' } }).references?.hint).toBe(
      'compact-card',
    );
  });

  it('accepts normalized resolved and unresolved context entries', () => {
    const sourceRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
    const target = { refClass: 'artifact' as const, kind: 'repo', id: 'repo-1', revision: 'rev-repo' };

    expect(
      ArtifactContextRefEntrySchema.parse({
        sourceRef,
        target,
        relationType: 'contains',
        hint: 'inline',
        status: 'resolved',
      }).status,
    ).toBe('resolved');

    expect(
      ArtifactContextRefEntrySchema.parse({
        sourceRef,
        target,
        relationType: 'contains',
        hint: 'inline',
        status: 'unresolved',
        reason: 'not-found',
      }).reason,
    ).toBe('not-found');
  });

  it('rejects scope-denied because v1 has no scope policy seam', () => {
    const sourceRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
    const target = { refClass: 'artifact' as const, kind: 'repo', id: 'repo-1', revision: 'rev-repo' };

    expect(() =>
      ArtifactContextRefEntrySchema.parse({
        sourceRef,
        target,
        relationType: 'contains',
        hint: 'inline',
        status: 'unresolved',
        reason: 'scope-denied',
      }),
    ).toThrow();
  });

  it('rejects an unresolved entry that omits reason', () => {
    expect(() =>
      ArtifactContextRefEntrySchema.parse({
        sourceRef: { refClass: 'artifact' as const, kind: 'system', id: 's-1', revision: 'r-1' },
        target: { refClass: 'artifact' as const, kind: 'repo', id: 'r-1', revision: 'r-1' },
        relationType: 'contains',
        hint: 'inline',
        status: 'unresolved',
      }),
    ).toThrow();
  });

  it('rejects a resolved entry that carries a reason', () => {
    expect(() =>
      ArtifactContextRefEntrySchema.parse({
        sourceRef: { refClass: 'artifact' as const, kind: 'system', id: 's-1', revision: 'r-1' },
        target: { refClass: 'artifact' as const, kind: 'repo', id: 'r-1', revision: 'r-1' },
        relationType: 'contains',
        hint: 'inline',
        status: 'resolved',
        reason: 'not-found',
      }),
    ).toThrow();
  });

  it('rejects a resolved entry with a non-artifact target', () => {
    expect(() =>
      ArtifactContextRefEntrySchema.parse({
        sourceRef: rootRef,
        target: { refClass: 'evidence' as const, kind: 'source-file', id: 'docs/artifacts.md' },
        relationType: 'references',
        hint: 'link',
        status: 'resolved',
      }),
    ).toThrow();

    expect(() =>
      ArtifactContextRefEntrySchema.parse({
        sourceRef: rootRef,
        target: { refClass: 'local' as const, artifact: repoRef, localId: 'section-1' },
        relationType: 'contains',
        hint: 'inline',
        status: 'resolved',
      }),
    ).toThrow();
  });

  it('accepts a complete resolved context wire payload', () => {
    const root = artifactRevision(rootRef);

    expect(ResolvedArtifactContextWireSchema.parse({ rootRef, refs: [], resolved: [root] }).resolved).toHaveLength(1);
  });

  it('rejects a resolved context wire payload when resolved omits the root artifact', () => {
    expect(() => ResolvedArtifactContextWireSchema.parse({ rootRef, refs: [], resolved: [] })).toThrow();
  });

  it('rejects a resolved context wire payload when a resolved artifact target is absent from resolved', () => {
    expect(() =>
      ResolvedArtifactContextWireSchema.parse({
        rootRef,
        refs: [
          {
            sourceRef: rootRef,
            target: repoRef,
            relationType: 'contains',
            hint: 'inline',
            status: 'resolved',
          },
        ],
        resolved: [artifactRevision(rootRef)],
      }),
    ).toThrow();
  });

  it('rejects a resolved context wire payload when an entry source is absent from resolved', () => {
    expect(() =>
      ResolvedArtifactContextWireSchema.parse({
        rootRef,
        refs: [
          {
            sourceRef: repoRef,
            target: { refClass: 'artifact' as const, kind: 'issue', id: 'issue-1', revision: 'rev-issue' },
            relationType: 'contains',
            hint: 'inline',
            status: 'unresolved',
            reason: 'depth-exceeded',
          },
        ],
        resolved: [artifactRevision(rootRef)],
      }),
    ).toThrow();
  });
});
