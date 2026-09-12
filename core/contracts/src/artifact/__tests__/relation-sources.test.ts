import { describe, expect, it } from 'vitest';

import { ArtifactRelationSchema, checkArtifactRelationSourceParts } from '../../index.js';

const QUESTION_AREAS = [{ path: 'questions', idPath: 'id' }] as const;

const REVISION_WITH_Q2_AND_Q3 = {
  questions: [
    { id: 'q2', text: 'Second question' },
    { id: 'q3', text: 'Third question' },
  ],
} as const satisfies Record<string, unknown>;

const REVISION_WITH_REORDERED_QUESTIONS = {
  questions: [
    { id: 'q3', text: 'Third question' },
    { id: 'q2', text: 'Second question' },
  ],
} as const satisfies Record<string, unknown>;

const NEWER_REVISION_WITHOUT_Q2 = {
  questions: [{ id: 'q3', text: 'Third question' }],
} as const satisfies Record<string, unknown>;

function relation(sourceLocalId?: string) {
  return ArtifactRelationSchema.parse({
    type: 'answers',
    ...(sourceLocalId === undefined ? {} : { sourceLocalId }),
    target: { refClass: 'entity', entityType: 'questionnaire', id: 'questionnaire-1' },
  });
}

describe('artifact relation sources', () => {
  it('round-trips legacy and locally sourced relations while preserving the exact source id', () => {
    const legacy = relation();
    const local = relation('q2 / exact');

    expect(ArtifactRelationSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    expect(ArtifactRelationSchema.parse(JSON.parse(JSON.stringify(local)))).toEqual(local);
    expect(local.sourceLocalId).toBe('q2 / exact');
  });

  it('rejects blank local source identifiers', () => {
    expect(ArtifactRelationSchema.safeParse({ ...relation('q2'), sourceLocalId: '' }).success).toBe(false);
    expect(ArtifactRelationSchema.safeParse({ ...relation('q2'), sourceLocalId: '   ' }).success).toBe(false);
  });

  it('accepts relations declared by q2 and q3', () => {
    expect(
      checkArtifactRelationSourceParts(QUESTION_AREAS, REVISION_WITH_Q2_AND_Q3, [relation('q2'), relation('q3')]),
    ).toEqual([]);
  });

  it('reports missing, ambiguous, and undeclared local sources with their relation index', () => {
    const duplicateData = {
      questions: [
        { id: 'q2', text: 'First second question' },
        { id: 'q2', text: 'Second second question' },
      ],
    } as const satisfies Record<string, unknown>;

    expect(
      checkArtifactRelationSourceParts(QUESTION_AREAS, REVISION_WITH_Q2_AND_Q3, [relation(), relation('missing')]),
    ).toEqual([{ relationIndex: 1, reason: 'PART_NOT_FOUND' }]);
    expect(checkArtifactRelationSourceParts(QUESTION_AREAS, duplicateData, [relation(), relation('q2')])).toEqual([
      { relationIndex: 1, reason: 'DUPLICATE_LOCAL_ID' },
    ]);
    expect(checkArtifactRelationSourceParts([], REVISION_WITH_Q2_AND_Q3, [relation(), relation('q2')])).toEqual([
      { relationIndex: 1, reason: 'NO_PARTS_DECLARED' },
    ]);
  });

  it('keeps a source resolvable when its containing collection is reordered', () => {
    expect(
      checkArtifactRelationSourceParts(QUESTION_AREAS, REVISION_WITH_REORDERED_QUESTIONS, [relation('q2')]),
    ).toEqual([]);
  });

  it('resolves a source against its stored revision rather than a newer revision', () => {
    expect(checkArtifactRelationSourceParts(QUESTION_AREAS, REVISION_WITH_Q2_AND_Q3, [relation('q2')])).toEqual([]);
    expect(checkArtifactRelationSourceParts(QUESTION_AREAS, NEWER_REVISION_WITHOUT_Q2, [relation('q2')])).toEqual([
      { relationIndex: 0, reason: 'PART_NOT_FOUND' },
    ]);
  });

  it('allows whole-artifact relations when no addressable parts are declared', () => {
    expect(checkArtifactRelationSourceParts([], {}, [relation()])).toEqual([]);
  });
});
