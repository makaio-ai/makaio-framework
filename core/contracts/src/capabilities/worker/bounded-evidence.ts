/**
 * Construction of {@link BoundedRecoveryEvidence} that cannot exceed its own
 * bounds.
 *
 * The evidence schema states the limits; this helper is how a producer meets
 * them. Truncation policy is observable in durable state that outlives the
 * process that wrote it, so it belongs to the contract rather than to each
 * producer's convention — two producers clamping the same summary differently
 * make the same observation read differently forever.
 * @packageDocumentation
 */

import { BoundedRecoveryEvidenceSchema, RECOVERY_EVIDENCE_LIMITS, type BoundedRecoveryEvidence } from './types.js';

/**
 * Clamp a summary without leaving half of a UTF-16 surrogate pair at the boundary.
 * @param summary - Summary to clamp.
 * @param limit - Maximum UTF-16 length accepted by the durable schema.
 * @returns Original summary or a safely truncated summary ending in an ellipsis.
 */
function clampSummary(summary: string, limit: number): string {
  if (summary.length <= limit) return summary;
  const prefix = summary.slice(0, limit - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  const safePrefix = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? prefix.slice(0, -1) : prefix;
  return `${safePrefix}…`;
}

/**
 * Build bounded, durable, non-secret evidence attributed to one component.
 *
 * Only the summary is clamped, because it is the one field that interpolates
 * text whose length the producer does not control. An over-long `source` or
 * `code` is a producer defect rather than an unlucky message, so it is
 * reported here instead of being silently reshaped.
 *
 * The helper cannot inspect the contents of `summary`: keeping that text
 * short, non-secret, and free of stack or raw-response fragments remains the
 * producing component's obligation.
 * @param source - Identifier of the component that observed the evidence.
 * @param code - Stable machine-readable classification, or `undefined` when the
 *   observation carries no code a consumer may branch on.
 * @param summary - Human-readable, non-secret explanation of the observation.
 * @returns Evidence validated against the durable recovery-evidence bounds.
 * @throws When a field other than the clamped summary violates the bounds.
 */
export function boundedProviderEvidence(
  source: string,
  code: string | undefined,
  summary: string,
): BoundedRecoveryEvidence {
  const limit = RECOVERY_EVIDENCE_LIMITS.summary;
  return BoundedRecoveryEvidenceSchema.parse({
    source,
    summary: clampSummary(summary, limit),
    observedAt: new Date().toISOString(),
    ...(code === undefined ? {} : { code }),
  });
}
