import type { ArtifactUniquenessRule } from './kind-registration.js';
import type { ArtifactRelation } from './schemas.js';
import {
  artifactRelationTargetIdentity,
  describeArtifactRelationTargetIdentity,
  serializeArtifactRelationTargetIdentity,
  type ArtifactRelationTargetIdentity,
} from './relation-target-identity.js';

/**
 * Selector kinds that {@link buildUniquenessKeys} can derive from artifact
 * relations. Data-path selectors are excluded: FACT-141 owns that derivation
 * path.
 */
const DERIVABLE_SELECTOR_KINDS: readonly ArtifactUniquenessRule['by'][number]['kind'][] = ['relation-target'];

/**
 * What a store can derive and enforce; declared rules outside this set are
 * reported as issues rather than silently dropped.
 */
export type UniquenessSelectorCapability = 'relation-target' | 'lifecycle-states';

/** Per-rule or per-selector issue surfaced when a capability is missing. */
export interface UniquenessSupportIssue {
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /**
   * Zero-based index of the selector within `rule.by`.
   * Absent when the issue concerns `lifecycleStates` rather than a selector.
   */
  selectorIndex?: number;
  /**
   * The missing capability.
   * May be `'data'` even though it is not in {@link UniquenessSelectorCapability},
   * because a data-path selector is always undeivable regardless of what the
   * store declares.
   */
  capability: ArtifactUniquenessRule['by'][number]['kind'] | 'lifecycle-states';
  /** Human-readable explanation. */
  message: string;
}

/**
 * Split declared rules into enforceable rules and issues, given a store's
 * capabilities. A rule is enforceable when every selector kind and, if
 * declared, `lifecycleStates` are supported.
 * A selector is reported as unsupported when its kind is not in
 * {@link DERIVABLE_SELECTOR_KINDS} or not in `supported`.
 * Undefined or empty rules yield `{ ok: true, rules: [] }`.
 * @param rules - Declared uniqueness rules from the kind registration.
 * @param supported - Capability set the calling store can enforce.
 * @returns Either an ok result with the rules array or a list of issues.
 */
export function assessUniquenessSupport(
  rules: readonly ArtifactUniquenessRule[] | undefined,
  supported: readonly UniquenessSelectorCapability[],
): { ok: true; rules: readonly ArtifactUniquenessRule[] } | { ok: false; issues: UniquenessSupportIssue[] } {
  if (!rules || rules.length === 0) return { ok: true, rules: [] };

  const issues: UniquenessSupportIssue[] = [];

  for (const [ruleIndex, rule] of rules.entries()) {
    for (const [selectorIndex, selector] of rule.by.entries()) {
      if (
        !DERIVABLE_SELECTOR_KINDS.includes(selector.kind) ||
        !(supported as readonly string[]).includes(selector.kind)
      ) {
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
  return { ok: true, rules };
}

/**
 * One selector's contribution to a uniqueness key.
 * A part is structurally a `Partial<ArtifactRelation>` and can be used
 * directly as a jsonb containment probe against the `relations_json` column:
 * `relations_json @> '[{"type":"...","target":{...}}]'::jsonb`.
 */
export interface UniquenessKeyPart {
  /** Relation type matching the selector's `relationType`. */
  type: string;
  /** Pin-less comparable identity of the resolved target. */
  target: ArtifactRelationTargetIdentity;
}

/** A fully resolved uniqueness key derived from an artifact's relations. */
export interface UniquenessKey {
  /** The rule this key was derived from, in its original declared form. */
  rule: ArtifactUniquenessRule;
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /**
   * One part per selector, in declaration order; the containment probe a store
   * can run against a stored relations array.
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
 * Attempt to derive a single key part from a selector and the artifact's
 * relations. Returns the part on success, or an issue on failure.
 * @param selector - One entry from `rule.by` to evaluate.
 * @param relations - Full relation list of the artifact being written.
 * @param ruleIndex - Zero-based index of the enclosing rule.
 * @param selectorIndex - Zero-based index of this selector within `rule.by`.
 * @returns A resolved {@link UniquenessKeyPart} or a {@link UniquenessKeyIssue}.
 */
function deriveSelectorPart(
  selector: ArtifactUniquenessRule['by'][number],
  relations: readonly ArtifactRelation[],
  ruleIndex: number,
  selectorIndex: number,
): UniquenessKeyPart | UniquenessKeyIssue {
  if (selector.kind === 'data') {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'unsupported-selector',
      message: `rule #${ruleIndex}, selector #${selectorIndex}: data-path selectors cannot be derived from relations`,
    };
  }
  const { relationType } = selector;
  const matching = relations.filter((r) => r.type === relationType);
  const seen = new Set<string>();
  let single: ArtifactRelationTargetIdentity | undefined;
  let unsupportedRefClass: string | undefined;
  for (const rel of matching) {
    const identity = artifactRelationTargetIdentity(rel.target);
    if (identity === undefined) {
      unsupportedRefClass = rel.target.refClass;
      break;
    }
    seen.add(serializeArtifactRelationTargetIdentity(identity));
    single = identity;
  }
  if (unsupportedRefClass !== undefined) {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'unsupported-target',
      relationType,
      message:
        `rule #${ruleIndex}, selector #${selectorIndex},` +
        ` relation '${relationType}': found a relation with` +
        ` refClass '${unsupportedRefClass}'; only artifact and entity targets are supported`,
    };
  }
  if (single === undefined) {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'missing-target',
      relationType,
      message:
        `rule #${ruleIndex}, selector #${selectorIndex},` +
        ` relation '${relationType}': no relations of this type found`,
    };
  }
  if (seen.size > 1) {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'ambiguous-target',
      relationType,
      message:
        `rule #${ruleIndex}, selector #${selectorIndex},` +
        ` relation '${relationType}': ${seen.size} distinct targets; expected exactly one`,
    };
  }
  return { type: relationType, target: single };
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

  for (const [ruleIndex, rule] of rules.entries()) {
    const derivations = rule.by.map((selector, selectorIndex) =>
      deriveSelectorPart(selector, relations, ruleIndex, selectorIndex),
    );
    const firstIssue = derivations.find((d): d is UniquenessKeyIssue => 'reason' in d);
    if (firstIssue !== undefined) {
      issues.push(firstIssue);
      continue;
    }
    const parts = derivations.filter((d): d is UniquenessKeyPart => !('reason' in d));
    const serialized = JSON.stringify(parts.map((p) => [p.type, serializeArtifactRelationTargetIdentity(p.target)]));
    keys.push({ rule, ruleIndex, parts, serialized });
  }

  return { keys, issues };
}

/**
 * Human-readable one-liner for a key.
 * @example `about → artifact:concept/abc`
 * @example `owned-by → entity:workpiece/W-1; about → artifact:concept/abc`
 * @param key - A fully resolved uniqueness key.
 * @returns A string describing each part in `type → identity` form, joined by `'; '`.
 */
export function describeUniquenessKey(key: UniquenessKey): string {
  return key.parts.map((part) => `${part.type} → ${describeArtifactRelationTargetIdentity(part.target)}`).join('; ');
}
