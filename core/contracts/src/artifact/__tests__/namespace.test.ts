import { describe, expect, it } from 'vitest';
import { ArtifactSchemas, ArtifactSubjects } from '../namespace.js';
import { ArtifactKindRegistrationSchema } from '../schemas.js';

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
        'resolveContext',
        'revise',
        'revised',
        'status.changed',
      ].sort(),
    );
    expect(ArtifactSubjects.create.subject).toBe('create');
    expect(ArtifactSubjects.kind.register.subject).toBe('kind.register');
    expect(ArtifactSubjects.status.changed.subject).toBe('status.changed');
  });

  describe('status contract', () => {
    it('status.changed uses the correct namespace subject spelling', () => {
      // The subject string is owned by the artifact namespace — 'status.changed',
      // not 'statusChanged' or 'status_changed'. Callers must use this spelling.
      expect(ArtifactSubjects.status.changed.subject).toBe('status.changed');
    });

    it('status.changed accepts an open string path, not a fixed enum', () => {
      // The path field is an open string: each artifact kind declares its own
      // status path in the kind registration schema. No global status enum exists.
      const schema = ArtifactSchemas['status.changed'];
      const validPayload = {
        artifact: { refClass: 'artifact', kind: 'review', id: 'art-1', revision: 'rev-1' },
        path: 'review.status',
        previous: 'draft',
        current: 'approved',
      };
      expect(schema.safeParse(validPayload).success).toBe(true);

      const anotherPath = {
        artifact: { refClass: 'artifact', kind: 'task', id: 'art-2', revision: 'rev-2' },
        path: 'workflow.phase',
        previous: 'planning',
        current: 'execution',
      };
      expect(schema.safeParse(anotherPath).success).toBe(true);
    });

    it('status.changed allows absent previous or current for initial/cleared transitions', () => {
      const schema = ArtifactSchemas['status.changed'];
      const withoutPrevious = {
        artifact: { refClass: 'artifact', kind: 'task', id: 'art-1', revision: 'rev-1' },
        path: 'status',
        current: 'active',
      };
      expect(schema.safeParse(withoutPrevious).success).toBe(true);

      const withoutCurrent = {
        artifact: { refClass: 'artifact', kind: 'task', id: 'art-1', revision: 'rev-1' },
        path: 'status',
        previous: 'active',
      };
      expect(schema.safeParse(withoutCurrent).success).toBe(true);
    });

    it('kind registration status field is schema-owned and carries an open path string', () => {
      // Artifact kinds declare their own status path — no global status enum exists.
      // The `status.path` is a dot-separated string defined by each kind independently.
      const kindWithStatus = {
        kind: 'review-artifact',
        description: 'Minimal review-artifact fixture for open status path schema contract test.',
        schemaVersion: '1.0.0',
        dataSchema: { type: 'object', properties: {} },
        conflictPolicy: 'supersedes' as const,
        status: { path: 'review.status' },
      };
      const parsed = ArtifactKindRegistrationSchema.safeParse(kindWithStatus);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status?.path).toBe('review.status');
        // values is optional — kinds may leave it open-ended
        expect(parsed.data.status?.values).toBeUndefined();
      }
    });

    it('kind registration accepts enumerated status values but they remain optional', () => {
      const kindWithEnumeratedStatus = {
        kind: 'task-artifact',
        description: 'Minimal task-artifact fixture for enumerated status values schema contract test.',
        schemaVersion: '1.0.0',
        dataSchema: { type: 'object', properties: {} },
        conflictPolicy: 'supersedes' as const,
        status: { path: 'state', values: ['pending', 'active', 'done'] },
      };
      const parsed = ArtifactKindRegistrationSchema.safeParse(kindWithEnumeratedStatus);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status?.values).toEqual(['pending', 'active', 'done']);
      }
    });
  });

  it('validates artifact.resolveContext request and response payloads', () => {
    const rootRef = { refClass: 'artifact' as const, kind: 'system', id: 'system-1', revision: 'rev-system' };
    const request = ArtifactSchemas.resolveContext.request.parse({
      ref: rootRef,
      selectors: { contains: { kinds: ['repo'], hint: 'inline' } },
    });

    expect(request.maxDepth).toBe(5);

    const root = {
      ...rootRef,
      schemaVersion: '1',
      scope: { level: 'global' },
      data: { name: 'Makaio' },
      relations: [],
      actor: { kind: 'agent', id: 'agent-1' },
      timestamp: 1700000000000,
    };

    const response = ArtifactSchemas.resolveContext.response.parse({
      context: { rootRef, refs: [], resolved: [root] },
    });

    expect(response.context.rootRef).toEqual(rootRef);
    expect(response.context.refs).toEqual([]);
    expect(response.context.resolved).toHaveLength(1);
    expect(response.context.resolved[0]?.id).toBe('system-1');
  });
});
