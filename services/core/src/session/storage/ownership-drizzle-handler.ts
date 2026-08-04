/**
 * Drizzle handlers for the `storage:sessionOwnership` namespace.
 *
 * The durable half of the session-ownership aggregate: exactly one runtime owns
 * a provider-native session within its machine/adapter namespace, agent currency
 * may only be written by the current claim generation, and the session row's
 * currency snapshot mirrors the designated lead's.
 *
 * **Transactions.** These handlers are a deliberate exception to the
 * single-statement rule the other session storage handlers follow (see the
 * `CONCURRENCY INVARIANT` note on `registerDrizzleSessionStorage`). That rule is
 * about a bare `db.transaction()`, which holds a write lock across `await`
 * boundaries and deadlocks against concurrent handlers on the same connection.
 * `executeTransaction` closes exactly that hole: it serializes transaction
 * callbacks per database handle before opening one, so a second transaction
 * queues instead of colliding at `BEGIN`.
 *
 * **Where exclusivity comes from.** That queue is process-local, so it is *not*
 * what makes ownership exclusive. `uniq_adapter_session_claims_owner` is: the
 * acquiring statement is a conditional INSERT against that index rather than a
 * read-then-write, so two processes racing for one provider session both attempt
 * the insert and exactly one wins. The transaction only supplies atomicity
 * across the claim, agent and session rows.
 *
 * **Statement order.** Every operation here writes first and reads only to
 * classify a write that landed on zero rows. A transaction that reads first and
 * writes later pins a snapshot the write must then be reconciled against, which
 * on a WAL-mode store is refused outright once another connection has committed
 * in between — and, worse, leaves a window in which another *process* can commit
 * between the read that granted authority and the write that used it (the
 * `executeTransaction` queue is process-local, so it cannot close that window).
 * Each write therefore carries its full authority in its own predicate: the
 * revision compare-and-swap, the claim generation, the session membership and
 * the lead designation are all conditions of the statement, never of a preceding
 * read.
 *
 * **The one lock.** Claim, settle and release each open by locking the agent's
 * row (`lockAgentAllocation`), which makes the agents row the single per-agent
 * serialization point of the whole state machine. A claim needs it because a
 * fence is ordered per agent while the unique indexes are per key and per token:
 * two processes claiming *different* keys for one agent have nothing to collide
 * on and would otherwise allocate the same fence. A settle and a release need it
 * because they are otherwise unordered against each other — the release never
 * touches the agents row, and the settle's authority `exists` keeps its
 * statement snapshot even when EvalPlanQual re-checks the locked agents row, so
 * a settle could commit against a claim the release had already deleted. Taking
 * the lock first makes every later statement of the operation a fresh READ
 * COMMITTED snapshot that sees whatever committed while it waited.
 *
 * **The second lock, and why it is not another agents row.** The agent lock
 * cannot order a settle against a concurrent *takeover*: a takeover moving a key
 * from agent A to agent B locks only B's row, so A's settle shares no lock with
 * it and its authority `exists` can still be running off a snapshot in which A's
 * claim is `held`. Locking both agents rows would fix that and introduce a worse
 * failure — two takeovers crossing in opposite directions would take the two
 * rows in opposite orders and deadlock. The settle therefore takes the one row
 * both operations genuinely have in common: it self-updates *its own claim row*
 * between the agent lock and its guarded UPDATE (`touchClaimGeneration`). A
 * takeover of that generation then blocks until the settle commits, and a settle
 * that lost the race is refused by that statement's own EvalPlanQual re-check —
 * a simple column comparison on the locked row, which is the only shape those
 * re-checks are reliable for.
 *
 * Both locks are serialization only — they grant no authority, and every
 * predicate below stays exactly as self-guarding as it is without them. What a
 * *zero-row* lock means differs per operation and is therefore decided at each
 * call site.
 *
 * **Statement order is agents → claims → sessions** in every operation of the
 * aggregate — claim, settle, movement and release alike — so no two of them can
 * take the three tables in opposite orders and deadlock. The settle's claim-row
 * touch sits inside that order rather than beside it — `agents` (own row) →
 * `claims` (own generation) → `agents` (already held) → `sessions` — and every
 * operation only ever locks *its own* agent's row, so a settle and a takeover
 * meet on the claim row alone, which both take after their agents row. There is
 * no cycle.
 *
 * **The keyless reservation is the one shape with an empty claims phase.** A
 * fresh start has no provider identity to own yet, so `claim` with
 * `providerSessionId: null` writes no claim row at all and its whole effect is
 * the lead designation and the currency mirror that goes with it — still one
 * transaction, still compare-and-swap. Its agent guards are stated against the
 * row `lockAgentAllocation` has already taken rather than as conjuncts of a
 * claim-table statement, because there is no such statement; the lock makes that
 * row unchangeable for the rest of the transaction, so the two are equally
 * self-guarding.
 * @packageDocumentation
 */
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipClaimResult,
  type SessionOwnershipReleaseAgentClaimsRequest,
  type SessionOwnershipReleaseAgentClaimsResult,
  type SessionOwnershipReleaseRequest,
  type SessionOwnershipReleaseResult,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { readClaimByKey, readClaimByToken } from './ownership-drizzle-reads.js';
import { runSettleCurrency } from './ownership-drizzle-settle.js';
import { runSettleMovement } from './ownership-drizzle-movement.js';
import {
  insertClaimGeneration,
  isIncumbentUnusable,
  resolveClaimTargets,
  takeOverClaimRow,
  type TakeoverAuthorization,
} from './ownership-drizzle-acquire.js';
import {
  buildAgentGuard,
  type AgentGuardMode,
  buildLeadCurrencyMirror,
  buildListClaimsPredicates,
  lockAgentAllocation,
  mapClaim,
  mapCurrency,
  type AgentRow,
  type ClaimAcquisition,
  type ClaimRow,
  type OwnershipTables,
  type OwnershipTransaction,
} from './ownership-drizzle-rows.js';

/** Handler dependencies for the session ownership handlers. */
interface OwnershipHandlerDeps {
  readonly bus: IMakaioBus;
  readonly db: MakaioDatabase;
}

/**
 * Rollback signal for a claim that must leave nothing written at all.
 *
 * Several refusals are decided after the claim row has already been written
 * inside the transaction, and all of them must leave no trace of it: a
 * `lead-conflict`, and a designation refused because the claiming agent is no
 * longer a live member of the session it names. Throwing is how that is
 * expressed: `executeTransaction` rolls the transaction back, and the handler
 * maps the sentinel to the modeled response outside it. The class is
 * module-private so the sentinel can never escape this seam as an error, and it
 * carries the whole modeled result rather than one outcome's fields, so a new
 * rollback reason needs no second class.
 */
class ClaimRollbackSignal extends Error {
  /** Modeled outcome to report once the transaction has rolled back. */
  public readonly result: SessionOwnershipClaimResult;

  /**
   * Create the rollback signal.
   * @param result - Modeled claim outcome to report after the rollback.
   */
  public constructor(result: SessionOwnershipClaimResult) {
    super(`session ownership claim rolled back: ${result.outcome}`);
    this.name = 'ClaimRollbackSignal';
    this.result = result;
  }
}

/** A claim request whose ownership key is present — everything but a keyless reservation. */
type KeyedClaimRequest = SessionOwnershipClaimRequest & ClaimAcquisition;

/** What the sessions phase of a claim established about the lead designation. */
interface LeadDesignationOutcome {
  /** Whether this call moved the session's lead designation. */
  readonly leadDesignated: boolean;
  /** Lead the session named inside this transaction, before any designation. */
  readonly previousLeadAgentId: string | null;
}

/**
 * Take the session row and read the lead it names, in one statement.
 *
 * The pre-image of the designation, and a lock: a self-assignment of
 * `last_activity_at` changes nothing, holds the row until the transaction ends,
 * and returns the value the designating UPDATE will find. The same idiom as
 * `touchClaimGeneration` one table down, for the same reason — a plain SELECT
 * would leave `previousLeadAgentId` a snapshot another process may already have
 * moved past, and a rollback that restored *that* value would undo a designation
 * this caller never observed.
 *
 * It runs on every path that can end in a claim, whether or not a designation
 * was requested, so `previousLeadAgentId` is always honest.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param sessionId - Session whose designation is being taken.
 * @returns The lead the session names, `null` when it has none, `undefined` when
 *   the session row does not exist.
 */
async function touchSessionLead(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  sessionId: string,
): Promise<string | null | undefined> {
  const { sessions } = tables;
  const [row] = await tx
    .update(sessions)
    .set({ lastActivityAt: sessions.lastActivityAt })
    .where(eq(sessions.sessionId, sessionId))
    .returning({ leadAgentId: sessions.leadAgentId });
  return row === undefined ? undefined : (row.leadAgentId ?? null);
}

/**
 * The compare-and-swap the designation writes through.
 *
 * A designation matches the lead the caller named, or the agent it is already
 * pointing at — so a retry is not a conflict. A **clear** drops that second
 * disjunct: unsetting is never idempotent-by-self-match, and admitting it would
 * let a clear whose expectation is stale erase a designation that has moved on.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the designation.
 * @param expected - Lead the caller expects to find, or `null` for "none yet".
 * @param clearing - Whether the designation unsets the lead.
 * @returns Predicate for the designating UPDATE.
 */
function buildDesignationCas(
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  expected: string | null,
  clearing: boolean,
): SQL | undefined {
  const { sessions } = tables;
  const matchesExpectation = expected === null ? isNull(sessions.leadAgentId) : eq(sessions.leadAgentId, expected);
  return clearing ? matchesExpectation : or(matchesExpectation, eq(sessions.leadAgentId, payload.agentId));
}

/**
 * Run the sessions phase of a claim: take the designation, then move it.
 *
 * Runs after the claim decision, so a key held by another generation is reported
 * as `already-claimed` even when the lead expectation is also wrong.
 *
 * A designation that actually promotes a new lead publishes that lead's resolved
 * currency onto the session row in the same statement
 * ({@link buildLeadCurrencyMirror}), because the session snapshot is defined as
 * the designated lead's currency — leaving the previous lead's pair standing
 * would publish a currency no agent holds, and the promoted agent's own settle
 * may never run again if it has nothing left to move. Two cases deliberately
 * mirror nothing: the already-lead retry, whose snapshot is the settle's to
 * keep, and a **clear**, which leaves the last lead's snapshot standing rather
 * than falling back to the row's own origin — an origin the departed lead had
 * generally already moved away from.
 *
 * **The designating UPDATE carries its agent guard itself**, as an `exists` over
 * the agents table rather than as trust in the claim write that preceded it.
 * Nothing in this transaction pins the agents row against a whole-record write
 * that moves the claiming agent to another session, after which the session
 * would name a lead that belongs elsewhere and every later settle would refuse
 * it as `not-owner`. A designation additionally demands the agent be live, so a
 * removed agent can never be made — or kept — lead. A **clear** demands
 * membership only: unsetting a departed lead is giving authority up, and the one
 * caller that does it is the removal handler, which has already marked the agent
 * `disposed`.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the optional designation.
 * @returns What the sessions phase established.
 * @throws When the session is gone or the designation is refused, so the
 *   enclosing transaction rolls back and nothing at all is written.
 */
async function applyLeadDesignation(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<LeadDesignationOutcome> {
  const { sessions } = tables;
  const previousLeadAgentId = await touchSessionLead(tx, tables, payload.sessionId);
  if (previousLeadAgentId === undefined) {
    throw new ClaimRollbackSignal({ outcome: 'not-found', missing: 'session' });
  }
  const designation = payload.designateLead;
  if (designation === undefined) return { leadDesignated: false, previousLeadAgentId };

  const clearing = designation.clear === true;
  const target = clearing ? null : payload.agentId;
  const guard: AgentGuardMode = clearing ? 'any-status' : 'live';
  // The touch above locked the session row, so `previousLeadAgentId` is exactly
  // what this statement will find: whether the designation *moves* is decided
  // here rather than read back afterwards, and it is what governs the mirror.
  const promotes = target !== previousLeadAgentId;

  const matched = await tx
    .update(sessions)
    .set({
      leadAgentId: target,
      ...(clearing || !promotes ? {} : buildLeadCurrencyMirror(tables, payload.agentId)),
    })
    .where(
      and(
        eq(sessions.sessionId, payload.sessionId),
        buildDesignationCas(tables, payload, designation.expectedLeadAgentId, clearing),
        buildAgentGuard(tables, payload.agentId, payload.sessionId, guard),
      ),
    )
    .returning({ leadAgentId: sessions.leadAgentId });

  if (matched.length === 0) return refuseDesignation(tx, tables, payload, previousLeadAgentId, guard);
  return { leadDesignated: promotes, previousLeadAgentId };
}

/**
 * Name the modeled `lead-conflict` outcome.
 * @param currentLeadAgentId - Lead the session actually names, or `null`.
 * @returns The `lead-conflict` result.
 */
function leadConflict(currentLeadAgentId: string | null): SessionOwnershipClaimResult {
  return { outcome: 'lead-conflict', currentLeadAgentId };
}

/**
 * Explain a designation whose UPDATE matched no row, and roll the claim back.
 *
 * Two predicates can have refused it, and the order they are read back in is
 * what the answers mean. The agent guard is asked first, through the same
 * {@link resolveClaimTargets} every other path uses: a `(agent, session)` pair
 * that no longer exists is `not-found` and a removed agent is `agent-disposed`,
 * and the claim this transaction took earlier must not survive half-designated —
 * an agent that left the session mid-flight owns nothing in it. Only once that
 * pair still holds can the lead expectation be what refused, and the lead as the
 * locked row carries it is what the caller is told.
 *
 * A **clear** never guarded on liveness, so a disposed agent cannot be the
 * reason its CAS failed and must not be reported as one.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the designation.
 * @param previousLeadAgentId - Lead read under this transaction's row lock.
 * @param guard - What the designating statement demanded of the agent.
 * @returns Never: the refusal is always thrown, so the transaction rolls back.
 * @throws Always — {@link ClaimRollbackSignal} carrying the modeled refusal.
 */
async function refuseDesignation(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  previousLeadAgentId: string | null,
  guard: AgentGuardMode,
): Promise<never> {
  const targets = await resolveClaimTargets(tx, tables, payload);
  if (targets.kind === 'refused') {
    // A clear never guarded on liveness, so a removed agent cannot be why its
    // CAS failed — reporting it would send the caller after a refusal that is
    // not there.
    const disposalIsIrrelevant = guard === 'any-status' && targets.result.outcome === 'agent-disposed';
    if (!disposalIsIrrelevant) throw new ClaimRollbackSignal(targets.result);
  }
  throw new ClaimRollbackSignal(leadConflict(previousLeadAgentId));
}

/**
 * Report a claim that was taken, or recognized as already taken.
 * @param outcome - Whether this call took the generation or found its own.
 * @param claim - The generation as it now stands, or `null` for a keyless reservation.
 * @param lead - What the sessions phase established.
 * @returns The modeled claim outcome.
 */
function takenClaim(
  outcome: 'claimed' | 'idempotent',
  claim: ClaimRow | null,
  lead: LeadDesignationOutcome,
): SessionOwnershipClaimResult {
  return {
    outcome,
    claim: claim === null ? null : mapClaim(claim),
    leadDesignated: lead.leadDesignated,
    previousLeadAgentId: lead.previousLeadAgentId,
  };
}

/**
 * Take the incumbent generation over, and classify a takeover that wrote nothing.
 *
 * The write itself is {@link takeOverClaimRow}, which carries the whole
 * authority. A zero-row UPDATE is then classified against the key as it stands
 * *now* — never against the row the classifying read produced:
 * - the key still carries the very generation that was named: the CAS held and
 *   it was the agent guard, or the incumbent's disposal, that refused. A broken
 *   `(agent, session)` pair or a removed taker is named by
 *   {@link resolveClaimTargets}; an incumbent that is no longer disposed leaves
 *   nothing to report but the holder;
 * - the key carries a different generation: it moved on, which is
 *   `already-claimed` naming *that* holder;
 * - the key carries nothing at all: the named generation was released while this
 *   transaction ran. There is no holder to report and none may be fabricated
 *   from the pre-read row, so the attempt starts over as the acquisition it now
 *   is — the key is free, and the acquiring INSERT is fully self-guarding.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request taking the key over.
 * @param incumbent - Claim row currently holding the key.
 * @param authorization - What permits repointing the incumbent.
 * @param now - Takeover timestamp.
 * @returns The claim outcome, or {@link RETRY_ACQUISITION} when the key is free.
 * @throws When the accompanying lead designation is refused.
 */
async function takeOverClaim(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: KeyedClaimRequest,
  incumbent: ClaimRow,
  authorization: TakeoverAuthorization,
  now: number,
): Promise<SessionOwnershipClaimResult | typeof RETRY_ACQUISITION> {
  const updated = await takeOverClaimRow(tx, tables, payload, incumbent, authorization, now);
  if (updated !== undefined) return takenClaim('claimed', updated, await applyLeadDesignation(tx, tables, payload));

  const holder = await readClaimByKey(tx, tables, payload);
  if (holder === undefined) return RETRY_ACQUISITION;
  if (holder.claimToken === incumbent.claimToken) {
    const targets = await resolveClaimTargets(tx, tables, payload);
    if (targets.kind === 'refused') return targets.result;
  }
  return { outcome: 'already-claimed', holder: mapClaim(holder) };
}

/**
 * Report a retry of the acquisition whose generation already holds the key.
 *
 * The stored row is evidence that this generation was taken, never that it is
 * still one the caller may work under, so the retry is revalidated against the
 * state as it stands now rather than trusted:
 * - a generation that is no longer `held` is `already-claimed` with its own row
 *   as the holder. It is not live for new work — a settle refuses it — yet its
 *   row keeps blocking the key, so the caller is told who blocks it;
 * - a claiming agent that has since been moved to another session is
 *   `not-found` with `missing: 'agent'`, and one that has since been removed is
 *   `agent-disposed` — the same answers every other path gives, through the same
 *   {@link resolveClaimTargets}.
 *
 * Both refuse before {@link applyLeadDesignation} runs. Designating a lead off a
 * generation that has lost its settle authority is exactly the state the settle
 * guards were added to refuse: the session would name a lead whose currency
 * nothing may ever publish again.
 *
 * The retry writes no claim, so a conflicting designation has nothing to roll
 * back — the generation the caller already holds stays untouched.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request repeating the holder's token.
 * @param existing - Claim row currently holding the key.
 * @returns The claim outcome for the retry.
 * @throws When the accompanying lead designation conflicts.
 */
async function repeatClaim(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: KeyedClaimRequest,
  existing: ClaimRow,
): Promise<SessionOwnershipClaimResult> {
  if (existing.status !== 'held') return { outcome: 'already-claimed', holder: mapClaim(existing) };

  const targets = await resolveClaimTargets(tx, tables, payload);
  if (targets.kind === 'refused') return targets.result;

  return takenClaim('idempotent', existing, await applyLeadDesignation(tx, tables, payload));
}

/**
 * Signal that the key this attempt aimed at is free again, so nothing can be
 * classified and the attempt must simply be repeated.
 *
 * Raised by the acquisition that lost its key to a competitor which has since
 * let it go, and by a takeover whose incumbent was released while the
 * transaction ran. Both mean the same thing: there is no holder to report, and
 * the next attempt is an ordinary acquisition of a free key.
 */
const RETRY_ACQUISITION = Symbol('retry-acquisition');

/**
 * Decide what, if anything, permits taking the incumbent's key.
 *
 * The token the caller named comes first: it is an explicit conclusion about a
 * specific generation, and honouring it regardless of the incumbent's state is
 * what `supersedes` means. Failing that, an incumbent whose owning agent is
 * `disposed` is taken over unconditionally — a removed agent can never
 * legitimately hold a key, so no caller evidence is needed or wanted.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request contending for the key.
 * @param incumbent - Claim row currently holding it.
 * @returns What authorizes the takeover, or `undefined` when nothing does.
 */
async function resolveTakeoverAuthorization(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: KeyedClaimRequest,
  incumbent: ClaimRow,
): Promise<TakeoverAuthorization | undefined> {
  if (payload.supersedes?.claimToken === incumbent.claimToken) return 'named-token';
  return (await isIncumbentUnusable(tx, tables, incumbent)) ? 'incumbent-disposed' : undefined;
}

/**
 * Attempt one acquisition of the ownership key.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request naming an ownership key.
 * @param now - Acquisition timestamp.
 * @returns The modeled claim outcome, or {@link RETRY_ACQUISITION} when the key
 *   was taken and freed again between the insert and the classifying read.
 * @throws When the accompanying lead designation conflicts.
 */
async function attemptAcquisition(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: KeyedClaimRequest,
  now: number,
): Promise<SessionOwnershipClaimResult | typeof RETRY_ACQUISITION> {
  const inserted = await insertClaimGeneration(tx, tables, payload, now);
  if (inserted !== undefined) return takenClaim('claimed', inserted, await applyLeadDesignation(tx, tables, payload));

  const existing = await readClaimByKey(tx, tables, payload);
  if (existing === undefined) {
    // The insert produced no row and nothing holds the key. Either a guard in
    // the acquiring SELECT did not hold — a missing row, an agent that is not a
    // member of the named session, or one that has been removed — or a
    // competitor took the key and released it again between the two statements
    // (reachable across processes on Postgres). Only the reads can tell those
    // apart, and every guard the SELECT states must be read back here: one left
    // out would be reported as contention instead, and the retry loop would spin
    // on it and then throw.
    const targets = await resolveClaimTargets(tx, tables, payload);
    return targets.kind === 'refused' ? targets.result : RETRY_ACQUISITION;
  }

  if (existing.claimToken === payload.claimToken) {
    // A token match is only this caller's own retry while the row still names
    // the same agent and session. A token presented by anyone else is a
    // competitor holding the key — never an idempotent success that would also
    // let it run the lead designation. What such a retry is still allowed to do
    // is `repeatClaim`'s to decide.
    if (existing.agentId === payload.agentId && existing.sessionId === payload.sessionId) {
      return repeatClaim(tx, tables, payload, existing);
    }
    return { outcome: 'already-claimed', holder: mapClaim(existing) };
  }

  const authorization = await resolveTakeoverAuthorization(tx, tables, payload, existing);
  if (authorization === undefined) return { outcome: 'already-claimed', holder: mapClaim(existing) };
  return takeOverClaim(tx, tables, payload, existing, authorization, now);
}

/**
 * Reserve a start that has no ownership key yet.
 *
 * The whole effect is the lead designation and its currency mirror: a fresh
 * start's provider identity does not exist until the provider mints it, so there
 * is nothing to own — but the designation still has to be atomic, compare-and-
 * swap and mirrored, and a designation written through a second RPC is none of
 * those things.
 *
 * The claims phase is therefore empty: no row, no fence, no token stored. The
 * agent guards that every keyed path states inside its claim-table statements
 * are stated here against the row {@link lockAgentAllocation} has already
 * locked, which no other transaction can change until this one ends.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying no provider session.
 * @param agent - The locked agent row.
 * @returns The modeled claim outcome.
 * @throws When the accompanying lead designation is refused.
 */
async function runKeylessReservation(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  agent: AgentRow,
): Promise<SessionOwnershipClaimResult> {
  if (agent.sessionId !== payload.sessionId) return { outcome: 'not-found', missing: 'agent' };
  // A reservation whose only act is a `clear` is giving authority up, which is
  // the one ownership act a removed agent must still be able to perform — the
  // removal handler marks the agent `disposed` before unsetting its designation.
  if (agent.status === 'disposed' && payload.designateLead?.clear !== true) {
    return { outcome: 'agent-disposed' };
  }
  return takenClaim('claimed', null, await applyLeadDesignation(tx, tables, payload));
}

/** The claiming agent's locked row, or the refusal to report instead. */
type LockedClaimant =
  | { readonly kind: 'ok'; readonly agent: AgentRow }
  | { readonly kind: 'refused'; readonly result: SessionOwnershipClaimResult };

/**
 * Open the claim on the claiming agent's row.
 *
 * **Zero rows locked is terminal for a claim.** With no agent row there is
 * nothing to hold the lock on, and under READ COMMITTED the agent can be
 * inserted and committed *after* this statement — two claims that both missed
 * the lock would then allocate a fence against the newly visible row
 * unserialized, and the `(agent_id, fence)` index would refuse one of them as a
 * raw constraint error instead of a modeled outcome. So the claim is refused,
 * and {@link resolveClaimTargets} names the refusal in contract precedence. The
 * one exception: the agent was committed between the lock and that read — then a
 * row exists now, and locking it restores serialization.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request.
 * @returns The locked agent row, or the refusal to report.
 */
async function lockClaimingAgent(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<LockedClaimant> {
  const locked = await lockAgentAllocation(tx, tables, payload.agentId);
  if (locked !== undefined) return { kind: 'ok', agent: locked };

  const targets = await resolveClaimTargets(tx, tables, payload);
  if (targets.kind === 'refused') return { kind: 'refused', result: targets.result };

  const relocked = await lockAgentAllocation(tx, tables, payload.agentId);
  // Gone again between the read and the second lock: at the lock's instant no
  // agent existed, and that instant is the verdict — an unlocked allocation is
  // never an option.
  if (relocked === undefined) return { kind: 'refused', result: { outcome: 'not-found', missing: 'agent' } };
  return { kind: 'ok', agent: relocked };
}

/**
 * Take or take over the ownership claim on a provider session — or reserve a
 * start that has no provider session yet.
 * @param db - Database handle.
 * @param payload - Claim request.
 * @returns The modeled claim outcome.
 * @throws When a competitor keeps taking and freeing the key faster than this
 *   call can acquire it. Sustained contention of that shape is not a modeled
 *   outcome — no row is missing and no holder exists to report — so it surfaces
 *   as a failure the caller retries, rather than as a fabricated `not-found`.
 */
async function runClaim(
  db: MakaioDatabase,
  payload: SessionOwnershipClaimRequest,
): Promise<SessionOwnershipClaimResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const now = Date.now();

  try {
    return await executeTransaction(db, async (tx): Promise<SessionOwnershipClaimResult> => {
      const claimant = await lockClaimingAgent(tx, tables, payload);
      if (claimant.kind === 'refused') return claimant.result;

      const { providerSessionId } = payload;
      if (providerSessionId === null) return runKeylessReservation(tx, tables, payload, claimant.agent);

      const keyed: KeyedClaimRequest = { ...payload, providerSessionId };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await attemptAcquisition(tx, tables, keyed, now);
        if (result !== RETRY_ACQUISITION) return result;
      }
      throw new Error(
        `session ownership claim could not be acquired: the key ${payload.machineId}/${payload.adapterId}/${providerSessionId} was taken and freed by a competitor on every attempt`,
      );
    });
  } catch (error) {
    if (error instanceof ClaimRollbackSignal) return error.result;
    throw error;
  }
}

/**
 * Give up a claim.
 *
 * Only a clean release removes the row and frees the ownership key. `releasing`
 * and `abandoned` keep blocking it, because the provider process may still be
 * alive and a second owner attaching to a live conversation is the outcome this
 * aggregate exists to prevent.
 *
 * Write-first, for the same reason as the settle: the whole authority — the
 * generation's token *and* the agent that owns it — is the write's own
 * predicate, so a takeover committed by another process in between cannot let a
 * caller give up a generation it no longer holds. A read only follows a write
 * that matched nothing, to tell `not-found` from `not-owner`.
 *
 * **Asymmetry with `settleCurrency`, deliberately.** The settle additionally
 * requires the claim to be filed under the agent's *current* session; the
 * release does not. The two ops need different things from a claim. A settle
 * exercises the claim as authority over an agent's currency, so a claim that no
 * longer represents an ownership of that agent's session may not carry it. A
 * release only gives the claim up, and giving something up needs no authority
 * beyond having been the one who took it — token plus agent. Requiring session
 * membership here would strand exactly the claims that most need retiring: an
 * agent reassigned to another session would leave its old generation
 * unreleasable, blocking the ownership key against everyone, forever.
 *
 * **The release nevertheless opens on the agents row** ({@link lockAgentAllocation}),
 * even though it writes nothing there. Without it a release and a concurrent
 * `settleCurrency` by the same agent are unordered: the settle's authority
 * `exists` over the claim table is a plain subquery, and a subquery keeps its
 * statement's READ COMMITTED snapshot even where EvalPlanQual re-checks the
 * agents row it locks — so a settle that began while the claim was still `held`
 * could commit *after* this release had already freed the key, writing currency
 * under a generation that no longer exists. Sharing the agent lock puts the two
 * in a defined order, and whichever runs second sees the first's committed
 * effect in a fresh snapshot.
 * @param db - Database handle.
 * @param payload - Release request.
 * @returns The modeled release outcome.
 */
async function runRelease(
  db: MakaioDatabase,
  payload: SessionOwnershipReleaseRequest,
): Promise<SessionOwnershipReleaseResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const { adapterSessionClaims } = tables;
  const now = Date.now();

  return executeTransaction(db, async (tx): Promise<SessionOwnershipReleaseResult> => {
    // **Zero rows locked is not terminal here**, unlike in a claim. A release
    // allocates no fence, so there is nothing an unserialized run could get
    // wrong — and a claim whose agent row is gone must stay releasable, or its
    // row would block the ownership key against everyone forever. With no agent
    // row there is also no settle left that could race this release: every
    // settle refuses an agent that does not exist.
    await lockAgentAllocation(tx, tables, payload.agentId);

    const generation = and(
      eq(adapterSessionClaims.claimToken, payload.claimToken),
      eq(adapterSessionClaims.agentId, payload.agentId),
    );

    if (payload.disposition === 'released') {
      // **The row is deleted, not tombstoned.** A retired token therefore
      // becomes storable again, and nothing here would refuse a caller that
      // presents it a second time. The alternative — keeping every retired
      // generation as a durable ledger row — grows without bound for the life of
      // the store, and buys protection against exactly one thing: a caller
      // reusing a token it minted itself. The contract makes tokens fresh random
      // per attempt (see `claimToken`), so that guard belongs to the caller, and
      // the storage side keeps the key free the moment it is genuinely free.
      //
      // **The predicate names token and agent only — never the status — and
      // that is deliberate.** A generation already marked `abandoned` is
      // therefore released cleanly by a delayed `released` of its own, which
      // looks like it bypasses "blocks until a takeover" and does not:
      // `abandoned` is a *presumption* filed by an observer that the owner died
      // with teardown unconfirmed, and it blocks everyone else precisely because
      // no one else can know. A `released` carrying that generation's own token
      // is the one party who can know refuting it, and the row's purpose —
      // keeping a possibly-live provider conversation from being attached to
      // twice — is then fulfilled, not bypassed. Adding a status condition here
      // would instead strand the key: the owner that came back to confirm its
      // own teardown would have no way to say so.
      const deleted = await tx
        .delete(adapterSessionClaims)
        .where(generation)
        .returning({ claimId: adapterSessionClaims.claimId });
      if (deleted.length > 0) return { outcome: 'released' };
    } else {
      const [marked] = await tx
        .update(adapterSessionClaims)
        .set({ status: payload.disposition, updatedAt: now })
        .where(generation)
        .returning();
      if (marked !== undefined) return { outcome: 'marked', claim: mapClaim(marked) };
    }

    // Nothing was given up: either no claim carries the token at all, or one
    // does and it belongs to somebody else.
    const claim = await readClaimByToken(tx, tables, payload.claimToken);
    return claim === undefined ? { outcome: 'not-found' } : { outcome: 'not-owner', holder: mapClaim(claim) };
  });
}

/**
 * Give up every claim an agent holds, or exactly one of them.
 *
 * **One statement over `agent_id`, never a read followed by per-claim releases.**
 * A teardown that lists an agent's claims and retires them one by one cannot see
 * a claim taken between the list and the last release — and an agent
 * legitimately holds two mid-movement, so that window is not hypothetical.
 * A single predicate retires whatever is there at the instant it runs, which is
 * the only shape that can be complete.
 *
 * Naming a token scopes the act to one generation, which is the rollback form: a
 * start that failed before dispatch gives up the generation it took and nothing
 * else, because the agent may hold a second one from an unrelated in-flight
 * movement.
 *
 * **Not `disposed`-guarded**, unlike every operation that *takes* authority.
 * Giving a claim up is the one act a removed agent must still perform; guarding
 * it would strand exactly the claims that most need retiring. For the same
 * reason the agent lock is taken but a zero-row lock is not terminal: a claim
 * whose agent row is already gone must still be releasable.
 * @param db - Database handle.
 * @param payload - Release request naming an agent and optionally one generation.
 * @returns What was retired, and whether a named token matched nothing.
 */
async function runReleaseAgentClaims(
  db: MakaioDatabase,
  payload: SessionOwnershipReleaseAgentClaimsRequest,
): Promise<SessionOwnershipReleaseAgentClaimsResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const { adapterSessionClaims } = tables;
  const now = Date.now();

  return executeTransaction(db, async (tx): Promise<SessionOwnershipReleaseAgentClaimsResult> => {
    await lockAgentAllocation(tx, tables, payload.agentId);

    const scope =
      payload.claimToken === undefined
        ? eq(adapterSessionClaims.agentId, payload.agentId)
        : and(
            eq(adapterSessionClaims.agentId, payload.agentId),
            eq(adapterSessionClaims.claimToken, payload.claimToken),
          );

    if (payload.disposition === 'released') {
      const deleted = await tx
        .delete(adapterSessionClaims)
        .where(scope)
        .returning({ providerSessionId: adapterSessionClaims.providerSessionId });
      return {
        releasedProviderSessionIds: deleted.map((row) => row.providerSessionId),
        markedClaims: [],
        claimTokenNotFound: payload.claimToken !== undefined && deleted.length === 0,
      };
    }

    const marked = await tx
      .update(adapterSessionClaims)
      .set({ status: payload.disposition, updatedAt: now })
      .where(scope)
      .returning();
    return {
      releasedProviderSessionIds: [],
      markedClaims: marked.map(mapClaim),
      claimTokenNotFound: payload.claimToken !== undefined && marked.length === 0,
    };
  });
}

/**
 * Register handler for `storage:sessionOwnership.read`.
 *
 * Two statements rather than a transaction, and therefore **not a consistent
 * snapshot in either direction**: a concurrent claim can leave a claim the
 * agent's `currencyFence` does not yet account for, and a concurrent release can
 * leave a `currencyFence` whose authoring claim is already gone. Both are
 * legitimate instants of the aggregate — a reader that needs authority asks
 * `settleCurrency` for it rather than inferring it here — so paying for a
 * transaction on a diagnostic read would buy nothing.
 * @param deps - Handler dependencies (bus and db).
 * @returns Cleanup function to unsubscribe the handler.
 */
function registerReadHandler(deps: OwnershipHandlerDeps): () => void {
  const { bus, db } = deps;
  const { agents, adapterSessionClaims } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionOwnershipStorageSubjects.read, async (ctx) => {
    const { agentId } = ctx.payload;
    const [agent] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
    if (agent === undefined) {
      ctx.setResult({ ownership: null });
      return;
    }

    const claims = await db
      .select()
      .from(adapterSessionClaims)
      .where(eq(adapterSessionClaims.agentId, agentId))
      .orderBy(asc(adapterSessionClaims.fence), asc(adapterSessionClaims.claimId));

    ctx.setResult({
      ownership: {
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        currency: mapCurrency(agent),
        revision: agent.revision,
        currencyFence: agent.currencyFence,
        claims: claims.map(mapClaim),
      },
    });
  });
}

/**
 * Register handler for `storage:sessionOwnership.listClaims`.
 * @param deps - Handler dependencies (bus and db).
 * @returns Cleanup function to unsubscribe the handler.
 */
function registerListClaimsHandler(deps: OwnershipHandlerDeps): () => void {
  const { bus, db } = deps;
  const tables = resolveSchema(db, sessionStorageSchema);
  const { adapterSessionClaims } = tables;

  return bus.on(SessionOwnershipStorageSubjects.listClaims, async (ctx) => {
    const rows = await db
      .select()
      .from(adapterSessionClaims)
      .where(and(...buildListClaimsPredicates(tables, ctx.payload)))
      .orderBy(asc(adapterSessionClaims.claimedAt), asc(adapterSessionClaims.claimId));

    ctx.setResult({ claims: rows.map(mapClaim) });
  });
}

/**
 * Register Drizzle-based session ownership storage handlers.
 *
 * These are the only writers of the agent currency columns, of the claim table
 * and of the session row's lead designation. Whole-record surfaces such as
 * `storage:agent.set` deliberately cannot express those columns, so a writer
 * holding a pre-movement snapshot cannot resurrect an abandoned provider
 * session.
 * @param bus - The bus instance to register handlers on.
 * @param db - The MakaioDatabase instance.
 * @returns Cleanup function to unsubscribe all handlers.
 * @example
 * ```typescript
 * const cleanup = registerDrizzleSessionOwnershipStorage(bus, db);
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleSessionOwnershipStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const deps: OwnershipHandlerDeps = { bus, db };
  const cleanups = [
    registerReadHandler(deps),
    bus.on(SessionOwnershipStorageSubjects.claim, async (ctx) => {
      ctx.setResult(await runClaim(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.settleCurrency, async (ctx) => {
      ctx.setResult(await runSettleCurrency(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.settleMovement, async (ctx) => {
      ctx.setResult(await runSettleMovement(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.release, async (ctx) => {
      ctx.setResult(await runRelease(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.releaseAgentClaims, async (ctx) => {
      ctx.setResult(await runReleaseAgentClaims(db, ctx.payload));
    }),
    registerListClaimsHandler(deps),
  ];

  return () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
  };
}
