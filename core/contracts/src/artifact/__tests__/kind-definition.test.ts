import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineArtifactKind, type ArtifactDataOf, type ArtifactOf } from '../kind-definition.js';
import { ArtifactKindRegistrationSchema } from '../schemas.js';
import { defineArtifactLifecycleHooks } from '../lifecycle-hooks.js';
import type { ProjectedField } from '../../materialization/index.js';

const PlanDataSchema = z.object({
  status: z.enum(['draft', 'approved']),
  topic: z.string(),
});

describe('defineArtifactKind', () => {
  it('keeps Zod schemas live while exposing serializable registration data', () => {
    const definition = defineArtifactKind({
      kind: 'implementation-plan',
      description: 'Implementation plan artifact for a project topic.',
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
    expect(definition.toRegistration().description).toBe('Implementation plan artifact for a project topic.');
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
      description: 'Implementation plan artifact used by projection policy tests.',
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
      description: 'Simple artifact kind used by contract serialization tests.',
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
      description: 'Mutation-test artifact kind for projection copy assertions.',
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
      description: 'Mutation-test artifact kind for semanticEvents copy assertions.',
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
      description: 'Mutation-test artifact kind for status.values copy assertions.',
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

  it('defensively copies projected fields when serializing projection policy', () => {
    const projectedFields: ProjectedField[] = [{ path: 'status', semantic: 'status' }];
    const kind = defineArtifactKind({
      kind: 'planning-schema-sync-test',
      description: 'Test artifact kind for projected field serialization.',
      schemaVersion: '1',
      dataSchema: z.object({ status: z.enum(['draft', 'approved']) }),
      conflictPolicy: 'manual',
      projection: {
        mode: 'surface',
        projectedFields,
      },
    });

    const registration = kind.toRegistration();
    projectedFields.push({ path: 'priority', semantic: 'priority' });

    expect(registration.projection?.projectedFields).toEqual([{ path: 'status', semantic: 'status' }]);
  });

  it('keeps artifact kind hooks live-only and out of bus registration payloads', () => {
    const beforeCreate = vi.fn();
    const kind = defineArtifactKind({
      kind: 'review-findings',
      description: 'Review findings artifact kind used to verify live-only lifecycle hooks.',
      schemaVersion: '1',
      dataSchema: z.object({ findings: z.array(z.object({ message: z.string() })) }),
      conflictPolicy: 'manual',
      hooks: defineArtifactLifecycleHooks({
        hooks: [
          {
            id: 'review-findings.require-findings',
            event: 'beforeCreate',
            handler: beforeCreate,
          },
        ],
      }),
    });

    expect(kind.hooks?.hooks).toHaveLength(1);
    expect(kind.hooks?.hooks[0]?.handler).toBe(beforeCreate);
    expect(kind.toRegistration()).not.toHaveProperty('hooks');
  });

  it('serializes default context selectors into kind registration metadata', () => {
    const kind = defineArtifactKind({
      kind: 'system',
      description: 'System artifact with default context selectors.',
      schemaVersion: '1',
      dataSchema: z.object({ name: z.string() }),
      conflictPolicy: 'supersedes',
      defaultContext: {
        contains: { kinds: ['repo'], hint: 'inline' },
        derives_from: { hint: 'link', depth: 1 },
      },
    });

    const registration = ArtifactKindRegistrationSchema.parse(kind.toRegistration());
    expect(registration.defaultContext).toEqual({
      contains: { kinds: ['repo'], hint: 'inline' },
      derives_from: { hint: 'link', depth: 1 },
    });
  });

  it('defensively copies default context when serializing kind registrations', () => {
    const defaultContext = {
      contains: { kinds: ['repo'], hint: 'inline' },
    };
    const kind = defineArtifactKind({
      kind: 'system-copy',
      description: 'System artifact for default context copy tests.',
      schemaVersion: '1',
      dataSchema: z.object({ name: z.string() }),
      conflictPolicy: 'supersedes',
      defaultContext,
    });

    const reg1 = kind.toRegistration();
    // Force-mutate through the readonly constraint to verify structural cloning.
    (reg1.defaultContext!.contains! as Record<string, unknown>).kinds = ['mutated'];

    expect(kind.toRegistration().defaultContext?.contains?.kinds).toEqual(['repo']);
  });

  it('serializes projection affordances into kind registration metadata', () => {
    const kind = defineArtifactKind({
      kind: 'affordance-test',
      description: 'Artifact kind for projection affordance serialization tests.',
      schemaVersion: '1',
      dataSchema: z.object({ title: z.string() }),
      conflictPolicy: 'supersedes',
      projection: {
        mode: 'surface',
        affordances: [
          { kind: 'own-view' },
          { kind: 'inline', hostRelation: 'blocked-by', as: 'summary' },
          { kind: 'entry', via: 'dashboard' },
        ],
      },
    });

    const registration = ArtifactKindRegistrationSchema.parse(kind.toRegistration());
    expect(registration.projection?.affordances).toEqual([
      { kind: 'own-view' },
      { kind: 'inline', hostRelation: 'blocked-by', as: 'summary' },
      { kind: 'entry', via: 'dashboard' },
    ]);
  });

  it('defensively copies affordances so registration mutation does not affect future calls', () => {
    const kind = defineArtifactKind({
      kind: 'affordance-copy-test',
      description: 'Artifact kind for affordance defensive-copy tests.',
      schemaVersion: '1',
      dataSchema: z.object({ v: z.string() }),
      conflictPolicy: 'coexist',
      projection: {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }],
      },
    });

    const reg1 = kind.toRegistration();
    // Mutate the emitted affordances array
    (reg1.projection!.affordances as Record<string, unknown>[]).push({ kind: 'inline', hostRelation: 'x' });

    const reg2 = kind.toRegistration();
    expect(reg2.projection!.affordances).toHaveLength(1);
  });

  it('defensively copies projected field fromLevel and viewRole in toRegistration', () => {
    const projectedFields: ProjectedField[] = [
      { path: 'title', viewRole: 'title', fromLevel: 'link' },
      { path: 'status', semantic: 'status', fromLevel: 'summary' },
    ];
    const kind = defineArtifactKind({
      kind: 'projected-level-test',
      description: 'Artifact kind for projected field fromLevel copy tests.',
      schemaVersion: '1',
      dataSchema: z.object({ title: z.string(), status: z.string() }),
      conflictPolicy: 'manual',
      projection: {
        mode: 'surface',
        projectedFields,
      },
    });

    const reg1 = kind.toRegistration();
    // Mutate emitted projected fields
    (reg1.projection!.projectedFields![0] as Record<string, unknown>).fromLevel = 'full';

    const reg2 = kind.toRegistration();
    expect(reg2.projection!.projectedFields![0]?.fromLevel).toBe('link');
    expect(reg2.projection!.projectedFields![0]?.viewRole).toBe('title');
    expect(reg2.projection!.projectedFields![1]?.fromLevel).toBe('summary');
  });

  it('omits affordances from projection when not supplied', () => {
    const kind = defineArtifactKind({
      kind: 'no-affordance-test',
      description: 'Artifact kind without affordance declarations.',
      schemaVersion: '1',
      dataSchema: z.object({ v: z.string() }),
      conflictPolicy: 'coexist',
      projection: { mode: 'surface' },
    });

    const registration = kind.toRegistration();
    expect(registration.projection?.affordances).toBeUndefined();
  });
});
