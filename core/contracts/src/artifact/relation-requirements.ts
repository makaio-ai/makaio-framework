import type { ArtifactRelationRequirement } from './kind-registration.js';
import { serializeArtifactRelationTargetIdentity } from './relation-target-identity.js';
import type { ArtifactRelation } from './schemas.js';
import { resolveDataPathValue } from './uniqueness.js';

/** Why an applicable relation requirement is not met by a write. */
export type RelationRequirementIssueReason = 'below-min-items' | 'above-max-items';

/** One unmet relation requirement, as reported by {@link evaluateRelationRequirements}. */
export interface RelationRequirementIssue {
  /** Zero-based index of the requirement in the declared requirements array. */
  readonly index: number;
  /** The requirement that is not met. */
  readonly requirement: ArtifactRelationRequirement;
  /** Whether the count falls below `minItems` or exceeds `maxItems`. */
  readonly reason: RelationRequirementIssueReason;
  /** Number of distinct target artifacts that matched the requirement. */
  readonly count: number;
}

/**
 * Evaluates registration relation requirements against one write; pure.
 *
 * A requirement counts the distinct target artifacts (by kind and id, revision
 * pins ignored) among relations of its `relationType` that start at the
 * artifact itself (no `sourceLocalId`) and, when `targetKinds` is non-empty,
 * target one of those kinds. Non-artifact targets never count.
 *
 * A requirement with `when` applies only when the value at `when.path` in
 * `data` is a scalar strictly equal to `when.equals`; a missing, null,
 * non-scalar, or unequal value skips the requirement without an issue.
 *
 * The caller decides which relations to pass, e.g. only the relations its
 * relation-type registry permits; this function does not filter them further.
 * @param requirements - Declared `registration.relations` of the written kind.
 * @param relations - Relations of the write that may count toward requirements.
 * @param data - Data of the artifact being written; only read for `when` conditions.
 * @returns One issue per violated bound of each applicable requirement, in declaration order.
 */
export function evaluateRelationRequirements(
  requirements: readonly ArtifactRelationRequirement[] | undefined,
  relations: readonly ArtifactRelation[],
  data: Record<string, unknown> | undefined,
): RelationRequirementIssue[] {
  const issues: RelationRequirementIssue[] = [];

  for (const [index, requirement] of (requirements ?? []).entries()) {
    if (!isRequirementApplicable(requirement, data)) continue;

    const count = countDistinctTargets(requirement, relations);
    if (count < requirement.minItems) {
      issues.push({ index, requirement, reason: 'below-min-items', count });
    }
    if (requirement.maxItems !== undefined && count > requirement.maxItems) {
      issues.push({ index, requirement, reason: 'above-max-items', count });
    }
  }

  return issues;
}

/**
 * Decide whether a requirement's `when` condition holds for the written data.
 * @param requirement - The requirement to check.
 * @param data - Data of the artifact being written.
 * @returns `true` without `when`, or when the value at `when.path` is a scalar
 * strictly equal to `when.equals`; `false` otherwise.
 */
function isRequirementApplicable(
  requirement: ArtifactRelationRequirement,
  data: Record<string, unknown> | undefined,
): boolean {
  if (requirement.when === undefined) return true;
  const resolved = resolveDataPathValue(data, requirement.when.path);
  if (resolved === undefined) return false;
  const { value } = resolved;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false;
  return value === requirement.when.equals;
}

/**
 * Count the distinct target artifacts that match a requirement.
 * @param requirement - The requirement whose relation type and target kinds filter the relations.
 * @param relations - Relations of the write that may count.
 * @returns Number of distinct matching target artifacts, revision pins ignored.
 */
function countDistinctTargets(
  requirement: ArtifactRelationRequirement,
  relations: readonly ArtifactRelation[],
): number {
  const targets = new Set<string>();
  for (const relation of relations) {
    if (relation.sourceLocalId !== undefined) continue;
    if (relation.type !== requirement.relationType) continue;
    const { target } = relation;
    if (target.refClass !== 'artifact') continue;
    if (requirement.targetKinds?.length && !requirement.targetKinds.includes(target.kind)) continue;
    targets.add(serializeArtifactRelationTargetIdentity({ refClass: 'artifact', kind: target.kind, id: target.id }));
  }
  return targets.size;
}
