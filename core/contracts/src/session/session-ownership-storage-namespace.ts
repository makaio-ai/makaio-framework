import { z } from 'zod';
import { createContractStorageNamespace } from '../storage-namespace-definition.js';
import {
  AdapterSessionCurrencySnapshotSchema,
  AdapterSessionCurrencyTargetSchema,
} from './schemas/adapter-session-currency.js';

/**
 * Lifecycle state of a durable ownership claim.
 *
 * The **existence** of a claim row is what blocks a competing owner; the status
 * records why it is still there:
 * - `held` — a live runtime owns the provider session.
 * - `releasing` — release was requested but the provider-side teardown is not
 *   confirmed. Still blocks: the runtime may yet be talking to the provider.
 * - `abandoned` — the owning runtime failed after dispatch. The row keeps
 *   blocking until an explicit takeover names its token, **or until the
 *   abandoned generation itself confirms clean teardown** by releasing under
 *   that same token. Deciding whether a takeover is legitimate is the ownership
 *   authority's duty (Wave 2), not storage's — storage records the conclusion
 *   and fences the previous generation out, it never evaluates the evidence
 *   behind it.
 *
 * That second exit is deliberate, not a hole in the first. `abandoned` is a
 * *presumption* that the owner died with teardown unconfirmed, filed by an
 * observer; it blocks everyone else because no one else can know. A clean
 * `released` presenting that generation's own token is the one party who can
 * know saying the provider session is done with, which refutes the presumption
 * outright — and the row's whole purpose, keeping a possibly-live provider
 * conversation from being attached to twice, is then served. A caller sending
 * `released` without having actually torn down is a caller bug of the same class
 * as reusing a `claimToken`, and is governed by the same doctrine (see
 * {@link SessionOwnershipClaimRequestSchema}'s `claimToken`).
 *
 * A clean release removes the row instead of marking it, so the unblocked case
 * is the absence of a row rather than a status a reader has to interpret.
 */
export const AdapterSessionClaimStatusSchema = z.enum(['held', 'releasing', 'abandoned']);

/** {@inheritDoc AdapterSessionClaimStatusSchema} */
export type AdapterSessionClaimStatus = z.infer<typeof AdapterSessionClaimStatusSchema>;

/**
 * Identity of the namespace a provider session is owned within.
 *
 * A provider session ID is only unique inside the runtime that stores it: the
 * same ID may exist on another machine, or under another adapter runtime on the
 * same machine, and those are different conversations. This triple is therefore
 * the ownership key, and the claim table's unique index over it is what makes
 * "exactly one winner" a property of the schema rather than of handler code.
 */
export const AdapterSessionClaimKeySchema = z.object({
  /** Stable runtime machine identity that owns the provider-native session store. */
  machineId: z.string(),
  /** Adapter runtime instance that owns the provider process. */
  adapterId: z.string(),
  /** Provider's own session/thread identifier. */
  providerSessionId: z.string(),
});

/** {@inheritDoc AdapterSessionClaimKeySchema} */
export type AdapterSessionClaimKey = z.infer<typeof AdapterSessionClaimKeySchema>;

/**
 * A durable ownership claim on one provider-native session.
 *
 * `claimToken` identifies the claim generation opaquely; `fence` orders
 * generations. The two always change together — a takeover mints a new token
 * and a higher fence — so a stale owner can be rejected by comparison
 * (`fence`) rather than by recognition (`claimToken`), which is what lets a
 * write arriving from a previous process be refused rather than applied.
 */
export const AdapterSessionClaimRecordSchema = AdapterSessionClaimKeySchema.extend({
  /** Stable identifier of the claim row. */
  claimId: z.string(),
  /**
   * Adapter type name of the owning runtime, carried for diagnostics.
   *
   * Informational only: the ownership key is the machine/adapter/provider
   * triple, and no operation here compares this field. Rejecting a foreign
   * adapter's provider ID — if that is ever wanted — is the ownership
   * authority's duty, not storage's.
   */
  adapterName: z.string(),
  /** Session the claiming agent belongs to. */
  sessionId: z.string(),
  /** Agent that owns the provider session under this claim. */
  agentId: z.string(),
  /** Opaque identity of the current claim generation. */
  claimToken: z.string(),
  /**
   * Generation counter, totally ordered **per agent**.
   *
   * Every allocation — a free acquisition as much as a takeover — puts the new
   * fence strictly above every fence that agent already carries: its
   * `currencyFence`, the fences of all claims it currently holds, and, on a
   * takeover, the superseded row's fence. So the fences one agent ever sees form
   * a strictly increasing sequence, which is what makes a settle from a
   * superseded generation comparable and refusable.
   *
   * It is deliberately *not* monotone per ownership key: a cleanly released key
   * carries no row, so a different agent may re-take it at a lower fence. That
   * is harmless, because a key is refused by absence of the caller's claim row
   * (`not-owner`), never by comparing fences across agents.
   */
  fence: z.number().int().positive(),
  /** {@inheritDoc AdapterSessionClaimStatusSchema} */
  status: AdapterSessionClaimStatusSchema,
  /** When the current generation took the claim. */
  claimedAt: z.number().int().nonnegative(),
  /** When the claim row last changed. */
  updatedAt: z.number().int().nonnegative(),
});

/** {@inheritDoc AdapterSessionClaimRecordSchema} */
export type AdapterSessionClaimRecord = z.infer<typeof AdapterSessionClaimRecordSchema>;

/**
 * Durable ownership state of one agent.
 *
 * `revision` and `currencyFence` are the two orderings a currency write is
 * checked against, and they answer different questions:
 * - `currencyFence` — *which generation* last wrote this currency. A write from
 *   a lower fence is a stale owner and is refused outright.
 * - `revision` — *which write* the caller read before computing its target. A
 *   mismatch means the row moved under the caller within the same generation.
 *
 * `revision` is bumped exclusively by the ownership seam. Any other writer
 * bumping it would make the compare-and-swap fail for reasons unrelated to
 * currency, which is the same as not having it.
 */
export const AgentSessionOwnershipRecordSchema = z.object({
  /** Agent the ownership state belongs to. */
  agentId: z.string(),
  /** Session the agent belongs to. */
  sessionId: z.string(),
  /** {@inheritDoc AdapterSessionCurrencySnapshotSchema} */
  currency: AdapterSessionCurrencySnapshotSchema,
  /** Compare-and-swap revision of the agent's currency. */
  revision: z.number().int().nonnegative(),
  /** Fence of the claim generation that last wrote this currency; 0 when never written. */
  currencyFence: z.number().int().nonnegative(),
  /**
   * Claims this agent currently holds.
   *
   * Normally zero or one. A movement is modeled as claim-new → settle →
   * release-old, so an agent legitimately holds two claims between those steps;
   * reporting a list keeps that intermediate state visible instead of forcing a
   * reader to guess which single claim is "the" claim.
   */
  claims: z.array(AdapterSessionClaimRecordSchema),
});

/** {@inheritDoc AgentSessionOwnershipRecordSchema} */
export type AgentSessionOwnershipRecord = z.infer<typeof AgentSessionOwnershipRecordSchema>;

// ─── claim ──────────────────────────────────────────────────────────────────

/**
 * Request payload for `storage:sessionOwnership.claim`.
 *
 * One call is the whole reservation: it takes the claim and — when
 * `designateLead` is supplied — designates the session's lead agent in the same
 * transaction. Splitting those into two calls is what leaves the window where a
 * provider session is owned by an agent the session does not yet call its lead,
 * and a movement announced in that window has no legitimate writer.
 */
export const SessionOwnershipClaimRequestSchema = AdapterSessionClaimKeySchema.extend({
  /** Adapter type name of the claiming runtime. */
  adapterName: z.string(),
  /**
   * Session the claiming agent belongs to.
   *
   * **Must be the agent's own session.** The pair is verified, not trusted: a
   * request naming an agent of one session under another session's ID is
   * `not-found` with `missing: 'agent'` — that agent does not exist *in that
   * session*, and no claim row is written. Trusting it would let a caller
   * record a claim under a session the owning agent has nothing to do with,
   * and — with `designateLead` — hand that session's lead to it.
   */
  sessionId: z.string(),
  /** Agent that will own the provider session. */
  agentId: z.string(),
  /**
   * Caller-minted identity for the claim generation being taken.
   *
   * Supplying it (rather than having storage mint one) is what makes the call
   * retry-safe: a repeated call by the same agent for the same session is
   * recognized as the same acquisition and reported as `idempotent` instead of
   * losing to itself.
   *
   * **Mint a fresh random token per claim attempt** — never reused across
   * ownership keys, agents or sessions. Uniqueness is enforced among *live*
   * claims: a unique index over the token refuses a second live claim carrying
   * one that is already stored, and that failure surfaces as an outright call
   * failure rather than a modeled outcome, on every backend.
   *
   * Retired generations are not remembered. A cleanly released claim's row is
   * deleted and a superseded one's token is overwritten by the takeover, so a
   * token that has been retired is storable again. Keeping a durable ledger of
   * every token ever used is the only way to close that, and it would grow
   * without bound for the life of the store to defend against a caller reusing
   * its own token — so single use is a caller obligation, not a storage
   * guarantee. Presenting a retired token again is a caller bug, and how it
   * interacts with later generations is undefined.
   */
  claimToken: z.string(),
  /**
   * Take over the named generation instead of acquiring a free key.
   *
   * A takeover is only ever the conclusion of a reconcile that established the
   * previous owner is gone — the storage seam does not decide abandonment, it
   * records the conclusion and fences the previous generation out.
   *
   * A takeover repoints the claim row at the taking agent, so it is held to the
   * same `(agent, session)` membership as a fresh acquisition and reports the
   * same `not-found` with `missing: 'agent'` when that pair does not exist — a
   * verdict reached against the state the takeover actually writes into, so an
   * agent moved away concurrently cannot be reported as `claimed` and then
   * refused by every settle that follows.
   *
   * A takeover that finds the named generation gone and the key free is
   * completed as an ordinary acquisition: `already-claimed` names the generation
   * that *now* holds the key, never the one the caller read before the call.
   */
  supersedes: z
    .object({
      /** Claim token the caller believes currently holds the key. */
      claimToken: z.string(),
    })
    .optional(),
  /**
   * Designate the claiming agent as the session's lead, compare-and-swap style.
   *
   * `expectedLeadAgentId` is the lead the caller read: `null` means "the session
   * has no lead yet". A session already led by `agentId` satisfies the
   * designation regardless of the expectation, so a retry is not a conflict.
   * Omitting the field leaves the lead designation untouched — that is the
   * member-agent case, and a member must never redirect the session.
   *
   * **A designation that actually promotes a new lead also mirrors that lead's
   * currency onto the session row**, in the same transaction. Session currency
   * is a persisted snapshot of the designated lead's currency, so a promotion
   * that left the previous lead's snapshot standing would publish a currency no
   * agent holds.
   *
   * The pair is **resolved onto the session row's own terms, not copied**:
   * `inherited` does not name a provider session, it points at the row's own
   * `adapterSessionId`, and a promoted member's origin is generally not the
   * session's. What the session row ends up carrying is exactly what
   * `resolveResumableAdapterSessionId` yields for the lead —
   * `inherited` when that is the session's own origin, `confirmed` naming the
   * lead's origin when it is a different one, and `moved` when the lead has
   * nothing resumable at all. `confirmed` and `moved` name their target
   * independently of the row's origin and are mirrored unchanged.
   *
   * The already-lead case writes nothing, and therefore mirrors nothing: the
   * snapshot it would refresh is `settleCurrency`'s to keep.
   */
  designateLead: z
    .object({
      /** Lead agent the caller expects to find, or `null` for "no lead yet". */
      expectedLeadAgentId: z.string().nullable(),
    })
    .optional(),
});

/** {@inheritDoc SessionOwnershipClaimRequestSchema} */
export type SessionOwnershipClaimRequest = z.infer<typeof SessionOwnershipClaimRequestSchema>;

/**
 * Result of `storage:sessionOwnership.claim`.
 *
 * `already-claimed` reports the holder rather than a bare failure: the caller's
 * next decision (degrade to fresh-with-history, reconcile, or fail the start)
 * depends on *who* holds it and in which state, and re-reading afterwards would
 * observe a different instant than the one that rejected the claim.
 */
export const SessionOwnershipClaimResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** The claim was taken by this call. */
    outcome: z.literal('claimed'),
    /** The claim as it now stands. */
    claim: AdapterSessionClaimRecordSchema,
    /** Whether this call wrote the session's lead designation. */
    leadDesignated: z.boolean(),
  }),
  z.object({
    /**
     * This exact generation already held the key for this agent and session — a
     * retry, not a race. A token presented by a *different* agent or for a
     * different session is `already-claimed`, never this.
     *
     * **The retry is revalidated, not trusted.** A stored claim row proves that
     * the generation was taken, never that it is still one the caller may work
     * under, so this outcome — and the lead designation it may carry — is
     * reported only while both still hold:
     * - the generation is still `held`. One marked `releasing` or `abandoned`
     *   is `already-claimed` naming its own row: it is no longer live for new
     *   work, yet it keeps blocking the key, so the caller is told who blocks
     *   it;
     * - the agent is still in the session the claim is filed under. One moved
     *   away by a whole-record write is `not-found` with `missing: 'agent'`,
     *   the same answer a fresh acquisition gets for that broken pair.
     *
     * Both refuse before the designation runs. `settleCurrency` rejects a
     * generation in either state, so promoting a lead off one would leave the
     * session naming a lead whose currency nothing may ever publish again.
     */
    outcome: z.literal('idempotent'),
    /** The claim as it stands. */
    claim: AdapterSessionClaimRecordSchema,
    /** Whether this call wrote the session's lead designation. */
    leadDesignated: z.boolean(),
  }),
  z.object({
    /** Another generation holds the key. */
    outcome: z.literal('already-claimed'),
    /** The generation that holds it. */
    holder: AdapterSessionClaimRecordSchema,
  }),
  z.object({
    /** The session's lead is not the one the caller expected; nothing was written. */
    outcome: z.literal('lead-conflict'),
    /** Lead agent the session actually names, or `null` when it has none. */
    currentLeadAgentId: z.string().nullable(),
  }),
  z.object({
    /** A row the claim must reference does not exist; nothing was written. */
    outcome: z.literal('not-found'),
    /**
     * Which referenced row is missing.
     *
     * `agent` covers the membership too: an agent that exists but belongs to a
     * different session than the request names is reported here, because what
     * the claim references — that agent, in that session — is what does not
     * exist. A session that does not exist at all is `session`, which is the
     * more specific answer and is therefore decided first.
     */
    missing: z.enum(['session', 'agent']),
  }),
]);

/** {@inheritDoc SessionOwnershipClaimResponseSchema} */
export type SessionOwnershipClaimResult = z.infer<typeof SessionOwnershipClaimResponseSchema>;

// ─── settleCurrency ─────────────────────────────────────────────────────────

/**
 * Request payload for `storage:sessionOwnership.settleCurrency`.
 *
 * The write is guarded twice, because two different things can be wrong. The
 * `claimToken` + `fence` pair answers "may this caller write at all"; the
 * `expectedRevision` answers "did the caller compute its target from the state
 * it is overwriting". A settle that passes the first and fails the second is a
 * lost race inside one generation, not a stale owner, and the caller's recovery
 * differs accordingly.
 */
export const SessionOwnershipSettleCurrencyRequestSchema = z.object({
  /** Agent whose currency is being settled. */
  agentId: z.string(),
  /** Claim generation the caller is writing under. */
  claimToken: z.string(),
  /** Fence of that generation, as the caller knows it. */
  fence: z.number().int().positive(),
  /** Revision the caller read before computing {@link SessionOwnershipSettleCurrencyRequestSchema.target}. */
  expectedRevision: z.number().int().nonnegative(),
  /** {@inheritDoc AdapterSessionCurrencyTargetSchema} */
  target: AdapterSessionCurrencyTargetSchema,
});

/** {@inheritDoc SessionOwnershipSettleCurrencyRequestSchema} */
export type SessionOwnershipSettleCurrencyRequest = z.infer<typeof SessionOwnershipSettleCurrencyRequestSchema>;

/**
 * Result of `storage:sessionOwnership.settleCurrency`.
 *
 * `sessionSnapshotUpdated` reports whether the session row's currency was
 * refreshed alongside the agent's. Storage decides that by reading the session's
 * lead designation inside the same transaction as the write — a caller that
 * checked lead-ness first and passed a flag would be acting on a read that the
 * write no longer agrees with.
 *
 * That refresh publishes the settled currency **resolved onto the session row's
 * own terms, not copied from `target`**, exactly as a lead designation does (see
 * {@link SessionOwnershipClaimRequestSchema}'s `designateLead`): `inherited`
 * points at the reading row's own `adapterSessionId`, and a lead's origin is
 * generally not its session's, so a verbatim copy would leave the session
 * resolving to its own origin while the lead resolves elsewhere. What the
 * session row ends up carrying is what `resolveResumableAdapterSessionId` yields
 * for the settled lead — so a settle of `inherited` can legitimately leave the
 * session row reading `confirmed` or `moved`.
 *
 * A missing claim is `not-owner`, not `not-found`: the agent exists, the caller
 * simply has no authority over it. Callers that need to report *who* owns it
 * instead read the claim through `listClaims`.
 *
 * Authority is decided before order: a caller whose claim row is gone is
 * `not-owner` even when its fence is also stale, because `superseded` names the
 * generation that outranked it and there is no such generation to name. The
 * authority a caller presents is the *pair* `claimToken` + `fence`, so a live
 * claim carrying a different fence than the caller named is `not-owner` too —
 * that pair never existed, and reporting `superseded` would have to name a
 * `currentFence` that outranks nothing (it may even be below the caller's own).
 *
 * A claim is an ownership of an agent *in a session*, so a claim filed under a
 * session the agent has since left is `not-owner` as well. Whole-record writes
 * can move an agent between sessions; a generation taken while it was in the old
 * one no longer represents any ownership of it, and settling under it would
 * publish its currency into a session its holder was never part of.
 * `release` deliberately does **not** apply that rule — see
 * {@link SessionOwnershipReleaseRequestSchema}.
 */
export const SessionOwnershipSettleCurrencyResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** The currency was written. */
    outcome: z.literal('settled'),
    /** Revision after the write. */
    revision: z.number().int().nonnegative(),
    /** {@inheritDoc AdapterSessionCurrencySnapshotSchema} */
    currency: AdapterSessionCurrencySnapshotSchema,
    /** Whether the session row's currency snapshot was refreshed too. */
    sessionSnapshotUpdated: z.boolean(),
  }),
  z.object({
    /** The stored currency already equals the target under this fence; nothing was written. */
    outcome: z.literal('idempotent'),
    /** Revision as it stands (unchanged). */
    revision: z.number().int().nonnegative(),
    /** {@inheritDoc AdapterSessionCurrencySnapshotSchema} */
    currency: AdapterSessionCurrencySnapshotSchema,
    /** Always `false` — an idempotent settle writes nothing. */
    sessionSnapshotUpdated: z.literal(false),
  }),
  z.object({
    /**
     * The caller's generation is older than the one that owns the currency.
     *
     * Reported only for a generation that genuinely exists and is genuinely
     * outranked: the caller's claim is live and carries the fence the caller
     * named, and that fence is below the one governing the agent's currency.
     * Any other refusal of the authority pair is `not-owner`.
     */
    outcome: z.literal('superseded'),
    /** Fence that currently governs the agent's currency. */
    currentFence: z.number().int().nonnegative(),
  }),
  z.object({
    /** The row moved within this generation since the caller read it. */
    outcome: z.literal('currency-changed'),
    /** Revision as it stands. */
    revision: z.number().int().nonnegative(),
    /** {@inheritDoc AdapterSessionCurrencySnapshotSchema} */
    currency: AdapterSessionCurrencySnapshotSchema,
  }),
  z.object({
    /** The caller holds no live claim on the agent's provider session. */
    outcome: z.literal('not-owner'),
  }),
  z.object({
    /** The agent row does not exist. */
    outcome: z.literal('not-found'),
  }),
]);

/** {@inheritDoc SessionOwnershipSettleCurrencyResponseSchema} */
export type SessionOwnershipSettleCurrencyResult = z.infer<typeof SessionOwnershipSettleCurrencyResponseSchema>;

// ─── release ────────────────────────────────────────────────────────────────

/**
 * How a claim is given up.
 *
 * - `released` — the provider session is provably done with; the row is removed
 *   and the key becomes claimable again.
 * - `releasing` — teardown started but is not confirmed; the row stays and keeps
 *   blocking.
 * - `abandoned` — the owner failed after dispatching to the provider; the row
 *   stays and keeps blocking until an explicit takeover names its token, or
 *   until that same generation later confirms teardown with a `released` of its
 *   own (see {@link AdapterSessionClaimStatusSchema}). Storage does not judge
 *   whether that takeover is legitimate.
 *
 * Only the first frees the key. A failure after dispatch must never take that
 * path: the provider process may still be alive, and a second owner attaching
 * to a live conversation is the exact outcome this aggregate exists to prevent.
 */
export const AdapterSessionClaimDispositionSchema = z.enum(['released', 'releasing', 'abandoned']);

/** {@inheritDoc AdapterSessionClaimDispositionSchema} */
export type AdapterSessionClaimDisposition = z.infer<typeof AdapterSessionClaimDispositionSchema>;

/**
 * Request payload for `storage:sessionOwnership.release`.
 *
 * The token and the agent are the whole of the authority, deliberately less than
 * `settleCurrency` asks for: that op additionally requires the claim to be filed
 * under the agent's *current* session, because it exercises the claim as
 * authority over that agent's currency. Giving a claim up needs no authority
 * beyond having been the one who took it. Demanding session membership here
 * would strand exactly the claims that most need retiring — an agent moved to
 * another session would leave its old generation unreleasable, blocking the
 * ownership key against everyone, forever.
 */
export const SessionOwnershipReleaseRequestSchema = z.object({
  /** Agent that holds the claim. */
  agentId: z.string(),
  /** Claim generation being given up. */
  claimToken: z.string(),
  /** {@inheritDoc AdapterSessionClaimDispositionSchema} */
  disposition: AdapterSessionClaimDispositionSchema,
});

/** {@inheritDoc SessionOwnershipReleaseRequestSchema} */
export type SessionOwnershipReleaseRequest = z.infer<typeof SessionOwnershipReleaseRequestSchema>;

/** Result of `storage:sessionOwnership.release`. */
export const SessionOwnershipReleaseResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** The claim row was removed and the key is claimable again. */
    outcome: z.literal('released'),
  }),
  z.object({
    /** The claim was marked and still blocks the key. */
    outcome: z.literal('marked'),
    /** The claim as it now stands. */
    claim: AdapterSessionClaimRecordSchema,
  }),
  z.object({
    /** The named generation is held by a different agent. */
    outcome: z.literal('not-owner'),
    /** The generation that holds it. */
    holder: AdapterSessionClaimRecordSchema,
  }),
  z.object({
    /** No claim carries the named token — already released, or never taken. */
    outcome: z.literal('not-found'),
  }),
]);

/** {@inheritDoc SessionOwnershipReleaseResponseSchema} */
export type SessionOwnershipReleaseResult = z.infer<typeof SessionOwnershipReleaseResponseSchema>;

// ─── listClaims ─────────────────────────────────────────────────────────────

/**
 * Request payload for `storage:sessionOwnership.listClaims`.
 *
 * `machineId` is mandatory because reconciliation is a per-machine act: a
 * runtime may only reason about liveness of owners on its own machine, and a
 * query that could span machines invites a takeover decision that has no
 * evidence behind it.
 */
export const SessionOwnershipListClaimsRequestSchema = z.object({
  /** Machine whose claims are being inspected. */
  machineId: z.string(),
  /** Narrow to one adapter runtime instance. */
  adapterId: z.string().optional(),
  /** Narrow to one provider session — the "who owns this thread" lookup. */
  providerSessionId: z.string().optional(),
  /** Narrow to specific lifecycle states; omitted means all. */
  statuses: z.array(AdapterSessionClaimStatusSchema).nonempty().optional(),
});

/** {@inheritDoc SessionOwnershipListClaimsRequestSchema} */
export type SessionOwnershipListClaimsRequest = z.infer<typeof SessionOwnershipListClaimsRequestSchema>;

/**
 * Session ownership storage namespace.
 *
 * The durable seam of the session-ownership aggregate. Its invariant:
 *
 * A provider-native session has exactly one durable runtime owner within its
 * machine/adapter namespace. Agent currency may only be changed by the current
 * claim generation. Session currency is a persisted snapshot of the designated
 * lead's currency.
 *
 * **Why a dedicated namespace.** `storage:session.update` is a partial-update
 * surface with no notion of who is allowed to write. Widening it with
 * compare-and-swap semantics would put a versioned-write contract on every
 * existing caller, turning one seam's concurrency problem into a storage-wide
 * one. The operations here are the narrow alternative: every one of them states
 * its authority up front, and they are the only writers of the agent currency
 * columns and of the claim table.
 *
 * **The one exception.** The session row's currency snapshot still has a second
 * writer: `storage:session.update` accepts `currentAdapterSessionId` /
 * `currentAdapterSessionIdState`, and the live adapter-session-currency handler
 * uses it. Until settlement is rewired through this seam, a session snapshot
 * written here can be overwritten there — the agent's currency, which is what
 * authority is actually checked against, cannot.
 * TODO(#1140): Wave 2 moves session-currency settlement onto
 * `settleCurrency` and drops those fields from `SessionStorageUpdateSchema`,
 * making this namespace the sole writer of the snapshot too.
 *
 * **Transactionality.** These handlers run multi-row writes inside
 * `executeTransaction` from `@makaio/storage-drizzle`, which is a deliberate
 * exception to the single-statement rule the other session storage handlers
 * follow. That rule exists because a bare `db.transaction()` holds a write lock
 * across await boundaries and deadlocks against concurrent handlers on the same
 * connection; `executeTransaction` closes exactly that hole by serializing
 * transaction callbacks per database handle before opening one, so a second
 * transaction queues instead of colliding at `BEGIN`. The serialization is
 * process-local by construction, which is why cross-process exclusivity is NOT
 * derived from it: "exactly one winner" comes from the claim table's unique
 * index over the ownership key, and the acquiring statement is an insert against
 * that index rather than a read-then-write. The transaction supplies atomicity
 * across the claim, agent and session rows; the index supplies exclusivity.
 * @example
 * ```typescript
 * import { SessionOwnershipStorageSubjects } from '@makaio/contracts';
 *
 * const result = await bus.request(SessionOwnershipStorageSubjects.claim, {
 *   machineId, adapterId, adapterName, providerSessionId,
 *   sessionId, agentId, claimToken,
 *   designateLead: { expectedLeadAgentId: null },
 * });
 * // 'already-claimed' means another runtime owns the thread: degrade, never resume.
 * ```
 */
export const SessionOwnershipStorageNamespace = createContractStorageNamespace('sessionOwnership', {
  schemas: {
    /**
     * Read one agent's durable ownership state.
     *
     * **Not a consistent snapshot**, in either direction: the agent row and its
     * claims are read as two statements, so a concurrent claim or release can
     * show up in one and not the other. A reader may therefore observe a claim
     * whose fence the agent's `currencyFence` does not yet account for, or a
     * `currencyFence` whose authoring claim has already been released. Both are
     * legitimate instants of the aggregate; a reader that needs authority must
     * ask for it (`settleCurrency`) rather than infer it from this read.
     *
     * Subject: `storage:sessionOwnership.read`
     * Type: Request (RPC)
     */
    read: {
      request: z.object({
        agentId: z.string(),
      }),
      response: z.object({
        ownership: AgentSessionOwnershipRecordSchema.nullable(),
      }),
    },

    /**
     * Take or take over the ownership claim on a provider session, optionally
     * designating the claiming agent as the session's lead in the same
     * transaction.
     *
     * Subject: `storage:sessionOwnership.claim`
     * Type: Request (RPC)
     */
    claim: {
      request: SessionOwnershipClaimRequestSchema,
      response: SessionOwnershipClaimResponseSchema,
    },

    /**
     * Write an agent's adapter-session currency under a claim generation, and
     * mirror it onto the session row when the agent is the designated lead.
     *
     * The columns this writes are authoritative storage state, but nothing
     * consumes them yet: a restarted member still resumes from the agent's
     * immutable `adapterSessionId`.
     * TODO(#1140): Wave 2 wires the SessionService ownership authority
     * (reserveStart / settleMovement / reconcile), and the resume-identity path
     * — `resolveAgentResumeIdentity` / `planAgentRecovery` — reads the settled
     * currency from there.
     *
     * Subject: `storage:sessionOwnership.settleCurrency`
     * Type: Request (RPC)
     */
    settleCurrency: {
      request: SessionOwnershipSettleCurrencyRequestSchema,
      response: SessionOwnershipSettleCurrencyResponseSchema,
    },

    /**
     * Give up a claim — freeing the ownership key only on a clean release.
     *
     * Subject: `storage:sessionOwnership.release`
     * Type: Request (RPC)
     */
    release: {
      request: SessionOwnershipReleaseRequestSchema,
      response: SessionOwnershipReleaseResponseSchema,
    },

    /**
     * List the claims recorded for a machine — the read reconciliation and
     * ownership diagnostics run on.
     *
     * Subject: `storage:sessionOwnership.listClaims`
     * Type: Request (RPC)
     */
    listClaims: {
      request: SessionOwnershipListClaimsRequestSchema,
      response: z.object({
        claims: z.array(AdapterSessionClaimRecordSchema),
      }),
    },
  },
});

/**
 * Typed subjects for session ownership storage operations.
 */
export const SessionOwnershipStorageSubjects = SessionOwnershipStorageNamespace.subjects;
