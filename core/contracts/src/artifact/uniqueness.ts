import type { ArtifactUniquenessRule } from './kind-registration.js';
import type { ArtifactRelation } from './schemas.js';
import { artifactRelationTargetIdentity, type ArtifactRelationTargetIdentity } from './relation-target-identity.js';

/**
 * What a store can derive and enforce; declared rules outside this set are
 * reported as issues rather than silently dropped.
 */
export type UniquenessSelectorCapability = 'relation-target' | 'data' | 'lifecycle-states';

/** Per-rule or per-selector issue surfaced when a capability is missing. */
export interface UniquenessSupportIssue {
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /**
   * Zero-based index of the selector within `rule.by`.
   * Absent when the issue concerns `lifecycleStates` rather than a selector.
   */
  selectorIndex?: number;
  /** The missing capability. */
  capability: UniquenessSelectorCapability;
  /** Human-readable explanation. */
  message: string;
}

/**
 * Split declared rules into enforceable rules and issues, given a store's
 * capabilities. A rule is enforceable when every selector kind and, if
 * declared, `lifecycleStates` are supported.
 * Undefined or empty rules yield `{ ok: true, rules: [] }`.
 * @param rules - Declared uniqueness rules from the kind registration.
 * @param supported - Capability set the calling store can enforce.
 * @returns Either an ok result with the rules array or a list of issues.
 */
export function assessUniquenessSupport(
  rules: readonly ArtifactUniquenessRule[] | undefined,
  supported: readonly UniquenessSelectorCapability[],
): { ok: true; rules: ArtifactUniquenessRule[] } | { ok: false; issues: UniquenessSupportIssue[] } {
  if (!rules || rules.length === 0) return { ok: true, rules: [] };

  const issues: UniquenessSupportIssue[] = [];

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];

    for (let selectorIndex = 0; selectorIndex < rule.by.length; selectorIndex++) {
      const selector = rule.by[selectorIndex];
      if (!supported.includes(selector.kind)) {
        issues.push({
          ruleIndex,
          selectorIndex,
          capability: selector.kind,
          message:
            `rule #${ruleIndex}, selector #${selectorIndex}:` + ` '${selector.kind}' selectors are not supported`,
        });
      }
    }

    if (rule.lifecycleStates !== undefined && !supported.includes('lifecycle-states')) {
      issues.push({
        ruleIndex,
        capability: 'lifecycle-states',
        message:
          `rule #${ruleIndex}: lifecycleStates is declared but` + ` 'lifecycle-states' is not a supported capability`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rules: [...rules] };
}

/**
 * One selector's contribution: the relation type and the pin-less identity it
 * points at.
 */
export interface UniquenessKeyPart {
  /** Relation type matching the selector's `relationType`. */
  relationType: string;
  /** Pin-less comparable identity of the resolved target. */
  target: ArtifactRelationTargetIdentity;
}

/** A fully resolved uniqueness key derived from an artifact's relations. */
export interface UniquenessKey {
  /** The rule this key was derived from, in its original declared form. */
  rule: ArtifactUniquenessRule;
  /**
   * One part per selector, in declaration order; the containment probe a store
   * can run.
   */
  parts: UniquenessKeyPart[];
  /** Injective string form for equality and logging (stable key order). */
  serialized: string;
}

/** Reason a key could not be derived for a selector. */
export type UniquenessKeyIssueReason =
  | 'missing-target'
  | 'ambiguous-target'
  | 'unsupported-target'
  | 'unsupported-selector';

/** Diagnostic for a single selector within a rule that blocked key derivation. */
export interface UniquenessKeyIssue {
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /** Zero-based index of the failing selector within `rule.by`. */
  selectorIndex: number;
  /** Why derivation failed. */
  reason: UniquenessKeyIssueReason;
  /**
   * Relation type string for `relation-target` selectors.
   * Absent for `unsupported-selector` issues on `data` selectors.
   */
  relationType?: string;
  /** Human-readable explanation. */
  message: string;
}

/** Combined result of {@link buildUniquenessKeys}. */
export interface BuildUniquenessKeysResult {
  /** Derived keys, one per fully resolved rule. */
  keys: UniquenessKey[];
  /** Selector-level issues for rules that could not be fully resolved. */
  issues: UniquenessKeyIssue[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Injective serialization of an identity for deduplication within a selector.
 * Uses a JSON array to avoid `a:b`/`c` vs `a`/`b:c`-style collisions.
 * @param identity - The pin-less identity to serialize.
 * @returns A JSON string that uniquely identifies this target.
 */
function serializeIdentityForDedup(identity: ArtifactRelationTargetIdentity): string {
  if (identity.refClass === 'artifact') {
    return JSON.stringify(['artifact', identity.kind, identity.id]);
  }
  return JSON.stringify(['entity', identity.entityType, identity.id]);
}

/**
 * Stable serialization of a single key part. Object keys are inserted in
 * alphabetical order so JSON.stringify produces a deterministic result
 * regardless of target field insertion order.
 * @param part - The key part to serialize.
 * @returns A plain object suitable for JSON.stringify with stable key order.
 */
function stableSerializePart(part: UniquenessKeyPart): unknown {
  const { relationType, target } = part;
  // Keys in alphabetical order for deterministic output.
  const serializedTarget: Record<string, string> =
    target.refClass === 'artifact'
      ? { id: target.id, kind: target.kind, refClass: 'artifact' }
      : { entityType: target.entityType, id: target.id, refClass: 'entity' };
  // 'relationType' < 'target' alphabetically.
  return { relationType, target: serializedTarget };
}

/**
 * Produce the `serialized` field for a fully built set of parts.
 * @param parts - The parts to serialize.
 * @returns A stable JSON string representing all parts.
 */
function stableSerializeParts(parts: readonly UniquenessKeyPart[]): string {
  return JSON.stringify(parts.map(stableSerializePart));
}

/**
 * Human-readable identity description used in {@link describeUniquenessKey}.
 * @param target - The pin-less identity to describe.
 * @returns A short string in `refClass:discriminant/id` form.
 */
function describeTargetIdentity(target: ArtifactRelationTargetIdentity): string {
  if (target.refClass === 'artifact') {
    return `artifact:${target.kind}/${target.id}`;
  }
  return `entity:${target.entityType}/${target.id}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive one key per rule from an artifact's relations.
 * Rules with any issue produce no key; keys and issues are returned together.
 * @param rules - Declared uniqueness rules to derive keys for.
 * @param relations - Full relation list of the artifact being written.
 * @returns Combined set of derived keys and selector-level issues.
 */
export function buildUniquenessKeys(
  rules: readonly ArtifactUniquenessRule[],
  relations: readonly ArtifactRelation[],
): BuildUniquenessKeysResult {
  const keys: UniquenessKey[] = [];
  const issues: UniquenessKeyIssue[] = [];

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    const parts: UniquenessKeyPart[] = [];
    let ruleHasIssue = false;

    for (let selectorIndex = 0; selectorIndex < rule.by.length; selectorIndex++) {
      const selector = rule.by[selectorIndex];

      if (selector.kind === 'data') {
        issues.push({
          ruleIndex,
          selectorIndex,
          reason: 'unsupported-selector',
          message:
            `rule #${ruleIndex}, selector #${selectorIndex}:` + ` data-path selectors cannot be derived from relations`,
        });
        ruleHasIssue = true;
        break;
      }

      const { relationType } = selector;
      const matching = relations.filter((rel) => rel.type === relationType);

      // Single pass: detect unsupported ref-classes, collect distinct identities.
      const seen = new Map<string, ArtifactRelationTargetIdentity>();
      let unsupportedRefClass: string | undefined;

      for (const rel of matching) {
        const identity = artifactRelationTargetIdentity(rel.target);
        if (identity === undefined) {
          unsupportedRefClass = rel.target.refClass;
          break;
        }
        seen.set(serializeIdentityForDedup(identity), identity);
      }

      if (unsupportedRefClass !== undefined) {
        issues.push({
          ruleIndex,
          selectorIndex,
          reason: 'unsupported-target',
          relationType,
          message:
            `rule #${ruleIndex}, selector #${selectorIndex},` +
            ` relation '${relationType}': found a relation with` +
            ` refClass '${unsupportedRefClass}';` +
            ` only artifact and entity targets are supported`,
        });
        ruleHasIssue = true;
        break;
      }

      if (seen.size === 0) {
        issues.push({
          ruleIndex,
          selectorIndex,
          reason: 'missing-target',
          relationType,
          message:
            `rule #${ruleIndex}, selector #${selectorIndex},` +
            ` relation '${relationType}': no relations of this type found`,
        });
        ruleHasIssue = true;
        break;
      }

      if (seen.size > 1) {
        issues.push({
          ruleIndex,
          selectorIndex,
          reason: 'ambiguous-target',
          relationType,
          message:
            `rule #${ruleIndex}, selector #${selectorIndex},` +
            ` relation '${relationType}': ${seen.size} distinct targets;` +
            ` expected exactly one`,
        });
        ruleHasIssue = true;
        break;
      }

      // seen.size === 1 guaranteed here; iterate to extract the single value.
      for (const identity of seen.values()) {
        parts.push({ relationType, target: identity });
      }
    }

    if (!ruleHasIssue) {
      keys.push({ rule, parts, serialized: stableSerializeParts(parts) });
    }
  }

  return { keys, issues };
}

/**
 * Human-readable one-liner for a key.
 * @example `about → artifact:concept/abc`
 * @example `owned-by → entity:workpiece/W-1; about → artifact:concept/abc`
 * @param key - A fully resolved uniqueness key.
 * @returns A string describing each part in `relationType → identity` form.
 */
export function describeUniquenessKey(key: UniquenessKey): string {
  if (key.parts.length === 0) {
    return `(empty key for rule with ${key.rule.by.length} selector(s))`;
  }
  return key.parts.map((part) => `${part.relationType} → ${describeTargetIdentity(part.target)}`).join('; ');
}
