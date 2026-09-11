import { describe, expect, it } from 'vitest';

import {
  ArtifactRelationTargetIdentitySchema,
  artifactRelationTargetIdentity,
  describeArtifactRelationTargetIdentity,
  serializeArtifactRelationTargetIdentity,
} from '../relation-target-identity.js';
import { ArtifactRelationTargetSchema } from '../schemas.js';

const artifactTarget = ArtifactRelationTargetSchema.parse({
  refClass: 'artifact',
  kind: 'implementation-plan',
  id: 'artifact-1',
  revision: 'rev-1',
});

const artifactTargetAltRevision = ArtifactRelationTargetSchema.parse({
  refClass: 'artifact',
  kind: 'implementation-plan',
  id: 'artifact-1',
  revision: 'rev-2',
});

const entityTarget = ArtifactRelationTargetSchema.parse({
  refClass: 'entity',
  entityType: 'jira-issue',
  id: 'FACT-123',
});

const localTarget = ArtifactRelationTargetSchema.parse({
  refClass: 'local',
  artifact: {
    refClass: 'artifact',
    kind: 'implementation-plan',
    id: 'artifact-1',
    revision: 'rev-1',
  },
  localId: 'section-2',
});

const evidenceTarget = ArtifactRelationTargetSchema.parse({
  refClass: 'evidence',
  kind: 'commit',
  id: 'abc123def456',
  revision: 'abc123def456',
});

describe('artifactRelationTargetIdentity', () => {
  it('drops the revision pin from an artifact target, keeping only refClass, kind, and id', () => {
    const identity = artifactRelationTargetIdentity(artifactTarget);
    expect(identity).toEqual({
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
    });
    expect(identity).not.toHaveProperty('revision');
  });

  it('returns only the three identity fields for an artifact target (no extra fields)', () => {
    const identity = artifactRelationTargetIdentity(artifactTarget);
    expect(Object.keys(identity ?? {})).toEqual(['refClass', 'kind', 'id']);
  });

  it('returns the entity identity fields unchanged for an entity target', () => {
    const identity = artifactRelationTargetIdentity(entityTarget);
    expect(identity).toEqual({
      refClass: 'entity',
      entityType: 'jira-issue',
      id: 'FACT-123',
    });
  });

  it('returns undefined for a local target', () => {
    expect(artifactRelationTargetIdentity(localTarget)).toBeUndefined();
  });

  it('returns undefined for an evidence target', () => {
    expect(artifactRelationTargetIdentity(evidenceTarget)).toBeUndefined();
  });

  it('identities of two artifact targets differing only in revision are deep-equal', () => {
    const identityA = artifactRelationTargetIdentity(artifactTarget);
    const identityB = artifactRelationTargetIdentity(artifactTargetAltRevision);
    expect(identityA).toEqual(identityB);
  });
});

describe('ArtifactRelationTargetIdentitySchema', () => {
  it('accepts a valid artifact identity', () => {
    const parsed = ArtifactRelationTargetIdentitySchema.parse({
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
    });
    expect(parsed).toEqual({
      refClass: 'artifact',
      kind: 'implementation-plan',
      id: 'artifact-1',
    });
  });

  it('rejects an artifact identity that carries a revision field — the underlying schema is strict, so unrecognised keys are rejected rather than stripped', () => {
    // Observed behaviour: ArtifactRefSchema is z.strictObject, and .omit preserves strict
    // mode, so passing `revision` is treated as an unrecognised key and the parse throws.
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'artifact',
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
      }),
    ).toThrow();
  });

  it('rejects a whitespace-only kind for artifact identity (parity with ArtifactRefSchema)', () => {
    // ArtifactRefSchema uses ArtifactReferenceIdentitySchema = z.string().min(1).regex(/\S/),
    // which the .omit derivation inherits, so whitespace-only kind is rejected.
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'artifact',
        kind: '   ',
        id: 'artifact-1',
      }),
    ).toThrow();
  });

  it('rejects a whitespace-only id for artifact identity (parity with ArtifactRefSchema)', () => {
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'artifact',
        kind: 'implementation-plan',
        id: '   ',
      }),
    ).toThrow();
  });

  it('accepts a valid entity identity', () => {
    const parsed = ArtifactRelationTargetIdentitySchema.parse({
      refClass: 'entity',
      entityType: 'jira-issue',
      id: 'FACT-123',
    });
    expect(parsed).toEqual({
      refClass: 'entity',
      entityType: 'jira-issue',
      id: 'FACT-123',
    });
  });

  it('rejects an entity identity missing entityType', () => {
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'entity',
        id: 'FACT-123',
      }),
    ).toThrow();
  });

  it('rejects unknown refClass values', () => {
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'local',
        artifact: {},
        localId: 'x',
      }),
    ).toThrow();
  });
});

describe('serializeArtifactRelationTargetIdentity', () => {
  it('produces equal strings for the same artifact identity', () => {
    const identityA = artifactRelationTargetIdentity(artifactTarget);
    const identityB = artifactRelationTargetIdentity(artifactTargetAltRevision);
    expect(serializeArtifactRelationTargetIdentity(identityA!)).toBe(
      serializeArtifactRelationTargetIdentity(identityB!),
    );
  });

  it('produces different strings for artifact vs entity targets sharing the same id', () => {
    const artifactIdentity = ArtifactRelationTargetIdentitySchema.parse({
      refClass: 'artifact',
      kind: 'some-kind',
      id: 'shared-id',
    });
    const entityIdentity = ArtifactRelationTargetIdentitySchema.parse({
      refClass: 'entity',
      entityType: 'some-type',
      id: 'shared-id',
    });
    expect(serializeArtifactRelationTargetIdentity(artifactIdentity)).not.toBe(
      serializeArtifactRelationTargetIdentity(entityIdentity),
    );
  });

  it('correctly serializes an artifact identity with quotes and colons in kind and id', () => {
    const identity = ArtifactRelationTargetIdentitySchema.parse({
      refClass: 'artifact',
      kind: 'kind:with"quotes',
      id: 'id:with"quotes',
    });
    const serialized = serializeArtifactRelationTargetIdentity(identity);
    // The tuple form prevents collisions across field boundaries.
    expect(JSON.parse(serialized)).toEqual(['artifact', 'kind:with"quotes', 'id:with"quotes']);
  });

  it('serializes an artifact identity as a fixed-order tuple', () => {
    const identity = artifactRelationTargetIdentity(artifactTarget);
    expect(JSON.parse(serializeArtifactRelationTargetIdentity(identity!))).toEqual([
      'artifact',
      'implementation-plan',
      'artifact-1',
    ]);
  });

  it('serializes an entity identity as a fixed-order tuple', () => {
    const identity = artifactRelationTargetIdentity(entityTarget);
    expect(JSON.parse(serializeArtifactRelationTargetIdentity(identity!))).toEqual([
      'entity',
      'jira-issue',
      'FACT-123',
    ]);
  });
});

describe('describeArtifactRelationTargetIdentity', () => {
  it('returns artifact:<kind>/<id> for an artifact identity', () => {
    const identity = artifactRelationTargetIdentity(artifactTarget);
    expect(describeArtifactRelationTargetIdentity(identity!)).toBe('artifact:implementation-plan/artifact-1');
  });

  it('returns entity:<entityType>/<id> for an entity identity', () => {
    const identity = artifactRelationTargetIdentity(entityTarget);
    expect(describeArtifactRelationTargetIdentity(identity!)).toBe('entity:jira-issue/FACT-123');
  });
});
