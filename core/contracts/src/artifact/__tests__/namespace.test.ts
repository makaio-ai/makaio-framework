import { describe, expect, it } from 'vitest';
import { ArtifactSchemas, ArtifactSubjects } from '../namespace.js';

describe('Artifact namespace', () => {
  it('exposes generic artifact registry and revision subjects', () => {
    expect(Object.keys(ArtifactSchemas).sort()).toEqual(
      [
        'compare',
        'create',
        'created',
        'kind.changed',
        'kind.list',
        'kind.register',
        'observation.added',
        'query',
        'relation.added',
        'relation-type.list',
        'relation-type.register',
        'resolve',
        'revise',
        'revised',
        'status.changed',
      ].sort(),
    );
    expect(ArtifactSubjects.create.subject).toBe('create');
    expect(ArtifactSubjects.kind.register.subject).toBe('kind.register');
    expect(ArtifactSubjects.status.changed.subject).toBe('status.changed');
  });
});
