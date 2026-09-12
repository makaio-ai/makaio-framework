import { describe, expect, it } from 'vitest';
import { ArtifactKindRegistrationSchema, ArtifactRevisionSchema } from '@makaio/contracts';
import { host, patch } from './patch-artifact.test-support.js';

const questionKind = ArtifactKindRegistrationSchema.parse({
  kind: 'questionnaire',
  description: 'Questionnaire with locally addressable questions.',
  schemaVersion: 1,
  category: 'commitment',
  titlePath: 'title',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['id', 'text'],
        },
      },
    },
    required: ['title', 'questions'],
  },
  addressableParts: [{ path: 'questions', idPath: 'id' }],
});

const QUESTION_DATA = {
  title: 'Patch relation sources',
  questions: [
    { id: 'q2', text: 'Second question' },
    { id: 'q3', text: 'Third question' },
  ],
} as const;

const ENTITY_TARGET = { refClass: 'entity', entityType: 'questionnaire-answer', id: 'answer-1' } as const;

/**
 * Build a revision whose relations point only to an external entity.
 * @param sourceLocalId - Optional local source identifier carried by the relation.
 */
function revision(sourceLocalId?: string) {
  return ArtifactRevisionSchema.parse({
    kind: questionKind.kind,
    id: 'questionnaire-1',
    revision: 'rev-1',
    schemaVersion: questionKind.schemaVersion,
    scope: { level: 'global' },
    data: structuredClone(QUESTION_DATA),
    relations: [
      {
        type: 'answers',
        ...(sourceLocalId === undefined ? {} : { sourceLocalId }),
        target: ENTITY_TARGET,
      },
    ],
    actor: { kind: 'agent', id: 'test' },
    timestamp: 0,
  });
}

/**
 * Build a request against the fixture revision.
 * @param document - Patch instructions to apply to the fixture revision.
 * @param dryRun - Whether the request stops after validation.
 */
function request(document: unknown, dryRun = false) {
  return {
    ref: { kind: questionKind.kind, id: 'questionnaire-1' },
    baseRevision: 'rev-1',
    patch: document,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

describe('carried relation sources', () => {
  it('rejects removing a locally sourced part before calling the revision writer', async () => {
    const target = host({ registrations: [questionKind], current: revision('q2') });

    const response = await patch(request({ $pull: { questions: { id: 'q2' } } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        issues: [{ path: 'relations.0.sourceLocalId', reason: 'PART_NOT_FOUND' }],
        repair:
          'Restore the locally sourced part data, or create a full artifact revision that updates the affected relations; a data-only patch cannot change relations.',
      },
    });
    expect(target.writes).toStrictEqual([]);
  });

  it('rejects renaming a locally sourced part before calling the revision writer', async () => {
    const target = host({ registrations: [questionKind], current: revision('q2') });

    const response = await patch(request({ $set: { 'questions.0.id': 'q4' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        issues: [{ path: 'relations.0.sourceLocalId', reason: 'PART_NOT_FOUND' }],
      },
    });
    expect(target.writes).toStrictEqual([]);
  });

  it('reports the carried-source failure on a dry run without calling the revision writer', async () => {
    const target = host({ registrations: [questionKind], current: revision('q2') });

    const response = await patch(request({ $set: { 'questions.0.id': 'q4' } }, true), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'PAYLOAD_INVARIANT_FAILED',
        issues: [{ path: 'relations.0.sourceLocalId', reason: 'PART_NOT_FOUND' }],
      },
    });
    expect(target.writes).toStrictEqual([]);
  });

  it('keeps a locally sourced relation valid when its questions are reordered', async () => {
    const target = host({ registrations: [questionKind], current: revision('q2') });

    const response = await patch(
      request({
        $set: {
          questions: [
            { id: 'q3', text: 'Third question' },
            { id: 'q2', text: 'Second question' },
          ],
        },
      }),
      target,
    );

    expect(response).toMatchObject({ ok: true });
    expect(target.writes).toHaveLength(1);
  });

  it('allows a whole-artifact relation when a patch changes addressable parts', async () => {
    const target = host({ registrations: [questionKind], current: revision() });

    const response = await patch(request({ $set: { 'questions.0.id': 'q4' } }), target);

    expect(response).toMatchObject({ ok: true });
    expect(target.writes).toHaveLength(1);
  });
});
