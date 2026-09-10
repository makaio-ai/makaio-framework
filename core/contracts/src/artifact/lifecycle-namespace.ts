import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import {
  ARTIFACT_LIFECYCLE_REJECTED_CODE,
  ArtifactLifecycleCurrentSchema,
  ArtifactLifecycleHistoryEntrySchema,
  ArtifactLifecycleIdentitySchema,
  ArtifactLifecycleRejectionSchema,
  ArtifactLifecycleTransitionedEntrySchema,
  ArtifactLifecycleTransitionIntentSchema,
  ArtifactLifecycleVersionSchema,
  isArtifactLifecycleTransitionAllowed,
  type ArtifactLifecycleError,
  type ArtifactLifecycleRejection,
  type ArtifactLifecycleTransitionIntent,
} from './lifecycle.js';

/** Read today's administration state separately from immutable artifact content. */
export const ArtifactLifecycleGetRequestSchema = z.strictObject({ artifact: ArtifactLifecycleIdentitySchema });
/** Records explicitly have no lifecycle; missing initialization is never a valid result. */
export const ArtifactLifecycleGetResponseSchema = z.strictObject({ lifecycle: ArtifactLifecycleCurrentSchema });
/** Read ascending lifecycle versions, exclusively after an optional cursor. */
export const ArtifactLifecycleHistoryRequestSchema = z.strictObject({
  artifact: ArtifactLifecycleIdentitySchema,
  afterVersion: ArtifactLifecycleVersionSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
/**
 * A bounded page of one artifact's history in contiguous ascending lifecycle-version
 * order, each transition linked to the state of the preceding entry. nextCursor is the
 * last returned version and is present only when another page exists. Records return
 * an empty page; this does not introduce a record lifecycle or historical time query.
 */
export const ArtifactLifecycleHistoryResponseSchema = z
  .strictObject({
    entries: z.array(ArtifactLifecycleHistoryEntrySchema).max(100),
    nextCursor: ArtifactLifecycleVersionSchema.optional(),
  })
  .superRefine(({ entries, nextCursor }, ctx) => {
    const first = entries[0];
    let previous: (typeof entries)[number] | undefined;
    for (const [index, entry] of entries.entries()) {
      const sameArtifact = entry.artifact.kind === first?.artifact.kind && entry.artifact.id === first?.artifact.id;
      const contiguous = previous === undefined || entry.lifecycle.version === previous.lifecycle.version + 1;
      const linked =
        previous === undefined ||
        (entry.operation === 'transitioned' &&
          entry.lifecycle.category === previous.lifecycle.category &&
          entry.previousState === previous.lifecycle.state);
      if (!sameArtifact || !contiguous || !linked) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index],
          message: 'History pages contain one artifact in contiguous ascending, state-linked order',
        });
        break;
      }
      previous = entry;
    }
    if (nextCursor !== undefined && nextCursor !== previous?.lifecycle.version) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'nextCursor must equal the last returned lifecycle version',
      });
    }
  });
/** A successful transition returns its persisted history entry, never initialization. */
export const ArtifactLifecycleTransitionResponseSchema = z.strictObject({
  entry: ArtifactLifecycleTransitionedEntrySchema,
});
/**
 * Committed events are emitted after persistence; creation uses the existing created event.
 * The immutable entry is the authoritative result, so the event does not duplicate intent.
 */
export const ArtifactLifecycleCommittedPayloadSchema = ArtifactLifecycleTransitionResponseSchema;
/** JSON-portable error shape shared by RPC rejection details and reaction input. */
export const ArtifactLifecycleFailureSchema = z.strictObject({
  code: z.literal(ARTIFACT_LIFECYCLE_REJECTED_CODE),
  message: z.string().min(1),
  data: ArtifactLifecycleRejectionSchema,
});
/**
 * Convert a caught lifecycle rejection into the portable failure envelope.
 * @param error - Rejection thrown by the shared transition engine.
 * @returns Envelope used for RPC rejection details and the rejected event.
 */
export function toArtifactLifecycleFailure(error: ArtifactLifecycleError): ArtifactLifecycleFailure {
  return { code: error.code, message: error.message, data: error.data };
}
type RejectionIssue = { path: string[]; message: string };
type StatefulRejection = Extract<ArtifactLifecycleRejection, { reason: 'invalid-transition' | 'precondition-failed' }>;

/**
 * Cross-check a rejection against the intent it rejects. Each rule mirrors the engine
 * check order in advanceArtifactLifecycle: the version baseline is verified before the
 * matrix, and preconditions run only for a path the matrix allows.
 * @param transition - The rejected intent.
 * @param rejection - Structured rejection details.
 * @returns Inconsistencies as issue paths below `error.data`.
 */
function rejectionIssues(
  transition: ArtifactLifecycleTransitionIntent,
  rejection: ArtifactLifecycleRejection,
): RejectionIssue[] {
  switch (rejection.reason) {
    case 'content-basis-conflict':
      return contentConflictIssues(transition, rejection);
    case 'lifecycle-version-conflict':
      return [...requestedStateIssues(transition, rejection), ...versionConflictIssues(transition, rejection)];
    case 'invalid-transition':
    case 'precondition-failed':
      return [...requestedStateIssues(transition, rejection), ...statefulIssues(transition, rejection)];
  }
}

/**
 * @param transition - The rejected intent.
 * @param rejection - Rejection carrying the requested state.
 * @returns An issue when the rejection names a different target state than the intent.
 */
function requestedStateIssues(
  transition: ArtifactLifecycleTransitionIntent,
  rejection: Exclude<ArtifactLifecycleRejection, { reason: 'content-basis-conflict' }>,
): RejectionIssue[] {
  if (rejection.requestedState === transition.state) return [];
  return [{ path: ['requestedState'], message: 'Rejection requestedState must match the rejected transition' }];
}

/**
 * @param transition - The rejected intent.
 * @param rejection - Version conflict details.
 * @returns Issues when the conflict does not reflect the supplied baseline.
 */
function versionConflictIssues(
  transition: ArtifactLifecycleTransitionIntent,
  rejection: Extract<ArtifactLifecycleRejection, { reason: 'lifecycle-version-conflict' }>,
): RejectionIssue[] {
  const issues: RejectionIssue[] = [];
  if (rejection.expectedVersion !== transition.expectedVersion) {
    issues.push({ path: ['expectedVersion'], message: 'Version conflict baseline must match the rejected transition' });
  }
  if (rejection.current.version === transition.expectedVersion) {
    issues.push({
      path: ['current', 'version'],
      message: 'Version conflict requires a current version different from the supplied baseline',
    });
  }
  return issues;
}

/**
 * @param transition - The rejected intent.
 * @param rejection - Content conflict details.
 * @returns Issues when the conflict does not reflect the rejected assessment.
 */
function contentConflictIssues(
  transition: ArtifactLifecycleTransitionIntent,
  rejection: Extract<ArtifactLifecycleRejection, { reason: 'content-basis-conflict' }>,
): RejectionIssue[] {
  const issues: RejectionIssue[] = [];
  if (
    transition.situation.kind !== 'revision-assessment' ||
    rejection.assessedRevision !== transition.situation.assessedRevision
  ) {
    issues.push({
      path: ['assessedRevision'],
      message: 'Content conflict must identify the rejected revision assessment',
    });
  }
  if (rejection.currentRevision === rejection.assessedRevision) {
    issues.push({
      path: ['currentRevision'],
      message: 'Content conflict requires a current revision different from the assessed revision',
    });
  }
  return issues;
}

/**
 * A stateful rejection after the version check reports the supplied baseline, and its
 * reason derives from the matrix: invalid-transition means the matrix refused the path,
 * precondition-failed means the path passed the matrix. Records carry no state to compare.
 * @param transition - The rejected intent.
 * @param rejection - Matrix or precondition rejection details.
 * @returns Issues when the reason contradicts the baseline or the matrix.
 */
function statefulIssues(transition: ArtifactLifecycleTransitionIntent, rejection: StatefulRejection): RejectionIssue[] {
  if (rejection.current.category === 'record') return [];
  const issues: RejectionIssue[] = [];
  if (rejection.current.version !== transition.expectedVersion) {
    issues.push({
      path: ['current', 'version'],
      message: 'A rejection after the version check must report the supplied baseline version',
    });
  }
  const allowed = isArtifactLifecycleTransitionAllowed(rejection.current.state, rejection.requestedState);
  if (rejection.reason === 'invalid-transition' && allowed) {
    issues.push({
      path: ['reason'],
      message: 'invalid-transition requires a transition the lifecycle matrix disallows',
    });
  }
  if (rejection.reason === 'precondition-failed' && !allowed) {
    issues.push({ path: ['reason'], message: 'precondition-failed requires a transition the lifecycle matrix allows' });
  }
  return issues;
}

/**
 * Supplemental event for a rejected valid transition request. It does not replace
 * immediate RPC failure. Hosts add trusted repository/correlation context through
 * subject extensions; domain-specific messages and reactions remain host-owned.
 */
export const ArtifactLifecycleRejectedPayloadSchema = z
  .strictObject({
    transition: ArtifactLifecycleTransitionIntentSchema,
    error: ArtifactLifecycleFailureSchema,
  })
  .superRefine(({ transition, error }, ctx) => {
    for (const issue of rejectionIssues(transition, error.data)) {
      ctx.addIssue({ code: 'custom', path: ['error', 'data', ...issue.path], message: issue.message });
    }
  });

/** Additive shared business-lifecycle RPC and event schemas. */
export const ArtifactLifecycleSchemas = {
  'lifecycle.get': {
    request: ArtifactLifecycleGetRequestSchema,
    response: ArtifactLifecycleGetResponseSchema,
  },
  'lifecycle.history': {
    request: ArtifactLifecycleHistoryRequestSchema,
    response: ArtifactLifecycleHistoryResponseSchema,
  },
  'lifecycle.transition': {
    request: ArtifactLifecycleTransitionIntentSchema,
    response: ArtifactLifecycleTransitionResponseSchema,
  },
  'lifecycle.committed': ArtifactLifecycleCommittedPayloadSchema,
  'lifecycle.rejected': ArtifactLifecycleRejectedPayloadSchema,
} satisfies SchemaRecord;

/** Request for current lifecycle administration. */
export type ArtifactLifecycleGetRequest = z.infer<typeof ArtifactLifecycleGetRequestSchema>;
/** Current administration, independent of requested content revision. */
export type ArtifactLifecycleGetResponse = z.infer<typeof ArtifactLifecycleGetResponseSchema>;
/** Parsed history request with its bounded page size. */
export type ArtifactLifecycleHistoryRequest = z.infer<typeof ArtifactLifecycleHistoryRequestSchema>;
/** One ordered lifecycle-history page. */
export type ArtifactLifecycleHistoryResponse = z.infer<typeof ArtifactLifecycleHistoryResponseSchema>;
/** Successfully persisted transition entry. */
export type ArtifactLifecycleTransitionResponse = z.infer<typeof ArtifactLifecycleTransitionResponseSchema>;
/** Supplemental event following successful transition persistence. */
export type ArtifactLifecycleCommittedPayload = z.infer<typeof ArtifactLifecycleCommittedPayloadSchema>;
/** Generic portable lifecycle failure envelope. */
export type ArtifactLifecycleFailure = z.infer<typeof ArtifactLifecycleFailureSchema>;
/** Supplemental reaction input following a rejected valid transition request. */
export type ArtifactLifecycleRejectedPayload = z.infer<typeof ArtifactLifecycleRejectedPayloadSchema>;
