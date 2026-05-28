import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArtifactKind, type ArtifactDataOf, type ArtifactOf } from '../kind-definition.js';

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
});
