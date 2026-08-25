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
 * **Statement order for a keyed allocation is incarnation counters →
 * runtime_instances → agents → claims → sessions**, so a guarded recovery
 * cannot invert the allocation and agent-lock order used by an ordinary keyed
 * claim. The settle's
 * claim-row touch sits inside its portion of that order rather than beside it —
 * `agents` (own row) → `claims` (own generation) → `agents` (already held) →
 * `sessions`. Movement additionally acquires its full mutable stable-key set
 * before takeover or retirement, so crossed movements share the engine-defined
 * transaction-lock order instead of row-ID order.
 *
 * **The keyless reservation is the one shape with an empty claims phase.** A
 * fresh start has no provider identity to own yet, so `claim` with
 * `providerSessionId: null` writes no claim row at all and its whole effect is
 * the lead designation and the currency mirror that goes with it — still one
 * transaction, still compare-and-swap. A guarded keyless reservation still
 * registers the runtime identity before its agent and sessions phases: it
 * publishes that identity onto the agent row, so later authority teardown must
 * be able to retire it. Its agent guards are stated against the row
 * `lockAgentAllocation` has already taken rather than as conjuncts of a
 * claim-table statement, because there is no such statement; the lock makes that
 * row unchangeable for the rest of the transaction, so the two are equally
 * self-guarding.
 * @packageDocumentation
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import {
  acquireTransactionLocks,
  executeTransaction,
  resolveSchema,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  isInactiveSafeLeadDesignationMutation,
  normalizeSessionOwnershipClaimRequest,
  SessionOwnershipSettleMovementRequestSchema,
  SessionOwnershipStorageSubjects,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipClaimResult,
  type SessionOwnershipReleaseAgentClaimsRequest,
  type SessionOwnershipReleaseAgentClaimsResult,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { leadConflict, takenClaim } from './ownership-drizzle-claim-outcomes.js';
import { acquisitionOwnershipClaimTransactionLock } from './ownership-drizzle-claim-keys.js';
import { runFinalizeRecovery } from './ownership-drizzle-finalize-recovery.js';
import { readClaimByKey } from './ownership-drizzle-reads.js';
import { runRelease } from './ownership-drizzle-release.js';
import {
  attemptGuardedRecoveryTakeover,
  drizzleRecoveryConflict,
  evaluateDrizzleRecoveryGuard,
  finishDrizzleRecoveryClaim,
} from './ownership-drizzle-recovery.js';
import { runSettleCurrency } from './ownership-drizzle-settle.js';
import { runSettleMovement } from './ownership-drizzle-movement.js';
import {
  insertClaimGeneration,
  resolveClaimTargets,
  resolveTakeoverAuthorization,
  takeOverClaimRow,
  type TakeoverAuthorization,
} from './ownership-drizzle-acquire.js';
import {
  buildAgentGuard,
  type AgentGuardMode,
  buildLeadCurrencyMirror,
  ClaimRollbackSignal,
  ensureRuntimeInstance,
  type KeyedClaimRequest,
  type LeadDesignationOutcome,
  lockAgentAllocation,
  type LockedClaimant,
  mapClaim,
  registerOwnershipReadHandlers,
  registerRuntimeInstanceHandlers,
  type AgentRow,
  type ClaimRow,
  type OwnershipTables,
  type OwnershipTransaction,
  type RuntimeInstanceAllocation,
} from './ownership-drizzle-rows.js';

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
 * @returns The locked admission phase, or `undefined` when the session row does
 *   not exist.
 */
async function touchSessionLead(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  sessionId: string,
): Promise<
  { readonly leadAgentId: string | null; readonly status: 'active' | 'closed' | 'archived' | 'discovered' } | undefined
> {
  const { sessions } = tables;
  const [row] = await tx
    .update(sessions)
    .set({ lastActivityAt: sessions.lastActivityAt })
    .where(eq(sessions.sessionId, sessionId))
    .returning({ leadAgentId: sessions.leadAgentId, status: sessions.status });
  return row === undefined ? undefined : { leadAgentId: row.leadAgentId ?? null, status: row.status };
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
  const session = await touchSessionLead(tx, tables, payload.sessionId);
  if (session === undefined) {
    throw new ClaimRollbackSignal({ outcome: 'not-found', missing: 'session' });
  }
  if (session.status !== 'active' && (session.status !== 'closed' || !isInactiveSafeLeadDesignationMutation(payload))) {
    throw new ClaimRollbackSignal({ outcome: 'session-not-active', status: session.status });
  }
  const previousLeadAgentId = session.leadAgentId;
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
 * Take the incumbent generation over, and classify a takeover that wrote nothing.
 *
 * The write itself is {@link takeOverClaimRow}, which carries the whole
 * authority. A zero-row UPDATE is then classified against the key as it stands
 * *now* — never against the row the classifying read produced:
 * - the key still carries the very generation that was named: the CAS held and
 *   the agent or owner-identity guard refused. A broken `(agent, session)` pair
 *   or a removed taker is named by {@link resolveClaimTargets}; a failed
 *   owner-identity predicate leaves nothing to report but the holder;
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
  const updated = await takeOverClaimRow(
    tx,
    tables,
    payload,
    incumbent,
    authorization,
    now,
    payload.recoveryGuard?.ownerGeneration ?? undefined,
  );
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
  if (payload.recoveryGuard?.ownerGeneration) {
    return attemptGuardedRecoveryTakeover(tx, tables, payload, async (incumbent, authorization) => {
      const result = await takeOverClaim(tx, tables, payload, incumbent, authorization, now);
      return result === RETRY_ACQUISITION ? undefined : result;
    });
  }

  const inserted = await insertClaimGeneration(tx, tables, payload, now);
  if (inserted !== undefined) return takenClaim('claimed', inserted, await applyLeadDesignation(tx, tables, payload));

  const existing = await readClaimByKey(tx, tables, payload);
  if (payload.recoveryGuard !== undefined) return drizzleRecoveryConflict(payload, existing);
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

  const authorization = await resolveTakeoverAuthorization(
    tx,
    tables,
    payload,
    existing,
    payload.supersedes?.claimToken === existing.claimToken,
  );
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
 * Complete a keyless claim after entering its transaction.
 *
 * Guarded reservations allocate their exact runtime target before locking the
 * agent; every subsequent refusal is signaled for transaction rollback, so an
 * attempted recovery never consumes an incarnation without publishing it.
 * @param tx - Open ownership transaction.
 * @param tables - Dialect-resolved ownership tables.
 * @param payload - Keyless claim request.
 * @param ownerInstance - Optional runtime identity from the request.
 * @param now - Allocation timestamp.
 * @returns The modeled keyless claim outcome.
 */
async function runKeylessClaim(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  ownerInstance: { readonly instanceId: string } | undefined,
  now: number,
): Promise<SessionOwnershipClaimResult> {
  let guardedKeylessOwner: RuntimeInstanceAllocation | undefined;
  if (payload.recoveryGuard !== undefined) {
    if (ownerInstance === undefined) throw new Error('guarded recovery claim requires ownerInstance');
    guardedKeylessOwner = await ensureRuntimeInstance(
      tx,
      tables,
      { instanceId: ownerInstance.instanceId, machineId: payload.machineId },
      now,
    );
  }
  const claimant = await lockClaimingAgent(tx, tables, payload);
  if (claimant.kind === 'refused') {
    if (guardedKeylessOwner !== undefined) throw new ClaimRollbackSignal(claimant.result);
    return claimant.result;
  }
  const guardRefusal = await evaluateDrizzleRecoveryGuard(tx, tables, payload, claimant.agent);
  if (guardRefusal !== undefined) {
    if (guardedKeylessOwner !== undefined) throw new ClaimRollbackSignal(guardRefusal);
    return guardRefusal;
  }
  const result = await runKeylessReservation(tx, tables, payload, claimant.agent);
  if (guardedKeylessOwner !== undefined && result.outcome !== 'claimed') throw new ClaimRollbackSignal(result);
  return finishDrizzleRecoveryClaim(tx, tables, payload, result);
}

/**
 * Take or take over the ownership claim on a provider session — or reserve a
 * start that has no provider session yet.
 * @param db - Database handle.
 * @param request - Claim request.
 * @returns The modeled claim outcome.
 * @throws When a competitor keeps taking and freeing the key faster than this
 *   call can acquire it. Sustained contention of that shape is not a modeled
 *   outcome — no row is missing and no holder exists to report — so it surfaces
 *   as a failure the caller retries, rather than as a fabricated `not-found`.
 */
async function runClaim(db: MakaioDatabase, request: unknown): Promise<SessionOwnershipClaimResult> {
  const payload = normalizeSessionOwnershipClaimRequest(request);
  const tables = resolveSchema(db, sessionStorageSchema);
  const now = Date.now();
  const ownerInstance = payload.ownerInstance;
  if (payload.providerSessionId !== null && ownerInstance === undefined) {
    throw new Error('keyed session ownership claim requires ownerInstance');
  }
  if (payload.recoveryGuard !== undefined && ownerInstance === undefined) {
    throw new Error('guarded recovery claim requires ownerInstance');
  }

  try {
    return await executeTransaction(db, async (tx): Promise<SessionOwnershipClaimResult> => {
      const { providerSessionId } = payload;
      if (providerSessionId !== null) {
        if (ownerInstance === undefined) throw new Error('keyed session ownership claim requires ownerInstance');
        const owner = await ensureRuntimeInstance(
          tx,
          tables,
          { instanceId: ownerInstance.instanceId, machineId: payload.machineId },
          now,
        );

        const claimant = await lockClaimingAgent(tx, tables, payload);
        if (claimant.kind === 'refused') {
          if (owner.inserted) throw new ClaimRollbackSignal(claimant.result);
          return claimant.result;
        }
        const keyed: KeyedClaimRequest = {
          ...payload,
          providerSessionId,
          ownerInstance,
          ownerInstanceId: ownerInstance.instanceId,
        };
        await acquireTransactionLocks(db, tx, [acquisitionOwnershipClaimTransactionLock(keyed)]);
        if (payload.recoveryGuard !== undefined) {
          const guardRefusal = await evaluateDrizzleRecoveryGuard(tx, tables, payload, claimant.agent);
          if (guardRefusal !== undefined) {
            if (owner.inserted) throw new ClaimRollbackSignal(guardRefusal);
            return guardRefusal;
          }
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await attemptAcquisition(tx, tables, keyed, now);
          if (result === RETRY_ACQUISITION) continue;
          if (owner.inserted && result.outcome !== 'claimed') throw new ClaimRollbackSignal(result);
          return finishDrizzleRecoveryClaim(tx, tables, payload, result);
        }
        throw new Error(
          `session ownership claim could not be acquired: the key ${payload.machineId}/${payload.adapterId}/${providerSessionId} was taken and freed by a competitor on every attempt`,
        );
      }

      return runKeylessClaim(tx, tables, payload, ownerInstance, now);
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
  const cleanups = [
    ...registerOwnershipReadHandlers(bus, db),
    bus.on(SessionOwnershipStorageSubjects.claim, async (ctx) => {
      ctx.setResult(await runClaim(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.finalizeRecovery, async (ctx) => {
      ctx.setResult(await runFinalizeRecovery(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.settleCurrency, async (ctx) => {
      ctx.setResult(await runSettleCurrency(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.settleMovement, async (ctx) => {
      const payload = SessionOwnershipSettleMovementRequestSchema.parse(ctx.payload);
      ctx.setResult(await runSettleMovement(db, payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.release, async (ctx) => {
      ctx.setResult(await runRelease(db, ctx.payload));
    }),
    bus.on(SessionOwnershipStorageSubjects.releaseAgentClaims, async (ctx) => {
      ctx.setResult(await runReleaseAgentClaims(db, ctx.payload));
    }),
    ...registerRuntimeInstanceHandlers(bus, db),
  ];

  return () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
  };
}
