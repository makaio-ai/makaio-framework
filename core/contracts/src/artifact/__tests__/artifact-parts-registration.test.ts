/**
 * Additional registration-time and write-time coverage for addressable-part
 * areas (f15a–e). These tests were split into a sibling file to keep the
 * main artifact-parts.test.ts within the 800-line lint limit.
 */
import { describe, expect, it } from 'vitest';
import { ArtifactKindRegistrationSchema, checkArtifactPartIds, resolveArtifactPart } from '../../index.js';
import { expectAddressablePartsIssue } from './artifact-parts.test-support.js';

// ──────────────────────────────────────────────────────────────────────────────
// Registration helper (mirrors the one in the main test file)
// ──────────────────────────────────────────────────────────────────────────────

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
// f15a — Nested idPath requiredness
// ──────────────────────────────────────────────────────────────────────────────

describe('f15a: nested idPath requiredness', () => {
  it('rejects meta.id when meta is optional in the element (requiredAfterElement enforces whole chain)', () => {
    // meta is NOT in the element's required array
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['other'],
            properties: {
              other: { type: 'string' },
              meta: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
            },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'meta.id' }] }),
    );
    expectAddressablePartsIssue(result, (p) => p.includes('addressableParts') && p.includes('idPath'));
  });

  it('accepts meta.id when meta is required in the element and id is required inside meta', () => {
    // Both meta and id are in their respective required arrays
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['meta'],
            properties: {
              meta: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
            },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'meta.id' }] }),
    );
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// f15b — Cross-area duplicate: checkArtifactPartIds AND resolveArtifactPart
// ──────────────────────────────────────────────────────────────────────────────

describe('f15b: cross-area duplicate id', () => {
  const TWO_AREAS = [
    { path: 'questions', idPath: 'id' },
    { path: 'findings', idPath: 'id' },
  ] as const;

  it('checkArtifactPartIds rejects and resolveArtifactPart returns DUPLICATE_LOCAL_ID when the same id appears once in each of two declared areas', () => {
    const data: Record<string, unknown> = {
      questions: [{ id: 'shared-id', text: 'Question' }],
      findings: [{ id: 'shared-id', note: 'Finding' }],
    };

    const issues = checkArtifactPartIds([...TWO_AREAS], data);
    expect(issues.length).toBeGreaterThan(0);

    const resolution = resolveArtifactPart([...TWO_AREAS], data, 'shared-id');
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe('DUPLICATE_LOCAL_ID');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// f15c — Tuple rejection
// ──────────────────────────────────────────────────────────────────────────────

describe('tuple-profile rejection', () => {
  it('rejects an area array schema that carries prefixItems (draft 2020-12 tuple)', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          prefixItems: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });

  it('rejects an area array schema whose items keyword is an array (draft-7 tuple)', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: [
            { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            { type: 'object', properties: { note: { type: 'string' } } },
          ],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });

  // Tuple area schemas hidden under allOf/anyOf/$ref-with-siblings must also be
  // rejected: combineConjuncts propagates prefixItems through conjunct combination
  // the same way items is propagated, so a composed tuple schema is detected as a
  // tuple and registration is refused.

  it('rejects a part area whose array schema carries prefixItems under allOf with a sibling conjunct', () => {
    // combineConjuncts must propagate prefixItems from each conjunct; without it the
    // combined fragment would have no prefixItems and hasTupleShape would return false.
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          allOf: [
            { prefixItems: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }] },
            { minItems: 1 },
          ],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });

  it('rejects a part area whose array schema carries prefixItems in one anyOf branch', () => {
    // combineUnionBranchNode injects an allOf wrapper around each branch; prefixItems
    // must be propagated through that wrapper so the tuple branch is not treated as a
    // homogeneous array — if it is, registration would incorrectly accept the area.
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          anyOf: [
            {
              type: 'array',
              prefixItems: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }],
            },
            {
              type: 'array',
              items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            },
          ],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });

  it('rejects a part area whose $ref carries prefixItems as a draft-2020-12 sibling', () => {
    // resolveRef merges draft-2020-12 siblings into allOf; prefixItems from that sibling
    // must survive conjunct combination so the tuple area is detected and rejected.
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['title'],
      $defs: {
        base: { type: 'array' },
      },
      properties: {
        title: { type: 'string' },
        items: {
          $ref: '#/$defs/base',
          prefixItems: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });

  it('accepts a part area whose array schema uses allOf composition with homogeneous object items', () => {
    // Composed non-tuple areas must not be over-rejected: a composed array schema
    // without prefixItems and with a homogeneous items schema satisfies the profile.
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          allOf: [
            { items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
            { minItems: 0 },
          ],
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// f15d — Singleton type arrays
// ──────────────────────────────────────────────────────────────────────────────

describe('f15d: singleton type arrays', () => {
  it('accepts type:[array] on the area and type:[string] on the id field (singleton array = exact type)', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: ['array'],
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: ['string'] } },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects type:[array,null] on the area (multi-member type array is not an unconditional array)', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// f15e — Union alternatives: inline, $ref, and rejected partial
// ──────────────────────────────────────────────────────────────────────────────

describe('f15e: union alternatives in element schemas', () => {
  it('accepts an inline anyOf element schema where every leaf has a required string id', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' }, a: { type: 'string' } },
              },
              {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' }, b: { type: 'string' } },
              },
            ],
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a $ref-referenced union where every leaf has a required string id (pins $ref resolution fix)', () => {
    // The element schema IS a $ref to an anyOf schema. Before the production fix,
    // this was falsely rejected. The fix resolves the $ref target before distributing
    // union alternatives, so all leaves are individually inspected.
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['title'],
      $defs: {
        entry: {
          anyOf: [
            {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, a: { type: 'string' } },
            },
            {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, b: { type: 'string' } },
            },
          ],
        },
      },
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: { $ref: '#/$defs/entry' },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an anyOf element schema where one leaf has an optional id (all leaves must require id)', () => {
    const dataSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } },
              },
              {
                // id is declared but NOT in required — makes id optional in this leaf
                type: 'object',
                properties: { id: { type: 'string' } },
              },
            ],
          },
        },
      },
    } as const satisfies Record<string, unknown>;

    const result = ArtifactKindRegistrationSchema.safeParse(
      baseRegistration({ dataSchema, addressableParts: [{ path: 'items', idPath: 'id' }] }),
    );
    expectAddressablePartsIssue(result, (p) => p.includes('addressableParts') && p.includes('idPath'));
  });
});
