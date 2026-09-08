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

  it('accepts caller-owned creation identities without requiring them or changing revision pins', () => {
    const request = {
      kind: 'review-result',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: { title: 'Review result' },
      relations: [],
      actor: { kind: 'agent', id: 'reviewer' },
    };
    expect(ArtifactSchemas.create.request.parse(request)).not.toHaveProperty('id');
    expect(ArtifactSchemas.create.request.parse({ ...request, id: 'review-operation-42' }).id).toBe(
      'review-operation-42',
    );
    expect(ArtifactSchemas.create.request.safeParse({ ...request, id: '' }).success).toBe(false);
    expect(ArtifactSchemas.create.request.safeParse({ ...request, id: 42 }).success).toBe(false);
  });

  describe('status contract', () => {
    it('accepts only data-relative JSON Pointers as explicit revise observation metadata', () => {
      const request = {
        previous: { refClass: 'artifact', kind: 'review', id: 'review-1', revision: 'rev-1' },
        revision: {
          kind: 'review',
          schemaVersion: 1,
          scope: { level: 'global' },
          data: { title: 'Review', phase: 'ready' },
          relations: [],
          actor: { kind: 'agent', id: 'reviewer' },
        },
      };
      expect(ArtifactSchemas.revise.request.parse(request)).not.toHaveProperty('statusPath');
      for (const statusPath of ['/phase', '/review/status', '/review~1result/status~0code']) {
        expect(ArtifactSchemas.revise.request.parse({ ...request, statusPath }).statusPath).toBe(statusPath);
      }
      for (const statusPath of ['', 'phase', 'review.status', '/phase~', '/phase~2']) {
        expect(ArtifactSchemas.revise.request.safeParse({ ...request, statusPath }).success).toBe(false);
      }
    });

    it('status.changed uses the correct namespace subject spelling', () => {
      // The subject string is owned by the artifact namespace — 'status.changed',
      // not 'statusChanged' or 'status_changed'. Callers must use this spelling.
      expect(ArtifactSubjects.status.changed.subject).toBe('status.changed');
    });

    it('status.changed accepts an open string path, not a fixed enum', () => {
      // Observation paths belong to explicit callers, never Kind registration.
      // The existing event contract does not introduce a global status enum.
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

    it('keeps factual statuses inside data without a second kind status declaration', () => {
      const registration = {
        kind: 'system-description',
        description: 'Documented operational state.',
        schemaVersion: 1,
        category: 'knowledge',
        titlePath: 'name',
        dataSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, operationalStatus: { type: 'string' } },
          required: ['name'],
        },
      };
      expect(ArtifactKindRegistrationSchema.safeParse(registration).success).toBe(true);
      expect(
        ArtifactKindRegistrationSchema.safeParse({ ...registration, status: { path: 'operationalStatus' } }).success,
      ).toBe(false);
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
      schemaVersion: 1,
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
