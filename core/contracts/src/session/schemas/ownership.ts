import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { AgentRoleSchema } from './primitives.js';
import {
  AdapterSessionClaimDispositionSchema,
  AdapterSessionClaimRecordSchema,
  OwnershipTopologySchema,
  SessionOwnershipRecoveryConflictSchema,
  SessionOwnershipRecoveryCurrencyChangedSchema,
  SessionOwnershipRecoveryGuardSchema,
  SessionOwnershipRecoveryReservationSchema,
  SessionOwnershipReleaseAgentClaimsResponseSchema,
  SessionOwnershipSettleMovementResponseSchema,
} from '../session-ownership-storage-namespace.js';

export { OwnershipTopologySchema };

/** {@inheritDoc OwnershipTopologySchema} */
export type OwnershipTopology = z.infer<typeof OwnershipTopologySchema>;

/**
 * Who an ownership operation acts for, and in whose adapter namespace.
 *
 * Every identity-dependent ownership operation carries this, because the
 * ownership key is the (machine, adapter instance, provider session) triple:
 * an operation that named only the agent would be reserving in a namespace
 * nobody can point at.
 */
export const SessionOwnershipPrincipalSchema = z.object({
  /** Session the agent belongs to; verified against the agent row, never trusted. */
  sessionId: z.string(),
  /** Agent the operation acts for. */
  agentId: z.string(),
  /**
   * Adapter instance that will own the provider process.
   *
   * Must be the **live** instance the caller is about to dispatch to: the
   * ownership key is (machine, adapter instance, provider session), so
   * reserving against a stale ID reserves in a namespace the dispatch will not
   * use. Persisted adapter IDs go stale across restarts and are never
   * acceptable here without re-resolution.
   */
  adapterId: z.string(),
  /** Adapter type name, carried onto any claim taken for diagnostics. */
  adapterName: z.string(),
  /** Exact authority incarnation that owns the connector this act addresses. */
  ownerInstanceId: z.string(),
  /**
   * Machine identity override.
   *
   * Omit in production: the authority uses the identity it was composed with,
   * and an authority without one declines to decide rather than guessing. The
   * override exists for tests and operational tooling, mirroring
   * `session.restartAgents`.
   */
  machineId: z.string().optional(),
});

/** {@inheritDoc SessionOwnershipPrincipalSchema} */
export type SessionOwnershipPrincipal = z.infer<typeof SessionOwnershipPrincipalSchema>;

/**
 * Request payload for `session.ownership.reserveStart`.
 *
 * One reservation is one storage transaction: the claim on the provider
 * session the start will resume (or none, for a start with no key yet) plus the
 * lead designation, taken together. A start that designated through a second
 * call would leave a window in which the provider session is owned by an agent
 * the session does not yet call its lead — and a movement announced in that
 * window has no legitimate writer.
 */
export const SessionOwnershipReserveStartServiceRequestSchema = SessionOwnershipPrincipalSchema.extend({
  /**
   * Whether this start designates the session's lead.
   *
   * `'member'` leaves the designation untouched — a restart or a secondary
   * agent must never redirect the session.
   */
  role: AgentRoleSchema,
  /**
   * Provider session to reserve, or `null` for a start with no key yet because
   * the provider will mint its own identity.
   */
  resumeProviderSessionId: z.string().nullable(),
  /** Caller-minted identity for the reservation generation. */
  claimToken: z.string(),
  /** Atomic recovery snapshot; omitted for ordinary starts. */
  recoveryGuard: SessionOwnershipRecoveryGuardSchema.optional(),
  /** Opaque recovery-attempt fence minted before the reservation. */
  recoveryAttemptId: z.string().optional(),
  /**
   * Lead the caller observed, compare-and-swap style; `null` means "no lead
   * yet".
   *
   * **Required when `role === 'lead'`.** A caller that replaces a lead must
   * name the exact value it read: there is no "designate whatever is there"
   * mode, because that is not a compare-and-swap and would let two concurrent
   * starts both believe they lead.
   */
  expectedLeadAgentId: z.string().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.role === 'lead' && value.expectedLeadAgentId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedLeadAgentId'],
      message: "expectedLeadAgentId is required when role is 'lead'",
    });
  }
  if (value.recoveryGuard !== undefined && value.role !== 'member') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recoveryGuard'],
      message: "recoveryGuard is only valid when role is 'member'",
    });
  }
  if ((value.recoveryGuard === undefined) !== (value.recoveryAttemptId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recoveryAttemptId'],
      message: 'recoveryAttemptId is required exactly for a guarded recovery reservation',
    });
  }
});

/** {@inheritDoc SessionOwnershipReserveStartServiceRequestSchema} */
export type SessionOwnershipReserveStartServiceRequest = z.infer<
  typeof SessionOwnershipReserveStartServiceRequestSchema
>;

/**
 * Validate and normalize a start reservation at the service trust boundary.
 * @param value - Untrusted reservation request received by the authority.
 * @returns The fully validated reservation request.
 */
export function normalizeSessionOwnershipReserveStartServiceRequest(
  value: unknown,
): SessionOwnershipReserveStartServiceRequest {
  return SessionOwnershipReserveStartServiceRequestSchema.parse(value);
}

/** Shared fields of both keyed and designation-only reservations. */
const SessionOwnershipReservationBaseSchema = z.object({
  /** Agent the reservation was taken for. */
  agentId: z.string(),
  /** Session the reservation was taken in. */
  sessionId: z.string(),
  /** Adapter instance the reservation was taken against. */
  adapterId: z.string(),
  /** Runtime authority incarnation the reserved dispatch must address. */
  ownerInstanceId: z.string(),
  /** Whether this reservation moved the session's lead designation. */
  leadDesignated: z.boolean(),
  /**
   * Lead observed **inside the reserving transaction** — the only value a
   * rollback may restore. A lead read before the call is one another start may
   * already have replaced, so restoring it would undo a designation this caller
   * never observed.
   */
  previousLeadAgentId: z.string().nullable(),
  /** Attempt fence and exact preimage for a guarded recovery. */
  recovery: SessionOwnershipRecoveryReservationSchema.optional(),
});

/**
 * What a committed reservation gives the caller to act — and to roll back — on.
 *
 * A provider-session claim always carries the resolved machine identity that
 * names its key. A designation-only reservation may not: its storage request
 * uses an inert schema filler, which is not a runtime identity and must never
 * be forwarded to a settlement or persisted as a runtime owner.
 */
export const SessionOwnershipReservationSchema = z.union([
  SessionOwnershipReservationBaseSchema.extend({
    /** Resolved machine identity of the claimed provider-session key. */
    machineId: z.string(),
    /** Claim taken for the provider-session key. */
    claim: AdapterSessionClaimRecordSchema,
  }),
  SessionOwnershipReservationBaseSchema.extend({
    /** Real authority machine when one was resolved for this keyless reservation. */
    machineId: z.string().optional(),
    /** Keyless reservations only designate; they never create a claim row. */
    claim: z.null(),
  }),
]);

/** {@inheritDoc SessionOwnershipReservationSchema} */
export type SessionOwnershipReservation = z.infer<typeof SessionOwnershipReservationSchema>;

/**
 * Result of `session.ownership.reserveStart`.
 *
 * There is no caller-supplied takeover input of any kind. A key whose
 * incumbent's agent row is `disposed` is taken over by a storage predicate
 * inside the reserving transaction; everything else that holds a key is
 * reported as `occupied`, and the caller degrades rather than dispatching.
 */
export const SessionOwnershipReserveStartServiceResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** The reservation committed; the caller may dispatch. */
    outcome: z.literal('reserved'),
    /** {@inheritDoc SessionOwnershipReservationSchema} */
    reservation: SessionOwnershipReservationSchema,
  }),
  z.object({
    /** Another generation holds the key; **do not dispatch a native resume**. */
    outcome: z.literal('occupied'),
    /** The generation that holds it. */
    holder: AdapterSessionClaimRecordSchema,
  }),
  z.object({
    /** Another start won the designation race; nothing was written. */
    outcome: z.literal('lead-conflict'),
    /** Lead the session actually names, or `null` when it has none. */
    currentLeadAgentId: z.string().nullable(),
  }),
  z.object({
    /** The agent was removed; ownership is absorbing on `disposed`. */
    outcome: z.literal('agent-disposed'),
  }),
  z.object({
    /** The session was closed, archived, or remains only discovered. */
    outcome: z.literal('session-not-active'),
    /** Actual stored session status observed by the reserving transaction. */
    status: z.enum(['closed', 'archived', 'discovered']),
  }),
  z.object({
    /** A row the reservation must reference does not exist. */
    outcome: z.literal('not-found'),
    /** Which referenced row is missing. */
    missing: z.enum(['session', 'agent']),
  }),
  z.object({
    /**
     * Service-availability outcome, never produced by storage: the authority
     * has no machine identity, so it declines to decide. Callers treat it
     * exactly like `occupied` — do not dispatch a native resume.
     */
    outcome: z.literal('machine-identity-unavailable'),
  }),
  SessionOwnershipRecoveryCurrencyChangedSchema,
  SessionOwnershipRecoveryConflictSchema,
]);

/** {@inheritDoc SessionOwnershipReserveStartServiceResponseSchema} */
export type SessionOwnershipReserveStartServiceResult = z.infer<
  typeof SessionOwnershipReserveStartServiceResponseSchema
>;

/**
 * A movement as the observation seam reports it, before the authority turns it
 * into a durable movement.
 *
 * Modeled as a real union rather than the seam's flag/ID pair: the pair is one
 * value, and a service surface that accepted the halves separately would have
 * to re-derive the invariant the seam's own refinement cannot carry across the
 * wire.
 */
export const SessionOwnershipServiceMovementSchema = z.discriminatedUnion('confirmed', [
  z.object({
    /** The provider acknowledged the conversation now lives at `providerSessionId`. */
    confirmed: z.literal(true),
    /** Provider session the conversation moved to. */
    providerSessionId: z.string(),
  }),
  z.object({
    /** The conversation left with no acknowledged successor; the currency demotes to `moved`. */
    confirmed: z.literal(false),
  }),
]);

/** {@inheritDoc SessionOwnershipServiceMovementSchema} */
export type SessionOwnershipServiceMovement = z.infer<typeof SessionOwnershipServiceMovementSchema>;

/**
 * Request payload for `session.ownership.settleMovement`.
 *
 * The authority reads the revision itself, because that is a per-attempt value
 * a caller cannot hold correctly across a retry, and the whole movement is one
 * storage transaction underneath.
 */
export const SessionOwnershipSettleMovementServiceRequestSchema = SessionOwnershipPrincipalSchema.extend({
  /** {@inheritDoc SessionOwnershipServiceMovementSchema} */
  movement: SessionOwnershipServiceMovementSchema,
  /**
   * Token to mint the successor generation under, supplied by the caller.
   *
   * The service minted this internally, which left a caller that has a rollback
   * to perform unable to name the generation its own settlement created: a
   * settle whose transaction commits but whose response is lost leaves a `held`
   * successor nobody can release. Storage has always taken the token from
   * outside — `OwnershipMovementSchema.claimToken` — so this exposes an
   * existing parameter one layer up rather than adding one.
   *
   * Omitted, the service mints as before: the movement observer has no cleanup
   * to perform and nothing to name.
   */
  claimToken: z.string().optional(),
});

/** {@inheritDoc SessionOwnershipSettleMovementServiceRequestSchema} */
export type SessionOwnershipSettleMovementServiceRequest = z.infer<
  typeof SessionOwnershipSettleMovementServiceRequestSchema
>;

/**
 * Result of `session.ownership.settleMovement`.
 *
 * The durable outcomes verbatim, plus the one outcome only the service can
 * produce. On `settled`, carry `claim` — the generation the settle actually
 * wrote through — into any later release, never the token the authority sent.
 */
export const SessionOwnershipSettleMovementServiceResponseSchema = z.discriminatedUnion('outcome', [
  ...SessionOwnershipSettleMovementResponseSchema.options,
  z.object({
    /** {@inheritDoc SessionOwnershipReserveStartServiceResponseSchema} */
    outcome: z.literal('machine-identity-unavailable'),
  }),
]);

/** {@inheritDoc SessionOwnershipSettleMovementServiceResponseSchema} */
export type SessionOwnershipSettleMovementServiceResult = z.infer<
  typeof SessionOwnershipSettleMovementServiceResponseSchema
>;

/**
 * Request payload for `session.ownership.release`.
 *
 * Naming a `claimToken` is the **rollback** form — it retires exactly the
 * generation the failed attempt took, and never a second, unrelated one the
 * agent may hold from an in-flight movement. Omitting it is the **teardown**
 * form, which is the only shape that can be complete: listing an agent's claims
 * and releasing them one by one cannot see a claim taken in between.
 *
 * The disposition is the caller's evidence and is never inferred here — only a
 * failure that provably never reached the provider may release cleanly.
 */
export const SessionOwnershipReleaseServiceRequestSchema = z.object({
  /** Agent whose claims are being given up. */
  agentId: z.string(),
  /** Scope the act to one generation; omitted, every claim of the agent is taken. */
  claimToken: z.string().optional(),
  /** {@inheritDoc AdapterSessionClaimDispositionSchema} */
  disposition: AdapterSessionClaimDispositionSchema,
});

/** {@inheritDoc SessionOwnershipReleaseServiceRequestSchema} */
export type SessionOwnershipReleaseServiceRequest = z.infer<typeof SessionOwnershipReleaseServiceRequestSchema>;

/**
 * Why reconcile judged a claim's owner gone.
 *
 * **Diagnostic only.** None of these authorizes a takeover: takeover is a
 * storage predicate over the incumbent's own rows, and it never looks at a
 * claim's reconcile verdict or at an adapter probe.
 */
export const SessionOwnershipReclaimReasonSchema = z.enum([
  'agent-gone',
  'agent-disposed',
  'adapter-instance-gone',
  'owner-instance-retired',
]);

/** {@inheritDoc SessionOwnershipReclaimReasonSchema} */
export type SessionOwnershipReclaimReason = z.infer<typeof SessionOwnershipReclaimReasonSchema>;

/** One claim as reconcile left it. */
export const SessionOwnershipReconciledClaimSchema = z.object({
  /** The claim, as it stands after the run. */
  claim: AdapterSessionClaimRecordSchema,
  /**
   * What the run did to this claim.
   *
   * - `retained` — no reason held; the claim stands untouched.
   * - `abandoned` — a reason held **and was filed on the row**. The claim
   *   carried here is the post-write row, so the report describes the store
   *   rather than the pre-write view the run started from.
   * - `vanished` — a reason held, but the generation was no longer there to
   *   file against: it was released, deleted, or repointed at another agent
   *   between the assessment and the write. Nothing was written, so it must not
   *   be reported as `abandoned` — the row an operator would go looking for
   *   does not carry that reason, and may not exist at all.
   */
  verdict: z.enum(['abandoned', 'retained', 'vanished']),
  /** {@inheritDoc SessionOwnershipReclaimReasonSchema} */
  reason: SessionOwnershipReclaimReasonSchema.optional(),
});

/** {@inheritDoc SessionOwnershipReconciledClaimSchema} */
export type SessionOwnershipReconciledClaim = z.infer<typeof SessionOwnershipReconciledClaimSchema>;

/**
 * Result of `session.ownership.reconcile`.
 *
 * Reconcile never deletes a row and never frees a key. Marking an
 * already-`abandoned` claim is a no-op, so repeated runs are idempotent by
 * construction.
 */
export const SessionOwnershipReconcileServiceResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** The run completed for this machine. */
    outcome: z.literal('reconciled'),
    /** Machine the run inspected. */
    machineId: z.string(),
    /** Every claim seen, with its verdict. */
    claims: z.array(SessionOwnershipReconciledClaimSchema),
  }),
  z.object({
    /** Nothing was inspected. */
    outcome: z.literal('skipped'),
    /** The authority has no machine identity, so it has no claim set to reason about. */
    reason: z.literal('machine-identity-unavailable'),
  }),
]);

/** {@inheritDoc SessionOwnershipReconcileServiceResponseSchema} */
export type SessionOwnershipReconcileServiceResult = z.infer<typeof SessionOwnershipReconcileServiceResponseSchema>;

/**
 * Request payload for `session.ownership.continuation`.
 *
 * Observing that a provider conversation continued is evidence the session is
 * still in use, which a `closed` row contradicts. Reporting the observation is
 * the caller's whole duty; deciding what it implies for the row is this
 * operation's.
 */
export const SessionOwnershipContinuationServiceRequestSchema = z.object({
  /** Session the continuation was observed for. */
  sessionId: z.string(),
  /** How the provider continued the conversation. */
  startMode: z.enum(['resume', 'compact']),
});

/** {@inheritDoc SessionOwnershipContinuationServiceRequestSchema} */
export type SessionOwnershipContinuationServiceRequest = z.infer<
  typeof SessionOwnershipContinuationServiceRequestSchema
>;

/**
 * Result of `session.ownership.continuation`.
 *
 * The reported `sessionId` is the row that was acted on, which is the lineage
 * root — not necessarily the row the caller named.
 */
export const SessionOwnershipContinuationServiceResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** A `closed` row was returned to `active`. */
    outcome: z.literal('reopened'),
    /** Row that was reopened. */
    sessionId: z.string(),
  }),
  z.object({
    /** The row already carried a status a continuation does not change. */
    outcome: z.literal('unchanged'),
    /** Row that was inspected. */
    sessionId: z.string(),
  }),
  z.object({
    /** No such session row. */
    outcome: z.literal('not-found'),
  }),
  z.object({
    /**
     * The named row is a compress child whose lineage does not lead to a row
     * carrying provider identity — a missing parent, a chain past the walk's
     * bound, or a cycle.
     *
     * Reported rather than acted on: every row such a walk can reach is itself
     * a synthesized compress child, and reopening one would leave the row that
     * actually holds the conversation closed.
     */
    outcome: z.literal('unresolved'),
    /** Row the caller named, which is where the broken lineage starts. */
    sessionId: z.string(),
  }),
]);

/** {@inheritDoc SessionOwnershipContinuationServiceResponseSchema} */
export type SessionOwnershipContinuationServiceResult = z.infer<
  typeof SessionOwnershipContinuationServiceResponseSchema
>;

/**
 * Session-ownership authority subjects.
 *
 * The service surface of the ownership aggregate: every operation here is
 * exactly one durable ownership act (§I5), so no caller ever composes one out
 * of a sequence of storage RPCs.
 */
export const SessionOwnershipSchemas = {
  /**
   * Reserve a start: take the claim on the provider session it will resume (or
   * none) and designate the lead, in one storage transaction.
   *
   * Subject: `session.ownership.reserveStart`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const result = await bus.request(SessionSubjects.ownership.reserveStart, {
   *   sessionId, agentId, adapterId, adapterName,
   *   role: 'lead', resumeProviderSessionId: null, expectedLeadAgentId: null,
   * });
   * // 'occupied' | 'agent-disposed' | 'machine-identity-unavailable' => do not dispatch.
   * ```
   */
  'ownership.reserveStart': {
    request: SessionOwnershipReserveStartServiceRequestSchema,
    response: SessionOwnershipReserveStartServiceResponseSchema,
  },

  /**
   * Record an observed provider-session movement against the agent that made
   * it: acquire or recognize the successor generation, settle the currency
   * under it, retire the predecessors it replaces and mirror onto the session
   * row when the agent leads.
   *
   * Subject: `session.ownership.settleMovement`
   * Type: Request (RPC)
   */
  'ownership.settleMovement': {
    request: SessionOwnershipSettleMovementServiceRequestSchema,
    response: SessionOwnershipSettleMovementServiceResponseSchema,
  },

  /**
   * Give up an agent's claims — one named generation, or every one it holds.
   *
   * Subject: `session.ownership.release`
   * Type: Request (RPC)
   */
  'ownership.release': {
    request: SessionOwnershipReleaseServiceRequestSchema,
    response: SessionOwnershipReleaseAgentClaimsResponseSchema,
  },

  /**
   * Inspect this machine's claims and file `abandoned` against the ones whose
   * owner is provably gone — diagnostics, never authority.
   *
   * Subject: `session.ownership.reconcile`
   * Type: Request (RPC)
   */
  'ownership.reconcile': {
    request: z.object({}),
    response: SessionOwnershipReconcileServiceResponseSchema,
  },

  /**
   * Report that a provider conversation continued, reopening the session when
   * the stored row says it is closed.
   *
   * Subject: `session.ownership.continuation`
   * Type: Request (RPC)
   */
  'ownership.continuation': {
    request: SessionOwnershipContinuationServiceRequestSchema,
    response: SessionOwnershipContinuationServiceResponseSchema,
  },
} satisfies SchemaRecord;
