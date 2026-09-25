import { describe, expect, it } from 'vitest';

import { ArtifactRelationSchema } from '../schemas.js';
import { assessUniquenessSupport, buildUniquenessKeys, describeUniquenessKey } from '../uniqueness.js';
import { serializeArtifactRelationTargetIdentity } from '../relation-target-identity.js';
import type { ArtifactUniquenessRule } from '../kind-registration.js';
import type {
  UniquenessKeyPart,
  UniquenessRelationTargetKeyPart,
  UniquenessSelectorCapability,
} from '../uniqueness.js';

/**
 * Narrow a {@link UniquenessKeyPart} to its `relation-target` variant for
 * tests that assert on `.type`/`.target`.
 * @param part - A resolved key part expected to be a relation-target part.
 * @returns The part narrowed to {@link UniquenessRelationTargetKeyPart}.
 */
function asRelationTargetPart(part: UniquenessKeyPart): UniquenessRelationTargetKeyPart {
  if (!('target' in part)) throw new Error('expected a relation-target key part');
  return part;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const relationTargetRule: ArtifactUniquenessRule = {
  by: [{ kind: 'relation-target', relationType: 'about' }],
};

const dataRule: ArtifactUniquenessRule = {
  by: [{ kind: 'data', path: 'slug' }],
};

const mixedRule: ArtifactUniquenessRule = {
  by: [
    { kind: 'relation-target', relationType: 'about' },
    { kind: 'data', path: 'slug' },
  ],
};

const lifecycleRule: ArtifactUniquenessRule = {
  by: [{ kind: 'relation-target', relationType: 'about' }],
  lifecycleStates: ['valid'],
};

const twoSelectorRule: ArtifactUniquenessRule = {
  by: [
    { kind: 'relation-target', relationType: 'about' },
    { kind: 'relation-target', relationType: 'owned-by' },
  ],
};

const aboutArtifact1RevA = ArtifactRelationSchema.parse({
  type: 'about',
  target: {
    refClass: 'artifact',
    kind: 'concept',
    id: 'artifact-1',
    revision: 'rev-A',
  },
});

const aboutArtifact1RevB = ArtifactRelationSchema.parse({
  type: 'about',
  target: {
    refClass: 'artifact',
    kind: 'concept',
    id: 'artifact-1',
    revision: 'rev-B',
  },
});

const aboutArtifact2 = ArtifactRelationSchema.parse({
  type: 'about',
  target: {
    refClass: 'artifact',
    kind: 'concept',
    id: 'artifact-2',
    revision: 'rev-A',
  },
});

const aboutArtifact1FromQ2 = ArtifactRelationSchema.parse({
  type: 'about',
  sourceLocalId: 'q2',
  target: {
    refClass: 'artifact',
    kind: 'concept',
    id: 'artifact-1',
    revision: 'rev-A',
  },
});

const aboutArtifact1FromQ3 = ArtifactRelationSchema.parse({ ...aboutArtifact1FromQ2, sourceLocalId: 'q3' });

const aboutArtifact2FromQ3 = ArtifactRelationSchema.parse({
  type: 'about',
  sourceLocalId: 'q3',
  target: {
    refClass: 'artifact',
    kind: 'concept',
    id: 'artifact-2',
    revision: 'rev-A',
  },
});

const ownedByEntity = ArtifactRelationSchema.parse({
  type: 'owned-by',
  target: { refClass: 'entity', entityType: 'workpiece', id: 'W-1' },
});

const aboutLocal = ArtifactRelationSchema.parse({
  type: 'about',
  target: {
    refClass: 'local',
    artifact: {
      refClass: 'artifact',
      kind: 'concept',
      id: 'artifact-1',
      revision: 'rev-A',
    },
    localId: 'section-1',
  },
});

const aboutEvidence = ArtifactRelationSchema.parse({
  type: 'about',
  target: {
    refClass: 'evidence',
    kind: 'commit',
    id: 'abc123',
    revision: 'abc123',
  },
});

const allCapabilities: readonly UniquenessSelectorCapability[] = ['relation-target', 'data', 'lifecycle-states'];

const dataWithSlug = { slug: 'my-slug' };

// ── assessUniquenessSupport ───────────────────────────────────────────────────

describe('assessUniquenessSupport', () => {
  it('returns ok with empty array when rules is undefined', () => {
    const result = assessUniquenessSupport(undefined, []);
    expect(result).toEqual({ ok: true, rules: [] });
  });

  it('returns ok with empty array when rules is empty', () => {
    const result = assessUniquenessSupport([], ['relation-target']);
    expect(result).toEqual({ ok: true, rules: [] });
  });

  it('returns ok when a relation-target rule is fully supported', () => {
    const result = assessUniquenessSupport([relationTargetRule], ['relation-target']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(1);
    }
  });

  it('reports issue with selectorIndex for a data selector when data is not supported', () => {
    const result = assessUniquenessSupport([dataRule], ['relation-target']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        ruleIndex: 0,
        selectorIndex: 0,
        capability: 'data',
      });
      expect(result.issues[0]).toHaveProperty('selectorIndex');
    }
  });

  it('reports issue without selectorIndex for lifecycleStates when not supported', () => {
    const result = assessUniquenessSupport([lifecycleRule], ['relation-target']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const lcIssue = result.issues.find((i) => i.capability === 'lifecycle-states');
      expect(lcIssue).toBeDefined();
      expect(lcIssue).not.toHaveProperty('selectorIndex');
    }
  });

  it('returns ok with the same rules array reference (no defensive copy)', () => {
    const rules = [relationTargetRule];
    const result = assessUniquenessSupport(rules, allCapabilities);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toBe(rules);
    }
  });

  it('returns ok when all capabilities are supported including lifecycleStates', () => {
    const result = assessUniquenessSupport([lifecycleRule], allCapabilities);
    expect(result.ok).toBe(true);
  });

  it('reports issues for both selector and lifecycleStates when neither is supported', () => {
    const result = assessUniquenessSupport([mixedRule], []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const capabilityNames = result.issues.map((i) => i.capability);
      expect(capabilityNames).toContain('data');
      expect(capabilityNames).toContain('relation-target');
    }
  });

  it('returns ok for a data rule when the data capability is declared supported (FACT-141)', () => {
    const result = assessUniquenessSupport([dataRule], ['data']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(1);
    }
  });

  it('returns ok for a mixed rule when both relation-target and data are supported (FACT-141)', () => {
    const result = assessUniquenessSupport([mixedRule], ['relation-target', 'data']);
    expect(result.ok).toBe(true);
  });
});

// ── buildUniquenessKeys ───────────────────────────────────────────────────────

describe('buildUniquenessKeys', () => {
  it('produces one key with one part for a single relation-target rule', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].parts).toHaveLength(1);
    expect(keys[0].parts[0]).toEqual({
      type: 'about',
      target: { refClass: 'artifact', kind: 'concept', id: 'artifact-1' },
    });
  });

  it('does not include revision pin in the part target', () => {
    const { keys } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    expect(asRelationTargetPart(keys[0].parts[0]).target).not.toHaveProperty('revision');
  });

  it('carries ruleIndex on the derived key', () => {
    const { keys } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    expect(keys[0].ruleIndex).toBe(0);
  });

  it('produces one key when two relations of the same type point to the same artifact with different revisions', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA, aboutArtifact1RevB]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(asRelationTargetPart(keys[0].parts[0]).target).toEqual({
      refClass: 'artifact',
      kind: 'concept',
      id: 'artifact-1',
    });
  });

  it('produces an ambiguous-target issue when two relations point to different artifacts', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA, aboutArtifact2]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleIndex: 0,
      selectorIndex: 0,
      reason: 'ambiguous-target',
      relationType: 'about',
    });
  });

  it('produces a missing-target issue when no relation of the type exists', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [ownedByEntity]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleIndex: 0,
      selectorIndex: 0,
      reason: 'missing-target',
      relationType: 'about',
    });
  });

  it('produces a missing-target issue when the only matching relation is sourced from a local part', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1FromQ2]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      reason: 'missing-target',
      relationType: 'about',
    });
  });

  it('derives the whole-artifact relation target when a local-source relation has a different target', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA, aboutArtifact2FromQ3]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(asRelationTargetPart(keys[0].parts[0]).target).toEqual({
      refClass: 'artifact',
      kind: 'concept',
      id: 'artifact-1',
    });
  });

  it('does not derive a whole-artifact key from local-source relations with the same target', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1FromQ2, aboutArtifact1FromQ3]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      reason: 'missing-target',
      relationType: 'about',
    });
  });

  it('produces an unsupported-target issue for a local target', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutLocal]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      reason: 'unsupported-target',
      relationType: 'about',
    });
  });

  it('produces an unsupported-target issue for an evidence target', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutEvidence]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      reason: 'unsupported-target',
      relationType: 'about',
    });
  });

  it('produces parts in declaration order for a two-selector rule', () => {
    const { keys, issues } = buildUniquenessKeys([twoSelectorRule], [aboutArtifact1RevA, ownedByEntity]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(asRelationTargetPart(keys[0].parts[0]).type).toBe('about');
    expect(asRelationTargetPart(keys[0].parts[1]).type).toBe('owned-by');
  });

  // ── data selectors (FACT-141) ─────────────────────────────────────────────

  it('produces one key with one data part for a single data rule', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [], dataWithSlug);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].parts).toEqual([{ path: 'slug', value: 'my-slug' }]);
  });

  it('resolves a nested dot-separated data path', () => {
    const nestedRule: ArtifactUniquenessRule = { by: [{ kind: 'data', path: 'meta.slug' }] };
    const { keys, issues } = buildUniquenessKeys([nestedRule], [], { meta: { slug: 'nested-slug' } });
    expect(issues).toHaveLength(0);
    expect(keys[0].parts).toEqual([{ path: 'meta.slug', value: 'nested-slug' }]);
  });

  it('accepts number and boolean scalar values', () => {
    const numberRule: ArtifactUniquenessRule = { by: [{ kind: 'data', path: 'count' }] };
    const { keys: numberKeys, issues: numberIssues } = buildUniquenessKeys([numberRule], [], { count: 42 });
    expect(numberIssues).toHaveLength(0);
    expect(numberKeys[0].parts).toEqual([{ path: 'count', value: 42 }]);

    const boolRule: ArtifactUniquenessRule = { by: [{ kind: 'data', path: 'active' }] };
    const { keys: boolKeys, issues: boolIssues } = buildUniquenessKeys([boolRule], [], { active: false });
    expect(boolIssues).toHaveLength(0);
    expect(boolKeys[0].parts).toEqual([{ path: 'active', value: false }]);
  });

  it('produces a mixed key composing a relation-target part and a data part in declaration order', () => {
    const { keys, issues } = buildUniquenessKeys([mixedRule], [aboutArtifact1RevA], dataWithSlug);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].parts).toEqual([
      { type: 'about', target: { refClass: 'artifact', kind: 'concept', id: 'artifact-1' } },
      { path: 'slug', value: 'my-slug' },
    ]);
  });

  it('produces a missing-value issue when no artifact data is supplied at all', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], []);
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ ruleIndex: 0, selectorIndex: 0, reason: 'missing-value', dataPath: 'slug' });
  });

  it('produces a missing-value issue when the data path is absent from the supplied data', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [], {});
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ reason: 'missing-value', dataPath: 'slug' });
  });

  it('produces a missing-value issue when the data path resolves to null', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [], { slug: null });
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ reason: 'missing-value', dataPath: 'slug' });
  });

  it('produces an unsupported-value-type issue when the data path resolves to an object', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [], { slug: { nested: true } });
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ reason: 'unsupported-value-type', dataPath: 'slug' });
  });

  it('produces an unsupported-value-type issue when the data path resolves to an array', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [], { slug: ['a'] });
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ reason: 'unsupported-value-type', dataPath: 'slug' });
  });

  it('compares data values by exact equality: different casing produces different serialized keys', () => {
    const { keys: keysUpper } = buildUniquenessKeys([dataRule], [], { slug: 'A' });
    const { keys: keysLower } = buildUniquenessKeys([dataRule], [], { slug: 'a' });
    expect(keysUpper[0].serialized).not.toBe(keysLower[0].serialized);
  });

  it('produces equal serialized values for an identical data value', () => {
    const { keys: keys1 } = buildUniquenessKeys([dataRule], [], { slug: 'same' });
    const { keys: keys2 } = buildUniquenessKeys([dataRule], [], { slug: 'same' });
    expect(keys1[0].serialized).toBe(keys2[0].serialized);
  });

  it('describeUniquenessKey renders a data part as path → JSON-quoted value', () => {
    const { keys } = buildUniquenessKeys([dataRule], [], dataWithSlug);
    expect(describeUniquenessKey(keys[0])).toBe('slug → "my-slug"');
  });

  it('produces equal serialized values for identical parts regardless of input key order', () => {
    // Both revisions point to the same artifact; serialized should be identical.
    const { keys: keysRevA } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    const { keys: keysRevB } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevB]);
    expect(keysRevA[0].serialized).toBe(keysRevB[0].serialized);
  });

  it('produces different serialized values for different targets', () => {
    const { keys: keysA } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    const { keys: keysB } = buildUniquenessKeys([relationTargetRule], [aboutArtifact2]);
    expect(keysA[0].serialized).not.toBe(keysB[0].serialized);
  });

  it('serialized never collides between a data part and a relation-target part with the same effective payload', () => {
    // A `data` selector at path 'about' whose value happens to equal the
    // serialized identity of a `relation-target` selector's resolved target
    // must not produce the same `serialized` string as that relation-target
    // key — the branch tag in serializeUniquenessKeyPart guards this.
    const collidingValue = serializeArtifactRelationTargetIdentity({
      refClass: 'artifact',
      kind: 'concept',
      id: 'artifact-1',
    });
    const collidingDataRule: ArtifactUniquenessRule = { by: [{ kind: 'data', path: 'about' }] };
    const { keys: dataKeys } = buildUniquenessKeys([collidingDataRule], [], { about: collidingValue });
    const { keys: relationKeys } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    expect(dataKeys[0].serialized).not.toBe(relationKeys[0].serialized);
  });

  it('keys carry ruleIndex matching rule position even when an earlier rule produced only issues (F22)', () => {
    // rule 0 (dataRule) → issue; rule 1 (relationTargetRule) → key with ruleIndex 1
    const { keys, issues } = buildUniquenessKeys([dataRule, relationTargetRule], [aboutArtifact1RevA]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleIndex).toBe(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].ruleIndex).toBe(1);
  });

  it('serialized is injective: differs for parts whose type and target id are swapped', () => {
    // part A: type='aaa', target.id='bbb'
    // part B: type='bbb', target.id='aaa'
    // serialized encodes [type, serializeIdentity(target)] per part, so swapping must produce a different string.
    const relAaa = ArtifactRelationSchema.parse({
      type: 'aaa',
      target: { refClass: 'artifact', kind: 'concept', id: 'bbb', revision: 'rev-1' },
    });
    const relBbb = ArtifactRelationSchema.parse({
      type: 'bbb',
      target: { refClass: 'artifact', kind: 'concept', id: 'aaa', revision: 'rev-1' },
    });
    const ruleAaa: ArtifactUniquenessRule = { by: [{ kind: 'relation-target', relationType: 'aaa' }] };
    const ruleBbb: ArtifactUniquenessRule = { by: [{ kind: 'relation-target', relationType: 'bbb' }] };
    const { keys: keysA } = buildUniquenessKeys([ruleAaa], [relAaa]);
    const { keys: keysB } = buildUniquenessKeys([ruleBbb], [relBbb]);
    expect(keysA[0].serialized).not.toBe(keysB[0].serialized);
  });

  it('describeUniquenessKey returns human-readable form for an artifact target', () => {
    const { keys } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    const description = describeUniquenessKey(keys[0]);
    expect(description).toBe('about → artifact:concept/artifact-1');
  });

  it('describeUniquenessKey returns human-readable form for an entity target', () => {
    const ownedByRule: ArtifactUniquenessRule = {
      by: [{ kind: 'relation-target', relationType: 'owned-by' }],
    };
    const { keys } = buildUniquenessKeys([ownedByRule], [ownedByEntity]);
    const description = describeUniquenessKey(keys[0]);
    expect(description).toBe('owned-by → entity:workpiece/W-1');
  });

  it('describeUniquenessKey joins multiple parts with semicolons', () => {
    const { keys } = buildUniquenessKeys([twoSelectorRule], [aboutArtifact1RevA, ownedByEntity]);
    const description = describeUniquenessKey(keys[0]);
    expect(description).toContain(';');
    expect(description).toContain('about →');
    expect(description).toContain('owned-by →');
  });

  it('returns all issues when one rule has two unresolvable selectors (no key produced)', () => {
    // Both selectors have no matching relation — each produces a missing-target
    // issue. Only the first was historically pushed; this test pins the fix that
    // collects all issues per rule, consistent with assessUniquenessSupport.
    const twoUnresolvableRule: ArtifactUniquenessRule = {
      by: [
        { kind: 'relation-target', relationType: 'about' },
        { kind: 'relation-target', relationType: 'owned-by' },
      ],
    };
    const { keys, issues } = buildUniquenessKeys([twoUnresolvableRule], []);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      ruleIndex: 0,
      selectorIndex: 0,
      reason: 'missing-target',
      relationType: 'about',
    });
    expect(issues[1]).toMatchObject({
      ruleIndex: 0,
      selectorIndex: 1,
      reason: 'missing-target',
      relationType: 'owned-by',
    });
  });
});
