import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_RESOLVE_PART_ERROR_CODES,
  ArtifactKindRegistrationSchema,
  ArtifactResolvePartErrorSchema,
  ArtifactResolvePartRequestSchema,
  ArtifactResolvePartResponseSchema,
  checkArtifactPartIds,
  resolveArtifactPart,
} from '../../index.js';
import { expectAddressablePartsIssue } from './artifact-parts.test-support.js';

// ──────────────────────────────────────────────────────────────────────────────
// JSON Schema fixtures (module-level, as const satisfies Record<string, unknown>)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Data schema for the question-collection fixture:
 * `{ title, questions: [{ id (required), text (required), answer? }] }`.
 */
const QUESTION_COLLECTION_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          answer: { type: 'string' },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

/**
 * Data schema for the review-report fixture:
 * `{ title, findings: [{ id (required), note (required), evidence: { file, line } }] }`.
 */
const REVIEW_REPORT_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'note', 'evidence'],
        properties: {
          id: { type: 'string' },
          note: { type: 'string' },
          evidence: {
            type: 'object',
            required: ['file', 'line'],
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

/**
 * Data schema for the two-area fixture:
 * both `questions` and `findings` arrays declared.
 */
const TWO_AREA_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'note'],
        properties: {
          id: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────────────
// Declared part-area descriptors
// ──────────────────────────────────────────────────────────────────────────────

/** Declared areas for the question-collection fixture. */
const QUESTION_AREAS = [{ path: 'questions', idPath: 'id' }] as const;

/** Declared areas for the review-report fixture. */
const FINDING_AREAS = [{ path: 'findings', idPath: 'id' }] as const;

/** Declared areas for the two-area cross-area fixture. */
const TWO_AREAS = [
  { path: 'questions', idPath: 'id' },
  { path: 'findings', idPath: 'id' },
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// Registration helper
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid kind-registration payload with the given overrides.
 * @param overrides - Fields to merge into the base registration.
 * @returns A plain-object registration candidate.
 */
function baseRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'test-kind',
    description: 'A test artifact kind.',
    schemaVersion: 1,
    category: 'record',
    titlePath: 'title',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Registration-time validation
// ──────────────────────────────────────────────────────────────────────────────

describe('registration-time validation of addressable-part areas', () => {
  it('accepts a valid question-collection registration', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: QUESTION_COLLECTION_SCHEMA,
        addressableParts: QUESTION_AREAS,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a valid review-report registration', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: REVIEW_REPORT_SCHEMA,
        addressableParts: FINDING_AREAS,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a registration with two declared areas', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: TWO_AREA_SCHEMA,
        addressableParts: TWO_AREAS,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an area path not declared in the data schema', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: QUESTION_COLLECTION_SCHEMA,
        addressableParts: [{ path: 'undeclared', idPath: 'id' }],
      }),
    );
    expectAddressablePartsIssue(result);
  });

  it('rejects an area path pointing at a non-array property', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: QUESTION_COLLECTION_SCHEMA,
        // 'title' is a string, not an array
        addressableParts: [{ path: 'title', idPath: 'id' }],
      }),
    );
    expectAddressablePartsIssue(result);
  });

  it('accepts an optional array property as area path (type check, not requiredness)', () => {
    // 'questions' is not listed in the top-level required array
    const schemaWithOptionalArray = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: schemaWithOptionalArray,
        addressableParts: [{ path: 'questions', idPath: 'id' }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an idPath selecting an optional string in the element (must be required)', () => {
    // 'id' is in properties but NOT in required
    const schemaWithOptionalId = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: schemaWithOptionalId,
        addressableParts: [{ path: 'items', idPath: 'id' }],
      }),
    );
    expectAddressablePartsIssue(result, (p) => p.includes('addressableParts') && p.includes('idPath'));
  });

  it('rejects an idPath selecting a number in the element', () => {
    const schemaWithNumericId = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'number' } },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: schemaWithNumericId,
        addressableParts: [{ path: 'items', idPath: 'id' }],
      }),
    );
    expectAddressablePartsIssue(result, (p) => p.includes('addressableParts') && p.includes('idPath'));
  });

  it('rejects duplicate area path values across two entries', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({
        dataSchema: QUESTION_COLLECTION_SCHEMA,
        addressableParts: [
          { path: 'questions', idPath: 'id' },
          { path: 'questions', idPath: 'id' },
        ],
      }),
    );
    expectAddressablePartsIssue(result, (p) => p.includes('addressableParts') && p.includes('path'));
  });

  it('parses a kind WITHOUT addressableParts exactly as before (backward compatibility)', () => {
    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema: QUESTION_COLLECTION_SCHEMA }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addressableParts).toBeUndefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. checkArtifactPartIds — write-time identifier constraints
// ──────────────────────────────────────────────────────────────────────────────

describe('checkArtifactPartIds', () => {
  it('returns no issues for a valid payload with unique ids in one area', () => {
    const data = {
      questions: [
        { id: 'q1', text: 'What is X?' },
        { id: 'q2', text: 'What is Y?' },
      ],
    } as const satisfies Record<string, unknown>;
    expect(checkArtifactPartIds([...QUESTION_AREAS], data)).toEqual([]);
  });

  it('returns no issues when the declared area array is absent from the data', () => {
    expect(checkArtifactPartIds([...QUESTION_AREAS], {})).toEqual([]);
  });

  it('issues one error for an empty-string id at the concrete path', () => {
    const data = {
      questions: [
        { id: 'q1', text: 'First' },
        { id: '', text: 'Empty id' },
      ],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('questions.1.id');
  });

  it('issues one error for a whitespace-only id at the concrete path', () => {
    const data = {
      questions: [
        { id: 'q1', text: 'First' },
        { id: '  ', text: 'Blank id' },
      ],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('questions.1.id');
  });

  it('does not flag a trailing-space id as duplicate of the trimmed id (verbatim comparison)', () => {
    // 'q1' and 'q1 ' are different verbatim ids — no duplicate issue expected
    const data = {
      questions: [
        { id: 'q1', text: 'First' },
        { id: 'q1 ', text: 'Trailing space' },
      ],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data);
    expect(issues).toHaveLength(0);
  });

  it('issues one error for a verbatim duplicate within one area, naming the prior location', () => {
    const data = {
      questions: [
        { id: 'q1', text: 'First occurrence' },
        { id: 'q1', text: 'Duplicate' },
      ],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('questions.1.id');
    expect(issues[0]?.reason).toContain('questions.0.id');
  });

  it('issues one error for a cross-area duplicate id, naming the prior area location', () => {
    const data = {
      questions: [{ id: 'shared-id', text: 'Question' }],
      findings: [{ id: 'shared-id', note: 'Finding' }],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...TWO_AREAS], data);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('findings.0.id');
    expect(issues[0]?.reason).toContain('questions.0.id');
  });

  it('issues one error when the idPath value is missing from an element', () => {
    const data = {
      questions: [{ text: 'No id field' }],
    } as const satisfies Record<string, unknown>;
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('questions.0.id');
  });

  it('issues one error when the idPath value is not a string', () => {
    const data = {
      questions: [{ id: 42, text: 'Numeric id' }],
    };
    const issues = checkArtifactPartIds([...QUESTION_AREAS], data as Record<string, unknown>);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('questions.0.id');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. resolveArtifactPart — pure resolution
// ──────────────────────────────────────────────────────────────────────────────

/** R4 revision data: three questions with no answers. */
const R4_DATA = {
  title: 'Quiz',
  questions: [
    { id: 'q1', text: 'What is 1+1?' },
    { id: 'q2', text: 'What is 2+2?' },
    { id: 'q3', text: 'What is 3+3?' },
  ],
} as const satisfies Record<string, unknown>;

/** R5 revision data: reordered questions, q3 gains an answer. */
const R5_DATA = {
  title: 'Quiz v2',
  questions: [
    { id: 'q2', text: 'What is 2+2?' },
    { id: 'q3', text: 'What is 3+3?', answer: '6' },
    { id: 'q1', text: 'What is 1+1?' },
  ],
} as const satisfies Record<string, unknown>;

/** R6 revision data: q3 removed. */
const R6_DATA = {
  title: 'Quiz v3',
  questions: [
    { id: 'q1', text: 'What is 1+1?' },
    { id: 'q2', text: 'What is 2+2?' },
  ],
} as const satisfies Record<string, unknown>;

describe('resolveArtifactPart', () => {
  describe('question-collection — position-independent resolution across revisions', () => {
    // f7: renamed to fold pin-semantics intent; toStrictEqual already covers
    // answer-field absence — the separate "pin semantics" test was redundant.
    it('resolves q3 from R4: verbatim element with areaPath (toStrictEqual covers absence of fields like answer)', () => {
      const result = resolveArtifactPart([...QUESTION_AREAS], R4_DATA, 'q3');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.areaPath).toBe('questions');
        expect(result.part).toStrictEqual({ id: 'q3', text: 'What is 3+3?' });
      }
    });

    it('resolves q3 from R5: returns the reordered, updated element (identity by id, not position)', () => {
      const result = resolveArtifactPart([...QUESTION_AREAS], R5_DATA, 'q3');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.areaPath).toBe('questions');
        expect(result.part).toStrictEqual({
          id: 'q3',
          text: 'What is 3+3?',
          answer: '6',
        });
      }
    });

    it('returns part-not-found when q3 is absent from R6', () => {
      const result = resolveArtifactPart([...QUESTION_AREAS], R6_DATA, 'q3');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('PART_NOT_FOUND');
      }
    });
  });

  describe('review-report — same generic function handles nested evidence objects', () => {
    /** Review-report revision with two findings. */
    const REPORT_DATA = {
      title: 'Code Review',
      findings: [
        {
          id: 'f7',
          note: 'Missing null check',
          evidence: { file: 'src/auth.ts', line: 42 },
        },
        {
          id: 'f8',
          note: 'Unused import',
          evidence: { file: 'src/util.ts', line: 5 },
        },
      ],
    } as const satisfies Record<string, unknown>;

    it('resolves f7 including its nested evidence object (deep-equal)', () => {
      const result = resolveArtifactPart([...FINDING_AREAS], REPORT_DATA, 'f7');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.areaPath).toBe('findings');
        expect(result.part).toStrictEqual({
          id: 'f7',
          note: 'Missing null check',
          evidence: { file: 'src/auth.ts', line: 42 },
        });
      }
    });
  });

  describe('no-parts-declared', () => {
    it('returns no-parts-declared when the areas array is empty', () => {
      const result = resolveArtifactPart([], R4_DATA, 'q1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('NO_PARTS_DECLARED');
      }
    });

    it('returns no-parts-declared even when the data has matching structure', () => {
      const result = resolveArtifactPart([], { questions: [{ id: 'q1', text: 'X' }] }, 'q1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('NO_PARTS_DECLARED');
      }
    });
  });

  describe('historical-duplicate handling', () => {
    it('returns duplicate-local-id when two elements share the same id', () => {
      const dataWithDuplicate = {
        questions: [
          { id: 'q1', text: 'First occurrence' },
          { id: 'q1', text: 'Second occurrence' },
        ],
      };
      const result = resolveArtifactPart([...QUESTION_AREAS], dataWithDuplicate, 'q1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('DUPLICATE_LOCAL_ID');
      }
    });

    it('never returns one of the two matching elements — only the duplicate-local-id signal', () => {
      const dataWithDuplicate = {
        questions: [
          { id: 'q2', text: 'Unambiguous' },
          { id: 'q1', text: 'First' },
          { id: 'q1', text: 'Second' },
        ],
      };
      const result = resolveArtifactPart([...QUESTION_AREAS], dataWithDuplicate, 'q1');
      // Must not pick arbitrarily — must surface the ambiguity
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('DUPLICATE_LOCAL_ID');
      }
    });
  });

  describe('verbatim id matching', () => {
    it('returns part-not-found when looking up a trailing-space variant of a stored id', () => {
      const result = resolveArtifactPart([...QUESTION_AREAS], R4_DATA, 'q1 ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('PART_NOT_FOUND');
      }
    });

    it('returns part-not-found for a leading-space variant of a stored id', () => {
      const result = resolveArtifactPart([...QUESTION_AREAS], R4_DATA, ' q1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('PART_NOT_FOUND');
      }
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Bus contract schemas
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal valid artifact ref for bus contract tests. */
const ARTIFACT_REF = {
  refClass: 'artifact' as const,
  kind: 'question-collection',
  id: 'art-1',
  revision: 'rev-1',
};

describe('ArtifactResolvePartRequestSchema', () => {
  it('parses without explicit outer refClass — defaulted to local by the schema', () => {
    const result = ArtifactResolvePartRequestSchema.safeParse({
      ref: { artifact: ARTIFACT_REF, localId: 'q1' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ref.refClass).toBe('local');
    }
  });

  it('parses with explicit refClass: local', () => {
    const result = ArtifactResolvePartRequestSchema.safeParse({
      ref: { refClass: 'local', artifact: ARTIFACT_REF, localId: 'q1' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ref.refClass).toBe('local');
    }
  });

  it('rejects a missing localId', () => {
    const result = ArtifactResolvePartRequestSchema.safeParse({
      ref: { artifact: ARTIFACT_REF },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string localId', () => {
    const result = ArtifactResolvePartRequestSchema.safeParse({
      ref: { artifact: ARTIFACT_REF, localId: '' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ArtifactResolvePartResponseSchema', () => {
  it('accepts the ok-shape with ref, areaPath, and part', () => {
    const result = ArtifactResolvePartResponseSchema.safeParse({
      ok: true,
      ref: { refClass: 'local', artifact: ARTIFACT_REF, localId: 'q1' },
      areaPath: 'questions',
      part: { id: 'q1', text: 'What is X?' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the error-shape with a known code, message, and repair hint', () => {
    const result = ArtifactResolvePartResponseSchema.safeParse({
      ok: false,
      error: {
        code: 'PART_NOT_FOUND',
        message: 'No part with that id.',
        repair: 'Check the available part ids via the kind registration.',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an error-shape without a repair hint', () => {
    const result = ArtifactResolvePartResponseSchema.safeParse({
      ok: false,
      error: {
        code: 'PART_NOT_FOUND',
        message: 'No part with that id.',
        // repair is intentionally omitted
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown error code', () => {
    const result = ArtifactResolvePartResponseSchema.safeParse({
      ok: false,
      error: {
        code: 'INVENTED_CODE',
        message: 'Something went wrong.',
        repair: 'Try a different approach.',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ARTIFACT_RESOLVE_PART_ERROR_CODES', () => {
  it('contains all five stable codes', () => {
    expect(ARTIFACT_RESOLVE_PART_ERROR_CODES).toContain('ARTIFACT_NOT_FOUND');
    expect(ARTIFACT_RESOLVE_PART_ERROR_CODES).toContain('KIND_NOT_REGISTERED');
    expect(ARTIFACT_RESOLVE_PART_ERROR_CODES).toContain('NO_PARTS_DECLARED');
    expect(ARTIFACT_RESOLVE_PART_ERROR_CODES).toContain('PART_NOT_FOUND');
    expect(ARTIFACT_RESOLVE_PART_ERROR_CODES).toContain('DUPLICATE_LOCAL_ID');
  });
});

describe('ArtifactResolvePartErrorSchema', () => {
  it('accepts a valid error with all three required fields', () => {
    const result = ArtifactResolvePartErrorSchema.safeParse({
      code: 'NO_PARTS_DECLARED',
      message: 'This kind declares no addressable parts.',
      repair: 'Use a kind that declares addressable-part areas.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty message', () => {
    const result = ArtifactResolvePartErrorSchema.safeParse({
      code: 'PART_NOT_FOUND',
      message: '',
      repair: 'Check the id.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty repair hint', () => {
    const result = ArtifactResolvePartErrorSchema.safeParse({
      code: 'PART_NOT_FOUND',
      message: 'Part not found.',
      repair: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an extra field on the strict object', () => {
    const result = ArtifactResolvePartErrorSchema.safeParse({
      code: 'PART_NOT_FOUND',
      message: 'Part not found.',
      repair: 'Check the id.',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });
});
