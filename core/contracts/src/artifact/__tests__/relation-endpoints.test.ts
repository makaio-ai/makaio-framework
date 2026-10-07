import { describe, expect, it } from 'vitest';

import {
  mergeRelationTypeRegistrations,
  normalizeRelationTypeRegistration,
  relationEndpointPermits,
  relationTypeEndpoints,
  relationTypePermits,
} from '../relation-endpoints.js';
import type { RelationEndpointCandidate } from '../relation-endpoints.js';
import type { RelationTypeRegistration } from '../schemas.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function candidate(
  sourceKind: string,
  targetKind: string | undefined,
  targetRefClass: RelationEndpointCandidate['targetRefClass'] = 'artifact',
): RelationEndpointCandidate {
  return targetKind === undefined ? { sourceKind, targetRefClass } : { sourceKind, targetKind, targetRefClass };
}

const partOf: RelationTypeRegistration = {
  type: 'part_of',
  symmetry: 'asymmetric',
  endpoints: [
    { sourceKinds: ['knowledge-document'], targetKinds: ['knowledge-document'] },
    { sourceKinds: ['capability'], targetKinds: ['capability'] },
  ],
};

// ── relationTypeEndpoints ─────────────────────────────────────────────────────

describe('relationTypeEndpoints', () => {
  it('returns endpoints when present', () => {
    expect(relationTypeEndpoints(partOf)).toEqual(partOf.endpoints);
  });

  it('builds one entry from the shorthand fields', () => {
    const registration: RelationTypeRegistration = {
      type: 'x',
      symmetry: 'asymmetric',
      sourceKinds: ['a'],
      targetKinds: ['b'],
      targetRefClasses: ['artifact'],
    };
    expect(relationTypeEndpoints(registration)).toEqual([
      { sourceKinds: ['a'], targetKinds: ['b'], targetRefClasses: ['artifact'] },
    ]);
  });

  it('omits absent shorthand lists from the built entry', () => {
    const registration: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', sourceKinds: ['a'] };
    const [entry] = relationTypeEndpoints(registration);
    expect(Object.keys(entry ?? {})).toEqual(['sourceKinds']);
  });

  it('returns a single open entry for a registration without constraints', () => {
    expect(relationTypeEndpoints({ type: 'x', symmetry: 'symmetric' })).toEqual([{}]);
  });

  it('returns an empty array for an explicit empty endpoints list', () => {
    expect(relationTypeEndpoints({ type: 'x', symmetry: 'asymmetric', endpoints: [] })).toEqual([]);
  });

  it('returns a non-empty array for every other registration shape', () => {
    const registrations: RelationTypeRegistration[] = [
      { type: 'x', symmetry: 'asymmetric' },
      { type: 'x', symmetry: 'asymmetric', sourceKinds: [] },
      partOf,
    ];
    for (const registration of registrations) {
      expect(relationTypeEndpoints(registration).length).toBeGreaterThan(0);
    }
  });
});

// ── relationEndpointPermits ───────────────────────────────────────────────────

describe('relationEndpointPermits', () => {
  it('treats omitted lists as open', () => {
    expect(relationEndpointPermits({}, candidate('a', 'b'))).toBe(true);
    expect(relationEndpointPermits({}, candidate('a', undefined, 'local'))).toBe(true);
  });

  it('treats a present list as an allowlist', () => {
    const endpoint = { sourceKinds: ['a', 'c'] };
    expect(relationEndpointPermits(endpoint, candidate('a', 'x'))).toBe(true);
    expect(relationEndpointPermits(endpoint, candidate('c', 'x'))).toBe(true);
    expect(relationEndpointPermits(endpoint, candidate('b', 'x'))).toBe(false);
  });

  it('permits nothing for an empty list', () => {
    expect(relationEndpointPermits({ sourceKinds: [] }, candidate('a', 'b'))).toBe(false);
    expect(relationEndpointPermits({ targetKinds: [] }, candidate('a', 'b'))).toBe(false);
    expect(relationEndpointPermits({ targetRefClasses: [] }, candidate('a', 'b'))).toBe(false);
  });

  it('misses when targetKinds is present and the candidate has no targetKind', () => {
    expect(relationEndpointPermits({ targetKinds: ['b'] }, candidate('a', undefined))).toBe(false);
  });

  it('checks targetKinds against the candidate targetKind', () => {
    expect(relationEndpointPermits({ targetKinds: ['b'] }, candidate('a', 'b'))).toBe(true);
    expect(relationEndpointPermits({ targetKinds: ['b'] }, candidate('a', 'c'))).toBe(false);
  });

  it('checks targetRefClasses', () => {
    const endpoint = { targetRefClasses: ['artifact' as const, 'entity' as const] };
    expect(relationEndpointPermits(endpoint, candidate('a', 'b', 'artifact'))).toBe(true);
    expect(relationEndpointPermits(endpoint, candidate('a', 'b', 'entity'))).toBe(true);
    expect(relationEndpointPermits(endpoint, candidate('a', 'b', 'local'))).toBe(false);
  });

  it('requires all present lists to permit', () => {
    const endpoint = { sourceKinds: ['a'], targetKinds: ['b'], targetRefClasses: ['artifact' as const] };
    expect(relationEndpointPermits(endpoint, candidate('a', 'b'))).toBe(true);
    expect(relationEndpointPermits(endpoint, candidate('a', 'b', 'local'))).toBe(false);
    expect(relationEndpointPermits(endpoint, candidate('z', 'b'))).toBe(false);
  });
});

// ── relationTypePermits ───────────────────────────────────────────────────────

describe('relationTypePermits', () => {
  it('permits same-kind pairs of the part_of example', () => {
    expect(relationTypePermits(partOf, candidate('knowledge-document', 'knowledge-document'))).toBe(true);
    expect(relationTypePermits(partOf, candidate('capability', 'capability'))).toBe(true);
  });

  it('rejects cross-kind pairs of the part_of example', () => {
    expect(relationTypePermits(partOf, candidate('knowledge-document', 'capability'))).toBe(false);
    expect(relationTypePermits(partOf, candidate('capability', 'knowledge-document'))).toBe(false);
  });

  it('permits every source of a cross-product entry', () => {
    const registration: RelationTypeRegistration = {
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['requirement', 'guideline'], targetKinds: ['capability'] }],
    };
    expect(relationTypePermits(registration, candidate('requirement', 'capability'))).toBe(true);
    expect(relationTypePermits(registration, candidate('guideline', 'capability'))).toBe(true);
    expect(relationTypePermits(registration, candidate('concept', 'capability'))).toBe(false);
  });

  it('permits everything for an unconstrained registration', () => {
    expect(relationTypePermits({ type: 'x', symmetry: 'symmetric' }, candidate('a', undefined, 'local'))).toBe(true);
  });

  it('permits nothing for an explicit empty endpoints list', () => {
    const registration: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', endpoints: [] };
    expect(relationTypePermits(registration, candidate('a', 'b'))).toBe(false);
    expect(relationTypePermits(registration, candidate('a', undefined, 'local'))).toBe(false);
  });

  it('evaluates shorthand registrations', () => {
    const registration: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', sourceKinds: ['a'] };
    expect(relationTypePermits(registration, candidate('a', 'b'))).toBe(true);
    expect(relationTypePermits(registration, candidate('b', 'b'))).toBe(false);
  });

  describe('symmetric reversal', () => {
    const symmetricAB: RelationTypeRegistration = {
      type: 'x',
      symmetry: 'symmetric',
      sourceKinds: ['a'],
      targetKinds: ['b'],
    };

    it.each([
      ['a', 'b', true],
      ['b', 'a', true],
      ['a', 'a', false],
      ['b', 'b', false],
    ])('symmetric %s to artifact %s is %s', (sourceKind, targetKind, expected) => {
      expect(relationTypePermits(symmetricAB, candidate(sourceKind, targetKind))).toBe(expected);
    });

    it('does not reverse an asymmetric registration', () => {
      const registration: RelationTypeRegistration = { ...symmetricAB, symmetry: 'asymmetric' };
      expect(relationTypePermits(registration, candidate('a', 'b'))).toBe(true);
      expect(relationTypePermits(registration, candidate('b', 'a'))).toBe(false);
    });

    it('does not reverse a candidate whose target is not an artifact', () => {
      expect(relationTypePermits(symmetricAB, candidate('b', 'a', 'evidence'))).toBe(false);
      expect(relationTypePermits(symmetricAB, candidate('b', undefined, 'local'))).toBe(false);
    });

    it('does not reverse an artifact target without a kind', () => {
      expect(relationTypePermits(symmetricAB, candidate('b', undefined))).toBe(false);
    });

    it('requires artifact in targetRefClasses for the reversed check', () => {
      const registration: RelationTypeRegistration = {
        type: 'x',
        symmetry: 'symmetric',
        sourceKinds: ['a'],
        targetRefClasses: ['entity'],
      };
      expect(relationTypePermits(registration, candidate('b', 'a'))).toBe(false);
    });

    it('checks endpoint entries whole without mixing kinds across entries', () => {
      const registration: RelationTypeRegistration = {
        type: 'x',
        symmetry: 'symmetric',
        endpoints: [
          { sourceKinds: ['a'], targetKinds: ['b'] },
          { sourceKinds: ['c'], targetKinds: ['d'] },
        ],
      };
      expect(relationTypePermits(registration, candidate('d', 'c'))).toBe(true);
      expect(relationTypePermits(registration, candidate('b', 'a'))).toBe(true);
      expect(relationTypePermits(registration, candidate('b', 'c'))).toBe(false);
      expect(relationTypePermits(registration, candidate('d', 'a'))).toBe(false);
    });

    it('does not reverse when the implication names a different type', () => {
      expect(relationTypePermits({ ...symmetricAB, implication: 'y' }, candidate('b', 'a'))).toBe(false);
    });

    it('reverses when the implication equals the type itself', () => {
      expect(relationTypePermits({ ...symmetricAB, implication: 'x' }, candidate('b', 'a'))).toBe(true);
    });

    // An open symmetric type permitting everything is covered by 'permits everything for an unconstrained registration'.
    it('permits nothing in either orientation for an explicit empty endpoints list', () => {
      const registration: RelationTypeRegistration = { type: 'x', symmetry: 'symmetric', endpoints: [] };
      expect(relationTypePermits(registration, candidate('a', 'b'))).toBe(false);
      expect(relationTypePermits(registration, candidate('b', 'a'))).toBe(false);
    });
  });
});

// ── normalizeRelationTypeRegistration ─────────────────────────────────────────

describe('normalizeRelationTypeRegistration', () => {
  it('folds shorthand into endpoints and drops the shorthand fields', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      sourceKinds: ['a'],
      targetKinds: ['b'],
      targetRefClasses: ['artifact'],
    });
    expect(result).toEqual({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['a'], targetKinds: ['b'], targetRefClasses: ['artifact'] }],
    });
    expect(result).not.toHaveProperty('sourceKinds');
    expect(result).not.toHaveProperty('targetKinds');
    expect(result).not.toHaveProperty('targetRefClasses');
  });

  it('sorts and deduplicates lists', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['b', 'a', 'b'], targetRefClasses: ['local', 'artifact', 'local'] }],
    });
    expect(result.endpoints).toEqual([{ sourceKinds: ['a', 'b'], targetRefClasses: ['artifact', 'local'] }]);
  });

  it('deduplicates structurally equal entries', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['b', 'a'] }, { sourceKinds: ['a', 'b'] }, { sourceKinds: ['a'] }],
    });
    expect(result.endpoints).toEqual([{ sourceKinds: ['a', 'b'] }, { sourceKinds: ['a'] }]);
  });

  it('does not merge entries that differ in an omitted versus present list', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['a'] }, { sourceKinds: ['a'], targetKinds: [] }],
    });
    expect(result.endpoints).toHaveLength(2);
  });

  it('yields no endpoints key when an entry is open', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['a'] }, {}],
    });
    expect(result).toEqual({ type: 'x', symmetry: 'asymmetric' });
    expect(result).not.toHaveProperty('endpoints');
  });

  it('yields no endpoints key for a registration without constraints', () => {
    const result = normalizeRelationTypeRegistration({ type: 'x', symmetry: 'symmetric' });
    expect(result).not.toHaveProperty('endpoints');
  });

  it('keeps an explicit empty endpoints list', () => {
    const result = normalizeRelationTypeRegistration({ type: 'x', symmetry: 'asymmetric', endpoints: [] });
    expect(result).toEqual({ type: 'x', symmetry: 'asymmetric', endpoints: [] });
  });

  it('sorts entries by structural key', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'asymmetric',
      endpoints: [{ sourceKinds: ['c'] }, { sourceKinds: ['a'] }, { sourceKinds: ['b'] }],
    });
    expect(result.endpoints).toEqual([{ sourceKinds: ['a'] }, { sourceKinds: ['b'] }, { sourceKinds: ['c'] }]);
  });

  it('keeps implication', () => {
    const result = normalizeRelationTypeRegistration({
      type: 'x',
      symmetry: 'symmetric',
      implication: 'y',
      sourceKinds: ['a'],
    });
    expect(result.implication).toBe('y');
  });

  it('does not mutate a frozen input', () => {
    const input = deepFreeze<RelationTypeRegistration>({
      type: 'x',
      symmetry: 'asymmetric',
      implication: 'y',
      endpoints: [{ sourceKinds: ['b', 'a'] }],
    });
    const snapshot = structuredClone(input);
    expect(() => normalizeRelationTypeRegistration(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });
});

// ── mergeRelationTypeRegistrations ────────────────────────────────────────────

describe('mergeRelationTypeRegistrations', () => {
  const left: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', sourceKinds: ['a'], targetKinds: ['b'] };
  const right: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', sourceKinds: ['c'], targetKinds: ['d'] };

  it('unions entries from two shorthand contributions', () => {
    const result = mergeRelationTypeRegistrations(left, right);
    expect(result.endpoints).toEqual([
      { sourceKinds: ['a'], targetKinds: ['b'] },
      { sourceKinds: ['c'], targetKinds: ['d'] },
    ]);
    expect(result).not.toHaveProperty('sourceKinds');
  });

  it('merges identical contributions to one entry', () => {
    const result = mergeRelationTypeRegistrations(left, { ...left });
    expect(result.endpoints).toEqual([{ sourceKinds: ['a'], targetKinds: ['b'] }]);
  });

  it('lets an open contribution win over a constrained one', () => {
    const open: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric' };
    expect(mergeRelationTypeRegistrations(left, open)).not.toHaveProperty('endpoints');
    expect(mergeRelationTypeRegistrations(open, left)).not.toHaveProperty('endpoints');
  });

  it('takes implication from either side', () => {
    const withImplication: RelationTypeRegistration = { ...left, symmetry: 'asymmetric', implication: 'y' };
    expect(mergeRelationTypeRegistrations(withImplication, right).implication).toBe('y');
    expect(mergeRelationTypeRegistrations(right, withImplication).implication).toBe('y');
  });

  it('accepts the same implication on both sides', () => {
    const a: RelationTypeRegistration = { ...left, implication: 'y' };
    const b: RelationTypeRegistration = { ...right, implication: 'y' };
    expect(mergeRelationTypeRegistrations(a, b).implication).toBe('y');
  });

  it('throws a plain error for differing types', () => {
    expect(() => mergeRelationTypeRegistrations(left, { ...right, type: 'z' })).toThrow(Error);
    expect(() => mergeRelationTypeRegistrations(left, { ...right, type: 'z' })).toThrow(
      "Cannot merge relation type 'z' into relation type 'x'",
    );
  });

  it('throws a symmetry conflict with the exact message', () => {
    expect(() =>
      mergeRelationTypeRegistrations({ type: 'x', symmetry: 'asymmetric' }, { type: 'x', symmetry: 'symmetric' }),
    ).toThrow(
      expect.objectContaining({
        name: 'RelationTypeConflictError',
        field: 'symmetry',
        type: 'x',
        message:
          "Relation type 'x' is already registered with different symmetry (existing: 'asymmetric', new: 'symmetric')",
      }),
    );
  });

  it('throws an implication conflict for two differing implications', () => {
    expect(() => mergeRelationTypeRegistrations({ ...left, implication: 'y' }, { ...right, implication: 'z' })).toThrow(
      expect.objectContaining({
        name: 'RelationTypeConflictError',
        field: 'implication',
        type: 'x',
        message: "Relation type 'x' is already registered with different implication (existing: 'y', new: 'z')",
      }),
    );
  });

  it('is independent of argument order', () => {
    expect(mergeRelationTypeRegistrations(right, left)).toEqual(mergeRelationTypeRegistrations(left, right));
  });

  it('yields only the constrained entries when merging an empty endpoints list', () => {
    const empty: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', endpoints: [] };
    const expected = [{ sourceKinds: ['a'], targetKinds: ['b'] }];
    expect(mergeRelationTypeRegistrations(empty, left).endpoints).toEqual(expected);
    expect(mergeRelationTypeRegistrations(left, empty).endpoints).toEqual(expected);
  });

  it('keeps an empty endpoints list when both sides are empty', () => {
    const empty: RelationTypeRegistration = { type: 'x', symmetry: 'asymmetric', endpoints: [] };
    expect(mergeRelationTypeRegistrations(empty, empty).endpoints).toEqual([]);
  });

  it('mutates neither input', () => {
    const a = deepFreeze<RelationTypeRegistration>({ ...left, implication: 'y' });
    const b = deepFreeze<RelationTypeRegistration>({ ...right });
    const snapshots = [structuredClone(a), structuredClone(b)];
    expect(() => mergeRelationTypeRegistrations(a, b)).not.toThrow();
    expect([a, b]).toEqual(snapshots);
  });
});
