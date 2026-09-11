import { describe, expect, it } from 'vitest';

import { ArtifactRelationSchema } from '../schemas.js';
import { assessUniquenessSupport, buildUniquenessKeys, describeUniquenessKey } from '../uniqueness.js';
import type { ArtifactUniquenessRule } from '../kind-registration.js';
import type { UniquenessSelectorCapability } from '../uniqueness.js';

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

// 'data' is not in UniquenessSelectorCapability; the full derivable set is:
const allCapabilities: readonly UniquenessSelectorCapability[] = ['relation-target', 'lifecycle-states'];

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

  it('reports data capability even when supported contains all derivable capabilities (F22)', () => {
    // data-path selectors are never derivable from relations; DERIVABLE_SELECTOR_KINDS excludes them.
    // assessUniquenessSupport must report capability:'data' regardless of the supported set.
    const result = assessUniquenessSupport([dataRule], ['relation-target', 'lifecycle-states']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        ruleIndex: 0,
        selectorIndex: 0,
        capability: 'data',
      });
    }
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
    expect(keys[0].parts[0].target).not.toHaveProperty('revision');
  });

  it('carries ruleIndex on the derived key', () => {
    const { keys } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA]);
    expect(keys[0].ruleIndex).toBe(0);
  });

  it('produces one key when two relations of the same type point to the same artifact with different revisions', () => {
    const { keys, issues } = buildUniquenessKeys([relationTargetRule], [aboutArtifact1RevA, aboutArtifact1RevB]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].parts[0].target).toEqual({
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

  it('produces an unsupported-selector issue for a data selector', () => {
    const { keys, issues } = buildUniquenessKeys([dataRule], [aboutArtifact1RevA]);
    expect(keys).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleIndex: 0,
      selectorIndex: 0,
      reason: 'unsupported-selector',
    });
    expect(issues[0].relationType).toBeUndefined();
  });

  it('produces parts in declaration order for a two-selector rule', () => {
    const { keys, issues } = buildUniquenessKeys([twoSelectorRule], [aboutArtifact1RevA, ownedByEntity]);
    expect(issues).toHaveLength(0);
    expect(keys).toHaveLength(1);
    expect(keys[0].parts[0].type).toBe('about');
    expect(keys[0].parts[1].type).toBe('owned-by');
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

  it('reports unsupported-selector for a data rule regardless of what assessUniquenessSupport receives (F22)', () => {
    // Both functions must agree: data selectors are never derivable.
    const { keys, issues } = buildUniquenessKeys([dataRule], []);
    expect(keys).toHaveLength(0);
    expect(issues[0]).toMatchObject({ reason: 'unsupported-selector', ruleIndex: 0, selectorIndex: 0 });
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
