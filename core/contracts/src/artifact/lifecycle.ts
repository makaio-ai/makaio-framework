import { z } from 'zod';
import {
  ARTIFACT_CATEGORY_LIFECYCLE_STATES,
  ArtifactLifecycleStateSchema,
  type ArtifactCategory,
  type ArtifactLifecycleState,
} from './kind-registration.js';
import { ArtifactActorSchema, ArtifactRefSchema } from './schemas.js';

/**
 * An artifact identity independent of its immutable content revisions. The `refClass`
 * discriminant of ArtifactRefSchema is dropped on purpose: lifecycle payloads carry the
 * identity only in the named `artifact` slot of strict objects, never in a polymorphic
 * position beside evidence refs, so the discriminant would add wire noise without guarding.
 */
export const ArtifactLifecycleIdentitySchema = ArtifactRefSchema.pick({ kind: true, id: true });
/** Monotonic administration version, independent of the content revision. */
export const ArtifactLifecycleVersionSchema = z.number().int().positive();
const version = ArtifactLifecycleVersionSchema;
const initialStates = { knowledge: 'valid', commitment: 'proposed', interaction: 'open' } as const;
/**
 * Current administration state; each category admits only its own states. Version 1 implies
 * the category initial state (every transition increments the version, so only the creation
 * entry can be version 1). The converse does not hold: a `knowledge` artifact retired and
 * then reinstated re-enters `valid` at a version greater than 1, so the reverse rule is
 * deliberately not enforced.
 */
export const ArtifactLifecycleSnapshotSchema = z
  .discriminatedUnion('category', [
    z.strictObject({
      category: z.literal('knowledge'),
      state: z.enum(ARTIFACT_CATEGORY_LIFECYCLE_STATES.knowledge),
      version,
    }),
    z.strictObject({
      category: z.literal('commitment'),
      state: z.enum(ARTIFACT_CATEGORY_LIFECYCLE_STATES.commitment),
      version,
    }),
    z.strictObject({
      category: z.literal('interaction'),
      state: z.enum(ARTIFACT_CATEGORY_LIFECYCLE_STATES.interaction),
      version,
    }),
  ])
  .superRefine((snapshot, ctx) => {
    if (snapshot.version === 1 && snapshot.state !== initialStates[snapshot.category]) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Lifecycle version 1 is reserved for the category initial state',
      });
    }
  });
/** Records have no business lifecycle. This is not an uninitialized-state fallback. */
export const ArtifactLifecycleCurrentSchema = z.union([
  ArtifactLifecycleSnapshotSchema,
  z.strictObject({ category: z.literal('record') }),
]);
const nonBlank = z.string().trim().min(1);
const source = z.strictObject({ kind: nonBlank, ref: nonBlank });
/**
 * Facts available to a configured process, not authorization or proof of human reading.
 * assessedRevision always identifies content of the enclosing request/history artifact.
 * Handover deliberately makes no claim about which revision a person saw.
 */
export const ArtifactLifecycleSituationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('revision-assessment'),
    assessedRevision: ArtifactRefSchema.shape.revision,
    source: source.optional(),
  }),
  z.strictObject({ kind: z.literal('handover'), source }),
]);
const transitionIntentFields = {
  artifact: ArtifactLifecycleIdentitySchema,
  expectedVersion: version,
  state: ArtifactLifecycleStateSchema,
  situation: ArtifactLifecycleSituationSchema,
  reason: nonBlank.optional(),
};
/**
 * Public intent to change administration state. A caller never chooses the actor
 * recorded in lifecycle history; the host derives it from authenticated context.
 */
export const ArtifactLifecycleTransitionIntentSchema = z.strictObject(transitionIntentFields);
/** Trusted host command used to persist an attributed transition and history entry. */
export const ArtifactLifecycleTransitionCommandSchema = z.strictObject({
  ...transitionIntentFields,
  actor: ArtifactActorSchema,
});

/** Pure transition matrix; retired knowledge may be reinstated, all other end states are terminal in this slice. */
const transitions: Record<ArtifactLifecycleState, readonly ArtifactLifecycleState[]> = {
  valid: ['retired'],
  retired: ['valid'],
  proposed: ['decided'],
  decided: ['fulfilled', 'revoked'],
  fulfilled: [],
  revoked: [],
  open: ['resolved', 'closed-without-resolution'],
  resolved: [],
  'closed-without-resolution': [],
};
/**
 * Tell whether the shared matrix allows a transition between two states.
 * @param from - Current stateful lifecycle state.
 * @param to - Requested state.
 * @returns True when the transition is a regular path of this slice.
 */
export function isArtifactLifecycleTransitionAllowed(
  from: ArtifactLifecycleState,
  to: ArtifactLifecycleState,
): boolean {
  return transitions[from].includes(to);
}
const historyFields = {
  artifact: ArtifactLifecycleIdentitySchema,
  lifecycle: ArtifactLifecycleSnapshotSchema,
  actor: ArtifactActorSchema,
  timestamp: z.number().int().nonnegative(),
  /** Content current at the write, not an assertion that the actor assessed it. */
  observedRevision: ArtifactRefSchema.shape.revision,
};
/** Creation entry: the only history entry carrying the category initial state and version 1. */
export const ArtifactLifecycleInitializedEntrySchema = z
  .strictObject({ ...historyFields, operation: z.literal('initialized') })
  .superRefine((entry, ctx) => {
    if (entry.lifecycle.version !== 1 || entry.lifecycle.state !== initialStates[entry.lifecycle.category]) {
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'Initialization requires the category initial state and version 1',
      });
    }
  });
/**
 * Retiring knowledge and reinstating retired knowledge are the transitions that need a reason.
 * @param from - Current lifecycle state before the transition.
 * @param to - Requested lifecycle state after the transition.
 * @returns True when a non-blank reason is required for the transition.
 */
function lifecycleTransitionRequiresReason(from: ArtifactLifecycleState, to: ArtifactLifecycleState): boolean {
  return to === 'retired' || (from === 'retired' && to === 'valid');
}
const LIFECYCLE_TRANSITION_REQUIRES_REASON_MESSAGE = 'Retiring or reinstating knowledge requires a reason';
/** Attributed, justified transition entry appended after initialization. */
export const ArtifactLifecycleTransitionedEntrySchema = z
  .strictObject({
    ...historyFields,
    operation: z.literal('transitioned'),
    previousState: ArtifactLifecycleStateSchema,
    situation: ArtifactLifecycleSituationSchema,
    reason: ArtifactLifecycleTransitionIntentSchema.shape.reason,
  })
  .superRefine((entry, ctx) => {
    // The matrix only maps states within one category, so a matrix hit also proves that
    // previousState belongs to the category of the persisted snapshot.
    if (
      !isArtifactLifecycleTransitionAllowed(entry.previousState, entry.lifecycle.state) ||
      entry.lifecycle.version <= 1
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'History requires a category-compatible transition after initialization',
      });
    }
    if (lifecycleTransitionRequiresReason(entry.previousState, entry.lifecycle.state) && !entry.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: LIFECYCLE_TRANSITION_REQUIRES_REASON_MESSAGE,
      });
    }
    if (entry.situation.kind === 'revision-assessment' && entry.situation.assessedRevision !== entry.observedRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['situation'],
        message: 'An assessment cannot authorize a different observed content revision',
      });
    }
  });
/**
 * Immutable history separates creation from an attributed, justified state transition.
 * This validates one entry's structure, not its position in persisted history. The host
 * must atomically append the entry with current.version + 1 while updating current state.
 */
export const ArtifactLifecycleHistoryEntrySchema = z.discriminatedUnion('operation', [
  ArtifactLifecycleInitializedEntrySchema,
  ArtifactLifecycleTransitionedEntrySchema,
]);
/** JSON-portable rejection details; domain-specific explanation belongs to reaction rules. */
export const ArtifactLifecycleRejectionSchema = z.discriminatedUnion('reason', [
  z.strictObject({
    reason: z.literal('lifecycle-version-conflict'),
    expectedVersion: version,
    current: ArtifactLifecycleSnapshotSchema,
    requestedState: ArtifactLifecycleStateSchema,
  }),
  z.strictObject({
    reason: z.literal('content-basis-conflict'),
    assessedRevision: ArtifactRefSchema.shape.revision,
    currentRevision: ArtifactRefSchema.shape.revision,
  }),
  z.strictObject({
    reason: z.literal('invalid-transition'),
    current: ArtifactLifecycleCurrentSchema,
    requestedState: ArtifactLifecycleStateSchema,
  }),
  z.strictObject({
    reason: z.literal('precondition-failed'),
    // Records fail earlier as invalid-transition, so a precondition always has a snapshot.
    current: ArtifactLifecycleSnapshotSchema,
    requestedState: ArtifactLifecycleStateSchema,
  }),
]);
/** Stable RPC error code shared by the error class and the portable failure envelope. */
export const ARTIFACT_LIFECYCLE_REJECTED_CODE = 'artifact-lifecycle-rejected';
/** JSON-portable failure payload retained by the bus transport. */
export class ArtifactLifecycleError extends Error {
  /** Stable RPC error code; callers must not depend on remote class identity. */
  public readonly code = ARTIFACT_LIFECYCLE_REJECTED_CODE;
  /** Validated JSON details preserved by supported bus transports. */
  public readonly data: ArtifactLifecycleRejection;
  /**
   * Construct a generic failure with validated structured details.
   * @param message - Generic explanation for callers without a reaction rule.
   * @param data - Machine-readable rejection context.
   */
  public constructor(message: string, data: ArtifactLifecycleRejection) {
    super(message);
    this.name = 'ArtifactLifecycleError';
    this.data = ArtifactLifecycleRejectionSchema.parse(data);
  }
}
/** Current lifecycle for the three stateful categories. */
export type ArtifactLifecycleSnapshot = z.infer<typeof ArtifactLifecycleSnapshotSchema>;
/** Current administration result, including lifecycle-free records. */
export type ArtifactLifecycleCurrent = z.infer<typeof ArtifactLifecycleCurrentSchema>;
/** Available assessment or handover facts for one change. */
export type ArtifactLifecycleSituation = z.infer<typeof ArtifactLifecycleSituationSchema>;
/** Caller-supplied state-change intent independent of content revision writes. */
export type ArtifactLifecycleTransitionIntent = z.infer<typeof ArtifactLifecycleTransitionIntentSchema>;
/** Host-attributed command used by trusted lifecycle persistence. */
export type ArtifactLifecycleTransitionCommand = z.infer<typeof ArtifactLifecycleTransitionCommandSchema>;
/** Creation entry of persisted lifecycle history. */
export type ArtifactLifecycleInitializedEntry = z.infer<typeof ArtifactLifecycleInitializedEntrySchema>;
/** Attributed transition entry of persisted lifecycle history. */
export type ArtifactLifecycleTransitionedEntry = z.infer<typeof ArtifactLifecycleTransitionedEntrySchema>;
/** Immutable initialization or transition entry. */
export type ArtifactLifecycleHistoryEntry = z.infer<typeof ArtifactLifecycleHistoryEntrySchema>;
/** Generic structured failure details. */
export type ArtifactLifecycleRejection = z.infer<typeof ArtifactLifecycleRejectionSchema>;
/**
 * Establish the only regular starting state for a newly created artifact.
 * @param category - Category from the effective kind definition.
 * @returns Initialized state, or the explicit lifecycle-free record result.
 */
export function initialArtifactLifecycle(category: ArtifactCategory): ArtifactLifecycleCurrent {
  if (category === 'record') return { category: 'record' };
  return ArtifactLifecycleSnapshotSchema.parse({ category, state: initialStates[category], version: 1 });
}
/**
 * Validate a transition against locked current administration and content state.
 * The host must commit the resulting state and history in the same transaction.
 * @param input - Trusted persisted baselines plus an attributed change command.
 * @returns Next administration snapshot; never creates a content revision.
 */
export function advanceArtifactLifecycle(input: {
  current: ArtifactLifecycleCurrent;
  currentRevision: string;
  command: ArtifactLifecycleTransitionCommand;
}): ArtifactLifecycleSnapshot {
  const current = ArtifactLifecycleCurrentSchema.parse(input.current);
  const currentRevision = ArtifactRefSchema.shape.revision.parse(input.currentRevision);
  const command = ArtifactLifecycleTransitionCommandSchema.parse(input.command);
  if (current.category === 'record') {
    throw new ArtifactLifecycleError('Record artifacts do not have a lifecycle', {
      reason: 'invalid-transition',
      current,
      requestedState: command.state,
    });
  }
  if (command.expectedVersion !== current.version) {
    throw new ArtifactLifecycleError('Artifact lifecycle changed since the supplied baseline', {
      reason: 'lifecycle-version-conflict',
      expectedVersion: command.expectedVersion,
      current,
      requestedState: command.state,
    });
  }
  if (command.situation.kind === 'revision-assessment' && command.situation.assessedRevision !== currentRevision) {
    throw new ArtifactLifecycleError('Assessed content revision is no longer current', {
      reason: 'content-basis-conflict',
      assessedRevision: command.situation.assessedRevision,
      currentRevision,
    });
  }
  if (!isArtifactLifecycleTransitionAllowed(current.state, command.state)) {
    throw new ArtifactLifecycleError('Artifact lifecycle transition is not allowed', {
      reason: 'invalid-transition',
      current,
      requestedState: command.state,
    });
  }
  if (lifecycleTransitionRequiresReason(current.state, command.state) && !command.reason) {
    throw new ArtifactLifecycleError(LIFECYCLE_TRANSITION_REQUIRES_REASON_MESSAGE, {
      reason: 'precondition-failed',
      current,
      requestedState: command.state,
    });
  }
  return ArtifactLifecycleSnapshotSchema.parse({ ...current, state: command.state, version: current.version + 1 });
}
