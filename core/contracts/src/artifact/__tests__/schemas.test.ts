import { describe, expect, it } from 'vitest';
import {
  ArtifactActorSchema,
  ArtifactKindRegistrationSchema,
  ArtifactObservationSchema,
  ArtifactQueryRequestSchema,
  ArtifactQueryScopeSchema,
  ArtifactRefSchema,
  ArtifactRelationTargetSchema,
  ArtifactRevisionSchema,
  ArtifactScopeSchema,
  ConfidenceMetadataSchema,
  EvidenceRefSchema,
  LocalRefSchema,
  RelationTypeRegistrationSchema,
} from '../schemas.js';

const actor = { kind: 'agent', id: 'agent-1', displayName: 'Agent One' };
const scope = { level: 'project', ids: { projectId: 'project-1' } };
const ref = { refClass: 'artifact' as const, kind: 'implementation-plan', id: 'artifact-1', revision: 'rev-1' };

describe('Artifact core schemas', () => {
  it('accepts an actor with required kind and id fields', () => {
    expect(ArtifactActorSchema.parse(actor)).toEqual(actor);
    expect(() => ArtifactActorSchema.parse({ kind: '', id: 'agent-1' })).toThrow();
  });

  it('accepts a structured scope with arbitrary framework-agnostic IDs', () => {
    expect(ArtifactScopeSchema.parse(scope)).toEqual(scope);
    expect(ArtifactScopeSchema.parse({ level: 'global' })).toEqual({ level: 'global' });
  });

  it('rejects an empty scope level', () => {
    expect(() => ArtifactScopeSchema.parse({ level: '', ids: { projectId: 'project-1' } })).toThrow();
  });

  it('requires ids for concrete non-global artifact scopes', () => {
    expect(() => ArtifactScopeSchema.parse({ level: 'project' })).toThrow();
    expect(() => ArtifactScopeSchema.parse({ level: 'project', ids: {} })).toThrow();
  });

  it('allows level-only query scopes', () => {
    expect(ArtifactQueryScopeSchema.parse({ level: 'session' })).toEqual({ level: 'session' });
    expect(ArtifactQueryRequestSchema.parse({ scope: { level: 'session' } }).scope).toEqual({ level: 'session' });
  });

  it('accepts artifact, local, and evidence refs', () => {
    expect(ArtifactRefSchema.parse(ref)).toEqual(ref);
    expect(LocalRefSchema.parse({ artifact: ref, localId: 'observation-1' }).localId).toBe('observation-1');
    expect(EvidenceRefSchema.parse({ kind: 'source-file', id: 'src/index.ts', locator: 'L1-L9' }).kind).toBe(
      'source-file',
    );
  });

  it('preserves locator on an EvidenceRef that also carries revision via ArtifactRelationTargetSchema', () => {
    const target = ArtifactRelationTargetSchema.parse({
      refClass: 'evidence',
      kind: 'commit',
      id: 'abc123',
      revision: 'v1',
      locator: 'src/index.ts#L42',
    });
    expect(target).toEqual({
      refClass: 'evidence',
      kind: 'commit',
      id: 'abc123',
      revision: 'v1',
      locator: 'src/index.ts#L42',
    });
  });

  it('infers omitted refClass values before routing relation targets', () => {
    expect(
      ArtifactRelationTargetSchema.parse({ kind: 'implementation-plan', id: 'artifact-1', revision: 'rev-1' }),
    ).toEqual({
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-1',
    });
    expect(ArtifactRelationTargetSchema.parse({ kind: 'source-file', id: 'docs/artifacts.md' })).toEqual({
      refClass: 'evidence',
      kind: 'source-file',
      id: 'docs/artifacts.md',
    });
    expect(
      ArtifactRelationTargetSchema.parse({
        kind: 'commit',
        id: 'abc123',
        revision: 'v1',
        locator: 'src/index.ts#L42',
      }),
    ).toEqual({
      refClass: 'evidence',
      kind: 'commit',
      id: 'abc123',
      revision: 'v1',
      locator: 'src/index.ts#L42',
    });
  });

  it('accepts confidence metadata with provenance basis', () => {
    const parsed = ConfidenceMetadataSchema.parse({
      level: 'verified',
      basis: [{ kind: 'automated-check', actor, timestamp: 1700000000000, detail: 'validate passed' }],
    });
    expect(parsed.level).toBe('verified');
  });

  it('accepts observations as locally addressable embedded records', () => {
    const parsed = ArtifactObservationSchema.parse({
      id: 'obs-1',
      kind: 'test-finding',
      summary: 'Unit coverage exists',
      severity: 'info',
      regarding: { artifact: ref, localId: 'step-1' },
      actor,
      timestamp: 1700000000001,
    });
    expect(parsed.regarding).toEqual({ refClass: 'local', artifact: ref, localId: 'step-1' });
  });

  it('accepts a schema-typed artifact revision', () => {
    const parsed = ArtifactRevisionSchema.parse({
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-1',
      scope,
      schemaVersion: '1',
      data: { status: 'draft', topic: 'artifact redesign' },
      relations: [
        {
          type: 'derives_from',
          target: { refClass: 'evidence', kind: 'source-file', id: 'docs/artifacts.md' },
        },
      ],
      confidence: {
        level: 'stated',
        basis: [{ kind: 'user-statement', actor, timestamp: 1700000000002 }],
      },
      actor,
      timestamp: 1700000000003,
    });
    expect(parsed.data).toEqual({ status: 'draft', topic: 'artifact redesign' });
  });

  it('accepts kind and relation type registrations', () => {
    expect(
      ArtifactKindRegistrationSchema.parse({
        kind: 'implementation-plan',
        schemaVersion: '1',
        dataSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
        conflictPolicy: 'supersedes',
        status: { path: '/data/status', values: ['draft', 'approved'] },
        indexedFields: ['/data/status'],
        searchableFields: ['/data/topic'],
      }).kind,
    ).toBe('implementation-plan');

    expect(
      RelationTypeRegistrationSchema.parse({
        type: 'derives_from',
        symmetry: 'asymmetric',
        implication: 'Causal chain',
        targetRefClasses: ['artifact', 'evidence'],
      }).type,
    ).toBe('derives_from');
  });

  it('accepts a generic query over service-derived indexes', () => {
    expect(
      ArtifactQueryRequestSchema.parse({
        kind: 'implementation-plan',
        scope,
        currentOnly: true,
        indexed: { status: 'approved' },
        confidence: { minLevel: 'stated' },
        limit: 25,
      }).indexed,
    ).toEqual({ status: 'approved' });
  });
});
