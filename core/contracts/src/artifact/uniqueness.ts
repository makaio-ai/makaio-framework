import type { ArtifactUniquenessRule } from './kind-registration.js';
import type { ArtifactRelation } from './schemas.js';
import {
  artifactRelationTargetIdentity,
  describeArtifactRelationTargetIdentity,
  serializeArtifactRelationTargetIdentity,
  type ArtifactRelationTargetIdentity,
} from './relation-target-identity.js';

/**
 * Selector kinds that {@link buildUniquenessKeys} can derive: `relation-target`
 * selectors from the artifact's relations, `data` selectors from the artifact
 * data being written (FACT-141).
 */
const DERIVABLE_SELECTOR_KINDS: readonly ArtifactUniquenessRule['by'][number]['kind'][] = ['relation-target', 'data'];

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
 * A `relation-target` selector's contribution to a uniqueness key.
 * Structurally a `Partial<ArtifactRelation>` and can be used directly as a
 * jsonb containment probe against the `relations_json` column:
 * `relations_json @> '[{"type":"...","target":{...}}]'::jsonb`. Carries no
 * discriminant field so this probe shape stays stable.
 */
export interface UniquenessRelationTargetKeyPart {
  /** Relation type matching the selector's `relationType`. */
  type: string;
  /** Pin-less comparable identity of the resolved target. */
  target: ArtifactRelationTargetIdentity;
}

/**
 * A `data` selector's contribution to a uniqueness key (FACT-141): the exact
 * scalar value read from the artifact data at the selector's declared path.
 * No normalization or case folding is applied; comparison is exact equality.
 */
export interface UniquenessDataKeyPart {
  /** Data-relative object-property path matching the selector's `path`. */
  path: string;
  /** Exact scalar value read at `path`. */
  value: string | number | boolean;
}

/**
 * One selector's contribution to a uniqueness key, discriminated by shape:
 * a `target` property marks a {@link UniquenessRelationTargetKeyPart}, a
 * `value` property marks a {@link UniquenessDataKeyPart}.
 */
export type UniquenessKeyPart = UniquenessRelationTargetKeyPart | UniquenessDataKeyPart;

/** A fully resolved uniqueness key derived from an artifact's relations and data. */
export interface UniquenessKey {
  /** The rule this key was derived from, in its original declared form. */
  rule: ArtifactUniquenessRule;
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /**
   * One part per selector, in declaration order. Parts are heterogeneous by
   * selector kind: a {@link UniquenessRelationTargetKeyPart} is the
   * containment probe a store runs against a stored relations array, a
   * {@link UniquenessDataKeyPart} is the exact value to compare against a
   * stored data field. A store enforcing a mixed rule (FACT-141) runs both
   * kinds of comparison per part and combines them — there is no single
   * probe shape that covers all parts.
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
  | 'unsupported-selector'
  | 'missing-value'
  | 'unsupported-value-type';

/** Diagnostic for a single selector within a rule that blocked key derivation. */
export interface UniquenessKeyIssue {
  /** Zero-based index of the rule in the declared uniqueness array. */
  ruleIndex: number;
  /** Zero-based index of the failing selector within `rule.by`. */
  selectorIndex: number;
  /** Why derivation failed. */
  reason: UniquenessKeyIssueReason;
  /** Relation type string for `relation-target` selectors; absent otherwise. */
  relationType?: string;
  /** Data-relative object-property path for `data` selectors; absent otherwise. */
  dataPath?: string;
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
 * Read the value at a dot-separated, data-relative object-property path.
 * Array indices and wildcards are not supported (matches
 * {@link ArtifactDataPathSchema}). Mirrors {@link readArtifactTitle}'s
 * traversal but reports absence instead of throwing.
 * @param data - Artifact data to read from.
 * @param path - Dot-separated object-property path.
 * @returns The value when the full path resolves, or `undefined` when any
 * segment is missing.
 */
function resolveDataPathValue(data: Record<string, unknown> | undefined, path: string): { value: unknown } | undefined {
  let current: unknown = data;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return { value: current };
}

/**
 * Attempt to derive a single key part from a `data` selector and the
 * artifact data being written. Comparison is exact equality of the raw
 * scalar value: no normalization or case folding (FACT-141).
 * @param selector - The `data` selector to evaluate.
 * @param data - Data of the artifact being written; undefined when the
 * caller did not supply it.
 * @param ruleIndex - Zero-based index of the enclosing rule.
 * @param selectorIndex - Zero-based index of this selector within `rule.by`.
 * @returns A resolved {@link UniquenessDataKeyPart} or a {@link UniquenessKeyIssue}.
 */
function deriveDataSelectorPart(
  selector: Extract<ArtifactUniquenessRule['by'][number], { kind: 'data' }>,
  data: Record<string, unknown> | undefined,
  ruleIndex: number,
  selectorIndex: number,
): UniquenessDataKeyPart | UniquenessKeyIssue {
  const { path } = selector;
  const resolved = resolveDataPathValue(data, path);
  if (resolved === undefined || resolved.value === null || resolved.value === undefined) {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'missing-value',
      dataPath: path,
      message: `rule #${ruleIndex}, selector #${selectorIndex}, data path '${path}': no value found`,
    };
  }
  const { value } = resolved;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return {
      ruleIndex,
      selectorIndex,
      reason: 'unsupported-value-type',
      dataPath: path,
      message:
        `rule #${ruleIndex}, selector #${selectorIndex}, data path '${path}':` +
        ` value must be a scalar (string, number, or boolean)`,
    };
  }
  return { path, value };
}

/**
 * Attempt to derive a single key part from a selector, the artifact's
 * relations, and the artifact data being written. Returns the part on
 * success, or an issue on failure.
 * @param selector - One entry from `rule.by` to evaluate.
 * @param relations - Full relation list of the artifact being written.
 * @param data - Data of the artifact being written; undefined when the
 * caller did not supply it (only relevant for `data` selectors).
 * @param ruleIndex - Zero-based index of the enclosing rule.
 * @param selectorIndex - Zero-based index of this selector within `rule.by`.
 * @returns A resolved {@link UniquenessKeyPart} or a {@link UniquenessKeyIssue}.
 */
function deriveSelectorPart(
  selector: ArtifactUniquenessRule['by'][number],
  relations: readonly ArtifactRelation[],
  data: Record<string, unknown> | undefined,
  ruleIndex: number,
  selectorIndex: number,
): UniquenessKeyPart | UniquenessKeyIssue {
  if (selector.kind === 'data') {
    return deriveDataSelectorPart(selector, data, ruleIndex, selectorIndex);
  }
  const { relationType } = selector;
  // Whole-artifact uniqueness cannot be derived from a relation owned by a local part.
  const matching = relations.filter((r) => r.type === relationType && r.sourceLocalId === undefined);
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
 * Serialize a single key part into an injective tuple for {@link UniquenessKey.serialized}.
 * Leads with a branch tag so a `data` part and a `relation-target` part can
 * never collide: without it, a `data` selector whose path equals a relation
 * type and whose string value equals
 * {@link serializeArtifactRelationTargetIdentity}'s output for some target
 * would serialize to the exact same tuple as that `relation-target` part.
 * @param part - A resolved key part.
 * @returns A tuple suitable for `JSON.stringify`-based key equality.
 */
function serializeUniquenessKeyPart(part: UniquenessKeyPart): unknown[] {
  return 'target' in part
    ? ['relation-target', part.type, serializeArtifactRelationTargetIdentity(part.target)]
    : ['data', part.path, part.value];
}

/**
 * Derive one key per rule from an artifact's relations and, for `data`
 * selectors, its data. Rules with any issue produce no key; keys and issues
 * are returned together.
 * @param rules - Declared uniqueness rules to derive keys for.
 * @param relations - Full relation list of the artifact being written.
 * @param data - Data of the artifact being written; only needed when a rule
 * declares a `data` selector (FACT-141). Omitting it while such a selector
 * is present surfaces a `missing-value` issue rather than throwing.
 * @returns Combined set of derived keys and selector-level issues.
 */
export function buildUniquenessKeys(
  rules: readonly ArtifactUniquenessRule[],
  relations: readonly ArtifactRelation[],
  data?: Record<string, unknown>,
): BuildUniquenessKeysResult {
  const keys: UniquenessKey[] = [];
  const issues: UniquenessKeyIssue[] = [];

  for (const [ruleIndex, rule] of rules.entries()) {
    const derivations = rule.by.map((selector, selectorIndex) =>
      deriveSelectorPart(selector, relations, data, ruleIndex, selectorIndex),
    );
    // Collect all issues for this rule — not just the first — so every failing
    // selector is surfaced, consistent with assessUniquenessSupport which is
    // exhaustive per selector.
    const ruleIssues = derivations.filter((d): d is UniquenessKeyIssue => 'reason' in d);
    if (ruleIssues.length > 0) {
      issues.push(...ruleIssues);
      continue;
    }
    const parts = derivations.filter((d): d is UniquenessKeyPart => !('reason' in d));
    const serialized = JSON.stringify(parts.map((p) => serializeUniquenessKeyPart(p)));
    keys.push({ rule, ruleIndex, parts, serialized });
  }

  return { keys, issues };
}

/**
 * Human-readable one-liner for a key.
 * @example `about → artifact:concept/abc`
 * @example `owned-by → entity:workpiece/W-1; about → artifact:concept/abc`
 * @example `slug → "my-slug"`
 * @param key - A fully resolved uniqueness key.
 * @returns A string describing each part in `selector → value` form, joined by `'; '`.
 */
export function describeUniquenessKey(key: UniquenessKey): string {
  return key.parts
    .map((part) =>
      'target' in part
        ? `${part.type} → ${describeArtifactRelationTargetIdentity(part.target)}`
        : `${part.path} → ${JSON.stringify(part.value)}`,
    )
    .join('; ');
}
