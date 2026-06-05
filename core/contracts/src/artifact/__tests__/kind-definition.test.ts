import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArtifactKind, type ArtifactDataOf, type ArtifactOf } from '../kind-definition.js';
import { ArtifactKindRegistrationSchema } from '../schemas.js';

const PlanDataSchema = z.object({
  status: z.enum(['draft', 'approved']),
  topic: z.string(),
});

describe('defineArtifactKind', () => {
  it('keeps Zod schemas live while exposing serializable registration data', () => {
    const definition = defineArtifactKind({
      kind: 'implementation-plan',
      schemaVersion: '1',
      dataSchema: PlanDataSchema,
      scopeSchema: z.object({ level: z.literal('project'), ids: z.object({ projectId: z.string() }) }),
      discriminator: ['/scope/ids/projectId', '/data/topic'],
      conflictPolicy: 'supersedes',
      status: { path: '/data/status', values: ['draft', 'approved'] },
      indexedFields: ['/data/status'],
      searchableFields: ['/data/topic'],
    });

    type PlanData = ArtifactDataOf<typeof definition>;
    type PlanArtifact = ArtifactOf<typeof definition>;
    const data: PlanData = { status: 'draft', topic: 'artifact redesign' };
    const artifact: PlanArtifact = {
      kind: 'implementation-plan',
      id: 'artifact-1',
      revision: 'rev-1',
      scope: { level: 'project', ids: { projectId: 'project-1' } },
      schemaVersion: '1',
      data,
      relations: [],
      actor: { kind: 'agent', id: 'agent-1' },
      timestamp: 1700000000000,
    };

    expect(artifact.data.status).toBe('draft');
    expect(definition.toRegistration().kind).toBe('implementation-plan');
    expect(definition.toRegistration().dataSchema).toMatchObject({
      type: 'object',
      properties: {
        status: { enum: ['draft', 'approved'], type: 'string' },
        topic: { type: 'string' },
      },
      required: ['status', 'topic'],
    });
  });

  it('serializes provider-neutral projection policy', () => {
    const kind = defineArtifactKind({
      kind: 'implementation-plan',
      schemaVersion: '1',
      dataSchema: z.object({ status: z.string(), goal: z.string() }),
      conflictPolicy: 'supersedes',
      projection: {
        mode: 'surface',
        defaultRole: 'artifact',
        semanticEvents: ['created', 'revised', 'status-changed'],
      },
    });

    const registration = ArtifactKindRegistrationSchema.parse(kind.toRegistration());
    expect(registration.projection).toEqual({
      mode: 'surface',
      defaultRole: 'artifact',
      semanticEvents: ['created', 'revised', 'status-changed'],
    });
  });

  it('omits projection from toRegistration when not supplied', () => {
    const kind = defineArtifactKind({
      kind: 'simple-kind',
      schemaVersion: '1',
      dataSchema: z.object({ value: z.string() }),
      conflictPolicy: 'coexist',
    });

    const registration = kind.toRegistration();
    expect(registration.projection).toBeUndefined();
  });

  it('projection object is a copy — mutation does not affect stored options', () => {
    const kind = defineArtifactKind({
      kind: 'mut-test',
      schemaVersion: '1',
      dataSchema: z.object({ v: z.string() }),
      conflictPolicy: 'coexist',
      projection: { mode: 'surface', defaultRole: 'artifact' },
    });

    const reg1 = kind.toRegistration();
    // Spreading creates a new object; mutating it does not affect a second call.
    (reg1.projection as Record<string, unknown>)['mode'] = 'none';
    const reg2 = kind.toRegistration();
    expect(reg2.projection?.mode).toBe('surface');
  });

  it('semanticEvents array is copied — push on snapshot does not affect future toRegistration calls', () => {
    const kind = defineArtifactKind({
      kind: 'events-mut-test',
      schemaVersion: '1',
      dataSchema: z.object({ v: z.string() }),
      conflictPolicy: 'coexist',
      projection: { mode: 'surface', defaultRole: 'artifact', semanticEvents: ['created', 'revised'] },
    });

    const reg1 = kind.toRegistration();
    // The snapshot's array is a copy; pushing to it must not contaminate the next call.
    (reg1.projection!.semanticEvents as string[]).push('status-changed');
    const reg2 = kind.toRegistration();
    expect(reg2.projection!.semanticEvents).toHaveLength(2);
  });

  it('status.values array is copied — push on snapshot does not affect future toRegistration calls', () => {
    const kind = defineArtifactKind({
      kind: 'status-mut-test',
      schemaVersion: '1',
      dataSchema: z.object({ v: z.string() }),
      conflictPolicy: 'coexist',
      status: { path: '/data/v', values: ['open', 'closed'] },
    });

    const reg1 = kind.toRegistration();
    // The snapshot's values array is a copy; pushing to it must not contaminate the next call.
    (reg1.status!.values as string[]).push('archived');
    const reg2 = kind.toRegistration();
    expect(reg2.status!.values).toHaveLength(2);
  });
});
