import { describe, expect, it } from 'vitest';

import { ArtifactRelationTargetIdentitySchema, artifactRelationTargetIdentity } from '../relation-target-identity.js';
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

  it('rejects an artifact identity that carries a revision field (strictObject)', () => {
    expect(() =>
      ArtifactRelationTargetIdentitySchema.parse({
        refClass: 'artifact',
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
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
