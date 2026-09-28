import { describe, expect, it } from 'vitest';

import { evaluateRelationRequirements } from '../relation-requirements.js';
import { ArtifactRelationSchema } from '../schemas.js';
import type { ArtifactRelationRequirement } from '../kind-registration.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const implementsConcept1RevA = ArtifactRelationSchema.parse({
  type: 'implements',
  target: { refClass: 'artifact', kind: 'concept', id: 'concept-1', revision: 'rev-A' },
});

const implementsConcept1RevB = ArtifactRelationSchema.parse({
  type: 'implements',
  target: { refClass: 'artifact', kind: 'concept', id: 'concept-1', revision: 'rev-B' },
});

const implementsConcept2 = ArtifactRelationSchema.parse({
  type: 'implements',
  target: { refClass: 'artifact', kind: 'concept', id: 'concept-2', revision: 'rev-A' },
});

const aboutConcept3 = ArtifactRelationSchema.parse({
  type: 'about',
  target: { refClass: 'artifact', kind: 'concept', id: 'concept-3', revision: 'rev-A' },
});

const implementsDecision1 = ArtifactRelationSchema.parse({
  type: 'implements',
  target: { refClass: 'artifact', kind: 'decision', id: 'decision-1', revision: 'rev-A' },
});

const implementsEntity = ArtifactRelationSchema.parse({
  type: 'implements',
  target: { refClass: 'entity', entityType: 'workpiece', id: 'W-1' },
});

const implementsConcept4FromPart = ArtifactRelationSchema.parse({
  type: 'implements',
  sourceLocalId: 'q1',
  target: { refClass: 'artifact', kind: 'concept', id: 'concept-4', revision: 'rev-A' },
});

const requireOneConcept: ArtifactRelationRequirement = {
  relationType: 'implements',
  targetKinds: ['concept'],
  minItems: 1,
};

const requireAtMostOneConcept: ArtifactRelationRequirement = {
  relationType: 'implements',
  targetKinds: ['concept'],
  minItems: 0,
  maxItems: 1,
};

/**
 * Build a requirement of one concept target that applies only when `path` equals `equals`.
 * @param path - Data-relative path the condition reads.
 * @param equals - Scalar the value at `path` must strictly equal.
 * @returns The conditional requirement.
 */
function requireOneConceptWhen(path: string, equals: string | number | boolean): ArtifactRelationRequirement {
  return { ...requireOneConcept, when: { path, equals } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluateRelationRequirements', () => {
  it('returns no issues for undefined or empty requirements', () => {
    expect(evaluateRelationRequirements(undefined, [], undefined)).toEqual([]);
    expect(evaluateRelationRequirements([], [implementsConcept1RevA], {})).toEqual([]);
  });

  it('reports below-min-items with count 0 when an unconditional requirement has no matching relation', () => {
    expect(evaluateRelationRequirements([requireOneConcept], [], undefined)).toEqual([
      { index: 0, requirement: requireOneConcept, reason: 'below-min-items', count: 0 },
    ]);
  });

  it('counts relations to the same target with different revisions once', () => {
    expect(
      evaluateRelationRequirements(
        [requireAtMostOneConcept, requireOneConcept],
        [implementsConcept1RevA, implementsConcept1RevB],
        undefined,
      ),
    ).toEqual([]);
  });

  it('reports above-max-items with the distinct target count', () => {
    expect(
      evaluateRelationRequirements(
        [requireAtMostOneConcept],
        [implementsConcept1RevA, implementsConcept1RevB, implementsConcept2],
        undefined,
      ),
    ).toEqual([{ index: 0, requirement: requireAtMostOneConcept, reason: 'above-max-items', count: 2 }]);
  });

  it('does not count relations of another type, another target kind, non-artifact targets, or sub-part sources', () => {
    expect(
      evaluateRelationRequirements(
        [requireOneConcept],
        [aboutConcept3, implementsDecision1, implementsEntity, implementsConcept4FromPart],
        undefined,
      ),
    ).toEqual([{ index: 0, requirement: requireOneConcept, reason: 'below-min-items', count: 0 }]);
  });

  it('counts any artifact target kind when targetKinds is absent', () => {
    const requirement: ArtifactRelationRequirement = { relationType: 'implements', minItems: 0, maxItems: 1 };
    expect(
      evaluateRelationRequirements([requirement], [implementsConcept1RevA, implementsDecision1], undefined),
    ).toEqual([{ index: 0, requirement, reason: 'above-max-items', count: 2 }]);
  });

  it('reports no issue when the distinct target count equals both minItems and maxItems', () => {
    const requirement: ArtifactRelationRequirement = {
      relationType: 'implements',
      targetKinds: ['concept'],
      minItems: 2,
      maxItems: 2,
    };
    expect(
      evaluateRelationRequirements([requirement], [implementsConcept1RevA, implementsConcept2], undefined),
    ).toEqual([]);
  });

  it('counts the same id under two target kinds as two distinct targets when targetKinds is absent', () => {
    const implementsDecisionWithConceptId = ArtifactRelationSchema.parse({
      type: 'implements',
      target: { refClass: 'artifact', kind: 'decision', id: 'concept-1', revision: 'rev-A' },
    });
    const requirement: ArtifactRelationRequirement = { relationType: 'implements', minItems: 0, maxItems: 1 };
    expect(
      evaluateRelationRequirements([requirement], [implementsConcept1RevA, implementsDecisionWithConceptId], undefined),
    ).toEqual([{ index: 0, requirement, reason: 'above-max-items', count: 2 }]);
  });

  describe('when condition', () => {
    it('enforces the requirement when the value equals', () => {
      const requirement = requireOneConceptWhen('mode', 'strict');
      expect(evaluateRelationRequirements([requirement], [], { mode: 'strict' })).toEqual([
        { index: 0, requirement, reason: 'below-min-items', count: 0 },
      ]);
    });

    it('skips the requirement when the value is unequal', () => {
      expect(evaluateRelationRequirements([requireOneConceptWhen('mode', 'strict')], [], { mode: 'loose' })).toEqual(
        [],
      );
    });

    it('skips the requirement when the path is missing or data is undefined', () => {
      const requirement = requireOneConceptWhen('mode', 'strict');
      expect(evaluateRelationRequirements([requirement], [], { other: 'strict' })).toEqual([]);
      expect(evaluateRelationRequirements([requirement], [], undefined)).toEqual([]);
    });

    it('skips the requirement when the value is null', () => {
      expect(evaluateRelationRequirements([requireOneConceptWhen('mode', 'strict')], [], { mode: null })).toEqual([]);
    });

    it('resolves nested dot-separated paths', () => {
      const requirement = requireOneConceptWhen('a.b', 'x');
      expect(evaluateRelationRequirements([requirement], [], { a: { b: 'x' } })).toEqual([
        { index: 0, requirement, reason: 'below-min-items', count: 0 },
      ]);
      expect(evaluateRelationRequirements([requirement], [], { a: { b: 'y' } })).toEqual([]);
    });

    it('skips the requirement when the value is an object or array', () => {
      const requirement = requireOneConceptWhen('mode', 'strict');
      expect(evaluateRelationRequirements([requirement], [], { mode: { value: 'strict' } })).toEqual([]);
      expect(evaluateRelationRequirements([requirement], [], { mode: ['strict'] })).toEqual([]);
    });

    it('matches number and boolean equals values', () => {
      const numberRequirement = requireOneConceptWhen('level', 1);
      const booleanRequirement = requireOneConceptWhen('enabled', true);
      expect(
        evaluateRelationRequirements([numberRequirement, booleanRequirement], [], { level: 1, enabled: true }),
      ).toEqual([
        { index: 0, requirement: numberRequirement, reason: 'below-min-items', count: 0 },
        { index: 1, requirement: booleanRequirement, reason: 'below-min-items', count: 0 },
      ]);
      expect(
        evaluateRelationRequirements([numberRequirement, booleanRequirement], [], { level: 2, enabled: false }),
      ).toEqual([]);
    });

    it('does not treat a string and a number as equal', () => {
      expect(evaluateRelationRequirements([requireOneConceptWhen('level', 1)], [], { level: '1' })).toEqual([]);
      expect(evaluateRelationRequirements([requireOneConceptWhen('level', '1')], [], { level: 1 })).toEqual([]);
    });

    it('does not report a satisfied conditional requirement', () => {
      expect(
        evaluateRelationRequirements([requireOneConceptWhen('mode', 'strict')], [implementsConcept1RevA], {
          mode: 'strict',
        }),
      ).toEqual([]);
    });
  });

  it('reports issue indexes matching requirement positions', () => {
    const requireOneDecision: ArtifactRelationRequirement = {
      relationType: 'implements',
      targetKinds: ['decision'],
      minItems: 1,
    };
    const skipped = requireOneConceptWhen('mode', 'strict');
    expect(
      evaluateRelationRequirements(
        [requireAtMostOneConcept, skipped, requireOneConcept, requireOneDecision],
        [implementsConcept1RevA, implementsConcept2, implementsDecision1],
        { mode: 'loose' },
      ),
    ).toEqual([{ index: 0, requirement: requireAtMostOneConcept, reason: 'above-max-items', count: 2 }]);
    expect(
      evaluateRelationRequirements([requireOneConcept, skipped, requireOneDecision], [], { mode: 'strict' }),
    ).toEqual([
      { index: 0, requirement: requireOneConcept, reason: 'below-min-items', count: 0 },
      { index: 1, requirement: skipped, reason: 'below-min-items', count: 0 },
      { index: 2, requirement: requireOneDecision, reason: 'below-min-items', count: 0 },
    ]);
  });
});
