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
 * **Statement order is agents → claims → sessions** in claim, settle and
 * release alike, so no two operations of this aggregate can take the three
 * tables in opposite orders and deadlock. The settle's claim-row touch sits
 * inside that order rather than beside it — `agents` (own row) → `claims` (own
 * generation) → `agents` (already held) → `sessions` — and every operation only
 * ever locks *its own* agent's row, so a settle and a takeover meet on the claim
 * row alone, which both take after their agents row. There is no cycle.
 * @packageDocumentation
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipClaimResult,
  type SessionOwnershipReleaseRequest,
  type SessionOwnershipReleaseResult,
} from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { readAgent, readClaimByKey, readClaimByToken, readLeadAgentId } from './ownership-drizzle-reads.js';
import { runSettleCurrency } from './ownership-drizzle-settle.js';
import {
  buildAcquisitionSelect,
  buildLeadCurrencyMirror,
  buildListClaimsPredicates,
  buildTakeoverFence,
  lockAgentAllocation,
  mapClaim,
  mapCurrency,
  type AgentRow,
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
 * Two refusals are decided after the claim row has already been written inside
 * the transaction, and both must leave no trace of it: a `lead-conflict`, and a
 * designation refused because the claiming agent is no longer a member of the
 * session it names. Throwing is how that is expressed: `executeTransaction`
 * rolls the transaction back, and the handler maps the sentinel to the modeled
 * response outside it. The class is module-private so the sentinel can never
 * escape this seam as an error, and it carries the whole modeled result rather
 * than one outcome's fields, so a new rollback reason needs no second class.
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

/**
 * Designate the claiming agent as its session's lead, compare-and-swap style.
 *
 * Runs inside the claim's transaction, after the claim decision: a key held by
 * another generation is reported as `already-claimed` even when the lead
 * expectation is also wrong. A session already led by the claiming agent
 * satisfies the designation without a write, so a retry is not a conflict.
 *
 * A designation that actually promotes a new lead publishes that lead's resolved
 * currency onto the session row in the same statement
 * ({@link buildLeadCurrencyMirror}), because the session snapshot is defined as
 * the designated lead's currency — leaving the previous lead's pair standing
 * would publish a currency no agent holds, and the promoted agent's own
 * `settleCurrency` may never run again if it has nothing left to move. The
 * already-lead case writes nothing and therefore mirrors nothing: that snapshot
 * is `settleCurrency`'s to keep.
 *
 * **The designating UPDATE carries the membership guard itself**, as an `exists`
 * over the agents table rather than as trust in the claim write that preceded
 * it. Nothing in this transaction pins the agents row: `storage:agent.set` can
 * move the claiming agent to another session between the claim write and this
 * statement, after which the session would name a lead that belongs elsewhere
 * and every later `settleCurrency` would refuse it as `not-owner`. The lock
 * {@link lockAgentAllocation} takes may already block that writer on Postgres,
 * but write-first is about the statement carrying its own authority, not about
 * whether today's other writers happen to block — so the predicate states it.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the optional designation.
 * @returns Whether this call wrote the session's lead designation.
 * @throws When the designation is refused, so the enclosing transaction rolls
 *   back and nothing at all is written.
 */
async function designateLead(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<boolean> {
  if (payload.designateLead === undefined) return false;
  const { sessions, agents } = tables;
  const expected = payload.designateLead.expectedLeadAgentId;

  const currentLead = await readLeadAgentId(tx, tables, payload.sessionId);
  if (currentLead === undefined) throw new ClaimRollbackSignal(leadConflict(null));
  if (currentLead === payload.agentId) return false;
  if (currentLead !== expected) throw new ClaimRollbackSignal(leadConflict(currentLead));

  const updated = await tx
    .update(sessions)
    .set({ leadAgentId: payload.agentId, ...buildLeadCurrencyMirror(tables, payload.agentId) })
    .where(
      and(
        eq(sessions.sessionId, payload.sessionId),
        expected === null ? isNull(sessions.leadAgentId) : eq(sessions.leadAgentId, expected),
        sql`exists (select 1 from ${agents} where ${and(
          eq(agents.agentId, payload.agentId),
          eq(agents.sessionId, payload.sessionId),
        )})`,
      ),
    )
    .returning({ leadAgentId: sessions.leadAgentId });

  if (updated.length > 0) return true;
  return refuseDesignation(tx, tables, payload);
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
 * what the answers mean. The membership `exists` is asked first, through the
 * same {@link resolveClaimTargets} every other path uses: a `(agent, session)`
 * pair that no longer exists is `not-found`, and the claim this transaction took
 * earlier must not survive half-designated — an agent that left the session
 * mid-flight owns nothing in it. Only once that pair still holds can the lead
 * expectation be what refused, and the lead as it now stands is what the caller
 * is told.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the designation.
 * @returns Never: the refusal is always thrown, so the transaction rolls back.
 * @throws Always — {@link ClaimRollbackSignal} carrying the modeled refusal.
 */
async function refuseDesignation(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<never> {
  const targets = await resolveClaimTargets(tx, tables, payload);
  if (targets.kind === 'refused') throw new ClaimRollbackSignal(targets.result);
  throw new ClaimRollbackSignal(leadConflict((await readLeadAgentId(tx, tables, payload.sessionId)) ?? null));
}

/** Rows a claim must reference, or the refusal to report instead. */
type ClaimTargets =
  | { readonly kind: 'ok'; readonly agent: AgentRow }
  | { readonly kind: 'refused'; readonly result: SessionOwnershipClaimResult };

/**
 * Resolve the rows a claim references, in the order the contract reports them.
 *
 * Every path states these guards inside the statement that needs them — the
 * acquisition in its SELECT, the takeover in its UPDATE's predicate — and comes
 * here only to explain a write that produced no row. All of them must reach the
 * same verdict, so the decision tree lives once, here.
 *
 * The order is what the answers mean. A session that does not exist at all is
 * the more specific finding, so it is named first; a `(agent, session)` pair
 * that does not exist because the agent belongs elsewhere is `agent`, because
 * what the claim references is that agent *in that session*. Only once all three
 * hold is there nothing left to report — for the acquiring path that means the
 * key was taken and freed by a competitor between the two statements, which is
 * the only reason its retry loop may run.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request being acquired or taken over.
 * @returns The claiming agent, or the `not-found` outcome to report.
 */
async function resolveClaimTargets(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<ClaimTargets> {
  // `readLeadAgentId` reports `undefined` for a session that does not exist.
  // Asked first, so a request naming neither an existing session nor an existing
  // agent reports the more specific of the two.
  if ((await readLeadAgentId(tx, tables, payload.sessionId)) === undefined) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'session' } };
  }
  const agent = await readAgent(tx, tables, payload.agentId);
  if (agent === undefined || agent.sessionId !== payload.sessionId) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'agent' } };
  }
  return { kind: 'ok', agent };
}

/**
 * Take over the generation the caller named, fencing the previous one out.
 *
 * Write-first, like every other operation here: the UPDATE carries its whole
 * authority in its own predicate, so nothing another process commits between
 * classifying the key and taking it can be acted on as if it were still true.
 * - the token it read is repeated, so a competitor that read the same generation
 *   changes nothing and is told who holds the key;
 * - the claiming agent's membership of the named session is an `exists` over the
 *   agents table rather than a preceding read. The takeover repoints the row at
 *   that `(agent, session)` pair, and `storage:agent.set` can move an agent to
 *   another session at any moment; a pre-read would let the row be filed under a
 *   session its owner has already left, which every later settle then refuses as
 *   `not-owner`. That predicate also keeps the UPDATE off the foreign keys,
 *   where a missing row would fail as a driver error rather than as the
 *   `not-found` the contract models. `agents.session_id` is itself a foreign key,
 *   so a matching agent proves the session exists too;
 * - the fence is allocated by the statement ({@link buildTakeoverFence}) rather
 *   than computed from the classifying read.
 *
 * A zero-row UPDATE is then classified rather than assumed, against the key as
 * it stands *now* — never against the row the classifying read produced:
 * - the key still carries the very generation that was named: the CAS held and
 *   it was the membership guard that refused, which
 *   {@link resolveClaimTargets} names as the same `not-found` every other path
 *   reports for a broken `(agent, session)` pair;
 * - the key carries a different generation: it moved on, which is
 *   `already-claimed` naming *that* holder;
 * - the key carries nothing at all: the named generation was released while this
 *   transaction ran. There is no holder to report and none may be fabricated
 *   from the pre-read row, so the attempt starts over as the acquisition it now
 *   is — the key is free, and the acquiring INSERT is fully self-guarding, so a
 *   competitor racing for it is settled by the unique ownership index.
 *
 * **The outgoing owner's in-flight `settleCurrency` is ordered against this
 * UPDATE by the claim row, not by the agents row.** This transaction locked the
 * *taking* agent's row; the superseded generation belongs to a different agent,
 * whose settle holds only its own. Nothing here would otherwise stop a settle
 * whose guarded UPDATE began before this takeover committed from landing after
 * it — its authority `exists` is a subquery, still seeing the claim as `held`,
 * and EvalPlanQual never re-evaluates a subquery. The superseded generation
 * would then publish currency it no longer owns. The settle closes that from its
 * own side by self-updating the claim row this UPDATE writes (see
 * `touchClaimGeneration` in `ownership-drizzle-settle.ts`), so the two are
 * mutually exclusive on it. If the settle took the row first, this UPDATE waits
 * for it and then fences a generation whose last write had already landed — the
 * ordering the contract wants. If this takeover took it first, the settle's
 * touch re-checks its token against the row as this UPDATE left it, finds the
 * token overwritten, matches nothing, and the superseded generation is refused
 * `not-owner` before its currency write is ever attempted.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request carrying the `supersedes` token.
 * @param existing - Claim row currently holding the key.
 * @param now - Takeover timestamp.
 * @returns The claim outcome for the takeover attempt, or
 *   {@link RETRY_ACQUISITION} when the named generation vanished and the key is
 *   free.
 * @throws When the accompanying lead designation is refused.
 */
async function takeOverClaim(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  existing: ClaimRow,
  now: number,
): Promise<SessionOwnershipClaimResult | typeof RETRY_ACQUISITION> {
  const { adapterSessionClaims, agents } = tables;

  // **The superseded token is overwritten, not retained.** Once this UPDATE
  // lands, the previous generation's token exists nowhere, so a caller
  // presenting it is answered by absence (`not-owner`) rather than by
  // recognition — and, being absent, it could be stored again. Keeping it as a
  // tombstone so it could never return would make the claim table grow with
  // every takeover for the life of the store, to defend against a caller reusing
  // a token it minted itself. The contract puts that guard where it costs
  // nothing: a fresh random token per claim attempt (see `claimToken`).
  const [updated] = await tx
    .update(adapterSessionClaims)
    .set({
      claimToken: payload.claimToken,
      fence: buildTakeoverFence(tables, payload.agentId, existing.fence),
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      adapterName: payload.adapterName,
      status: 'held',
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(adapterSessionClaims.claimId, existing.claimId),
        eq(adapterSessionClaims.claimToken, existing.claimToken),
        sql`exists (select 1 from ${agents} where ${and(
          eq(agents.agentId, payload.agentId),
          eq(agents.sessionId, payload.sessionId),
        )})`,
      ),
    )
    .returning();

  if (updated === undefined) {
    const holder = await readClaimByKey(tx, tables, payload);
    if (holder === undefined) return RETRY_ACQUISITION;
    if (holder.claimToken === existing.claimToken) {
      const targets = await resolveClaimTargets(tx, tables, payload);
      if (targets.kind === 'refused') return targets.result;
    }
    return { outcome: 'already-claimed', holder: mapClaim(holder) };
  }
  const leadDesignated = await designateLead(tx, tables, payload);
  return { outcome: 'claimed', claim: mapClaim(updated), leadDesignated };
}

/**
 * Report a retry of the acquisition whose generation already holds the key.
 *
 * The stored row is evidence that this generation was taken, never that it is
 * still one the caller may work under, so the retry is revalidated against the
 * state as it stands now rather than trusted:
 * - a generation that is no longer `held` is `already-claimed` with its own row
 *   as the holder. It is not live for new work — `settleCurrency` refuses it —
 *   yet its row keeps blocking the key, so the caller is told who blocks it;
 * - a claiming agent that has since been moved to another session is
 *   `not-found` with `missing: 'agent'`, the same answer every other path gives
 *   for a broken `(agent, session)` pair, through the same
 *   {@link resolveClaimTargets}.
 *
 * Both refuse before {@link designateLead} runs. Designating a lead off a
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
  payload: SessionOwnershipClaimRequest,
  existing: ClaimRow,
): Promise<SessionOwnershipClaimResult> {
  if (existing.status !== 'held') return { outcome: 'already-claimed', holder: mapClaim(existing) };

  const targets = await resolveClaimTargets(tx, tables, payload);
  if (targets.kind === 'refused') return targets.result;

  return {
    outcome: 'idempotent',
    claim: mapClaim(existing),
    leadDesignated: await designateLead(tx, tables, payload),
  };
}

/**
 * Signal that the key this attempt aimed at is free again, so nothing can be
 * classified and the attempt must simply be repeated.
 *
 * Raised by the acquisition that lost its key to a competitor which has since
 * let it go, and by a takeover whose named generation was released while the
 * transaction ran. Both mean the same thing: there is no holder to report, and
 * the next attempt is an ordinary acquisition of a free key.
 */
const RETRY_ACQUISITION = Symbol('retry-acquisition');

/**
 * Attempt one acquisition of the ownership key.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request.
 * @param claimId - Identifier minted for a newly inserted claim row.
 * @param now - Acquisition timestamp.
 * @returns The modeled claim outcome, or {@link RETRY_ACQUISITION} when the key
 *   was taken and freed again between the insert and the classifying read.
 * @throws When the accompanying lead designation conflicts.
 */
async function attemptAcquisition(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
  claimId: string,
  now: number,
): Promise<SessionOwnershipClaimResult | typeof RETRY_ACQUISITION> {
  const { adapterSessionClaims } = tables;

  // The first statement that touches the claim table, deliberately: only the
  // per-agent allocation lock precedes it, the write lock precedes every read,
  // and the unique ownership index — not a preceding read — is what decides the
  // winner.
  //
  // The conflict target is the *owner* index. The token index is deliberately
  // not swallowed: `claimToken` is unique among live claims per the contract,
  // so a conflict there is a caller that reused a still-live token, and failing
  // the call loudly is the correct answer rather than silently reporting a
  // modeled outcome.
  const [inserted] = await tx
    .insert(adapterSessionClaims)
    .select(buildAcquisitionSelect(tables, payload, claimId, now))
    .onConflictDoNothing({
      target: [adapterSessionClaims.machineId, adapterSessionClaims.adapterId, adapterSessionClaims.providerSessionId],
    })
    .returning();

  if (inserted !== undefined) {
    const leadDesignated = await designateLead(tx, tables, payload);
    return { outcome: 'claimed', claim: mapClaim(inserted), leadDesignated };
  }

  const existing = await readClaimByKey(tx, tables, payload);
  if (existing !== undefined) {
    if (existing.claimToken === payload.claimToken) {
      // A token match is only this caller's own retry while the row still names
      // the same agent and session. A token presented by anyone else is a
      // competitor holding the key — never an idempotent success that would also
      // let it run the lead designation. What such a retry is still allowed to
      // do is `repeatClaim`'s to decide.
      if (existing.agentId === payload.agentId && existing.sessionId === payload.sessionId) {
        return repeatClaim(tx, tables, payload, existing);
      }
      return { outcome: 'already-claimed', holder: mapClaim(existing) };
    }
    if (payload.supersedes?.claimToken === existing.claimToken) {
      return takeOverClaim(tx, tables, payload, existing, now);
    }
    return { outcome: 'already-claimed', holder: mapClaim(existing) };
  }

  // The insert produced no row and nothing holds the key. Either a guard in the
  // acquiring SELECT did not hold — a missing row, or an agent that is not a
  // member of the named session — or a competitor took the key and released it
  // again between the two statements (reachable across processes on Postgres).
  // Only the reads can tell those apart, and every guard the SELECT states must
  // be read back here: one left out would be reported as contention instead, and
  // the retry loop would spin on it and then throw.
  const targets = await resolveClaimTargets(tx, tables, payload);
  return targets.kind === 'refused' ? targets.result : RETRY_ACQUISITION;
}

/**
 * Take or take over the ownership claim on a provider session.
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
      if (!(await lockAgentAllocation(tx, tables, payload.agentId))) {
        // **Zero rows locked is terminal for a claim.** With no agent row there
        // is nothing to hold the lock on, and under READ COMMITTED the agent can
        // be inserted and committed *after* this statement — two claims that
        // both missed the lock would then allocate a fence against the newly
        // visible row unserialized, and the `(agent_id, fence)` index would
        // refuse one of them as a raw constraint error instead of a modeled
        // outcome. So the claim is refused, and resolveClaimTargets names the
        // refusal in contract precedence. The one exception: the agent was
        // committed between the lock and that read — then a row exists now, and
        // locking it restores serialization.
        const targets = await resolveClaimTargets(tx, tables, payload);
        if (targets.kind === 'refused') return targets.result;
        if (!(await lockAgentAllocation(tx, tables, payload.agentId))) {
          // Gone again between the read and the second lock: at the lock's
          // instant no agent existed, and that instant is the verdict — an
          // unlocked allocation is never an option.
          return { outcome: 'not-found', missing: 'agent' };
        }
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await attemptAcquisition(tx, tables, payload, crypto.randomUUID(), now);
        if (result !== RETRY_ACQUISITION) return result;
      }
      throw new Error(
        `session ownership claim could not be acquired: the key ${payload.machineId}/${payload.adapterId}/${payload.providerSessionId} was taken and freed by a competitor on every attempt`,
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
 * These are the only writers of the agent currency columns and of the claim
 * table. Whole-record surfaces such as `storage:agent.set` deliberately cannot
 * express those columns, so a writer holding a pre-movement snapshot cannot
 * resurrect an abandoned provider session.
 *
 * The session row's currency snapshot still has a second writer:
 * `storage:session.update` accepts the currency pair and the live
 * adapter-session-currency handler uses it.
 * TODO(#1140): Wave 2 rewires settlement through this seam and makes it the
 * sole writer of the session snapshot too.
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
    bus.on(SessionOwnershipStorageSubjects.release, async (ctx) => {
      ctx.setResult(await runRelease(db, ctx.payload));
    }),
    registerListClaimsHandler(deps),
  ];

  return () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
  };
}
