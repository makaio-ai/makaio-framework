/**
 * The `storage:sessionOwnership.settleCurrency` operation, Drizzle side.
 *
 * Kept apart from the claim operations because it is the aggregate's other half:
 * a claim decides *who owns a provider session*, a settle exercises that
 * ownership to write the owning agent's currency and, when that agent leads its
 * session, the session row's snapshot of it. The two share only the row mapping
 * and the classifying reads.
 *
 * The rule they do share is the binding one: write first, carry the whole
 * authority in the write's own predicate, and read only to classify a write that
 * landed on zero rows.
 * @packageDocumentation
 */
import { and, eq, isNull, lte, not, sql, type SQL } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { SessionOwnershipSettleCurrencyRequest, SessionOwnershipSettleCurrencyResult } from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { readAgent, readClaimByToken } from './ownership-drizzle-reads.js';
import {
  buildLeadCurrencyMirror,
  lockAgentAllocation,
  mapCurrency,
  type AgentRow,
  type ClaimRow,
  type OwnershipTables,
  type OwnershipTransaction,
} from './ownership-drizzle-rows.js';

/**
 * The predicate carrying the settle's full authority.
 *
 * Everything that may refuse the write is a condition of the statement itself,
 * so no other process can commit a takeover between the moment authority is
 * established and the moment it is used:
 * - the agent is the named one and still carries the revision the caller read;
 * - a `held` claim of that exact generation, owned by that agent *and filed
 *   under the session that agent is currently in*, exists;
 * - the caller's fence is not below the one that already governs the currency;
 * - the write would actually change something. An idempotent target is excluded
 *   here rather than pre-read, which is what keeps the transaction write-first:
 *   a zero-row write is then classified afterwards, and "the target already
 *   equals the stored one" is one of the things it can mean.
 *
 * The claim's `session_id` is correlated against the *updated* agents row rather
 * than against the caller's request, because a claim is an ownership of an agent
 * *in a session*: `storage:agent.set` can move an agent to another session, and
 * a generation taken while it was still in the old one no longer represents any
 * ownership of it. Left out, that stale claim would keep settling the agent —
 * and, if the agent is lead in its new session, mirror the currency onto a
 * session its holder was never part of.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Settle request.
 * @returns Predicate for the agent UPDATE.
 */
function buildSettlePredicate(
  tables: OwnershipTables,
  payload: SessionOwnershipSettleCurrencyRequest,
): SQL | undefined {
  const { agents, adapterSessionClaims } = tables;
  const { target } = payload;

  // Branching in JS rather than comparing with `=` keeps NULL out of the
  // predicate: `column = NULL` is NULL, and `not(NULL)` would silently drop the
  // row instead of admitting the write.
  const sameCurrentId =
    target.currentAdapterSessionId === null
      ? isNull(agents.currentAdapterSessionId)
      : eq(agents.currentAdapterSessionId, target.currentAdapterSessionId);

  const alreadySettled: SQL = sql`(${sameCurrentId} and ${eq(
    agents.currentAdapterSessionIdState,
    target.currentAdapterSessionIdState,
  )} and ${eq(agents.currencyFence, payload.fence)})`;

  return and(
    eq(agents.agentId, payload.agentId),
    eq(agents.revision, payload.expectedRevision),
    lte(agents.currencyFence, payload.fence),
    sql`exists (select 1 from ${adapterSessionClaims} where ${and(
      eq(adapterSessionClaims.claimToken, payload.claimToken),
      eq(adapterSessionClaims.agentId, payload.agentId),
      eq(adapterSessionClaims.sessionId, agents.sessionId),
      eq(adapterSessionClaims.status, 'held'),
      eq(adapterSessionClaims.fence, payload.fence),
    )})`,
    not(alreadySettled),
  );
}

/**
 * Explain a settle whose write matched no row.
 *
 * The same decision tree the guard predicate encodes, read back in the order the
 * contract states it: the agent must exist, the caller must own a live claim of
 * its generation *in the agent's current session*, that generation must not be
 * outranked, an unchanged target is idempotent, and anything left is a lost race
 * within the generation.
 *
 * A claim filed under another session is `not-owner` rather than `superseded`:
 * nothing outranked it, it simply stopped being an ownership of this agent.
 *
 * A live claim whose fence is not the one the caller presented is `not-owner`
 * for the same reason. Authority is the *pair* token + fence, and that pair does
 * not exist: `superseded` would name a generation that outranked the caller's,
 * and there is none — the caller's fence may even be the higher of the two,
 * which is a `currentFence` no reader could act on.
 * @param claim - Claim row carrying the caller's token, when one exists.
 * @param agent - Agent row the settle targets.
 * @param payload - Settle request.
 * @returns The outcome to report.
 */
function classifyRefusedSettle(
  claim: ClaimRow | undefined,
  agent: AgentRow,
  payload: SessionOwnershipSettleCurrencyRequest,
): SessionOwnershipSettleCurrencyResult {
  if (
    claim === undefined ||
    claim.agentId !== payload.agentId ||
    claim.sessionId !== agent.sessionId ||
    claim.status !== 'held' ||
    claim.fence !== payload.fence
  ) {
    return { outcome: 'not-owner' };
  }
  if (payload.fence < agent.currencyFence) {
    return { outcome: 'superseded', currentFence: agent.currencyFence };
  }

  const current = mapCurrency(agent);
  // Idempotency is reported before the revision compare-and-swap on purpose: the
  // movement seam re-announces on every unconfirmed dispatch and on every
  // confirmation, so a repeat must not be reported as a lost race.
  if (
    current.currentAdapterSessionId === payload.target.currentAdapterSessionId &&
    current.currentAdapterSessionIdState === payload.target.currentAdapterSessionIdState &&
    agent.currencyFence === payload.fence
  ) {
    return { outcome: 'idempotent', revision: agent.revision, currency: current, sessionSnapshotUpdated: false };
  }
  return { outcome: 'currency-changed', revision: agent.revision, currency: current };
}

/**
 * Explain a settle that may not be performed, against the state as it stands.
 *
 * Two statements can decide a settle is refused — the claim-row touch and the
 * guarded agent UPDATE — and both must reach the same verdict, so the decision
 * tree is read back in one place. It is a classifying read only: nothing here
 * grants authority, and it runs exclusively after a write matched no row.
 *
 * The agent is read first because {@link classifyRefusedSettle} needs the row to
 * compare against; its absence is the settle's own `not-found`.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Settle request.
 * @returns The modeled refusal to report.
 */
async function classifySettleRefusal(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipSettleCurrencyRequest,
): Promise<SessionOwnershipSettleCurrencyResult> {
  const agent = await readAgent(tx, tables, payload.agentId);
  if (agent === undefined) return { outcome: 'not-found' };
  return classifyRefusedSettle(await readClaimByToken(tx, tables, payload.claimToken), agent, payload);
}

/**
 * Take the caller's own claim row, so a takeover of it must wait for this settle.
 *
 * The agent lock orders this settle against a concurrent `release`, but it
 * cannot order it against a concurrent **takeover**. A takeover moves an
 * ownership key from agent A to agent B and locks only *B's* agents row
 * ({@link lockAgentAllocation} takes the claiming agent's row), so A's settle and
 * B's takeover share no lock at all. The settle's authority `exists` is a plain
 * subquery keeping its statement's READ COMMITTED snapshot, in which A's claim
 * is still `held`, and EvalPlanQual re-checks only the simple column predicates
 * on the *agents* row that statement locks — never a subquery. A settle whose
 * guarded UPDATE began before the takeover committed could therefore land after
 * it, publishing currency from a generation that has already been fenced out.
 *
 * A self-`UPDATE` of the claim row the caller's token names closes that without
 * a second agent lock. **Locking both agents rows is what is being avoided**:
 * two takeovers crossing in opposite directions would then take the two rows in
 * opposite orders and deadlock. This is the same seam one table down — a column
 * assigned to itself changes nothing and holds the row until commit, so a
 * takeover's UPDATE of that row now blocks until this transaction ends. And if
 * the takeover won the race, this statement's own EvalPlanQual re-check refuses
 * it: the predicate is a simple column comparison on the locked row itself,
 * which is exactly the case those re-checks are reliable for.
 *
 * **This is serialization, not authority** — the same doctrine
 * {@link lockAgentAllocation} states. Nothing downstream may read a touched row
 * as permission: the guarded UPDATE below still carries its whole `exists`,
 * including the parts this predicate does not even ask about (the owning agent,
 * the session the claim is filed under, the status and the fence).
 *
 * The token is the whole predicate because `uniq_adapter_session_claims_token`
 * makes it a key: at most one live row can carry it, so this is a single-row
 * lock, not a scan that could widen the transaction's lock footprint.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param claimToken - Generation token whose claim row is being taken.
 * @returns Whether a live claim carries the token and is now locked.
 */
async function touchClaimGeneration(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  claimToken: string,
): Promise<boolean> {
  const { adapterSessionClaims } = tables;
  const touched = await tx
    .update(adapterSessionClaims)
    .set({ updatedAt: adapterSessionClaims.updatedAt })
    .where(eq(adapterSessionClaims.claimToken, claimToken))
    .returning({ claimId: adapterSessionClaims.claimId });
  return touched.length > 0;
}

/**
 * Write an agent's currency under a claim generation.
 *
 * Write-first: the guarded agent UPDATE carries the whole guard, so a takeover
 * committed by another process cannot slip between authority and write. Reads
 * only run when that write matched nothing, and then only to name which of the
 * modeled refusals it was.
 *
 * The transaction opens on `lockAgentAllocation` — a write, so write-first still
 * holds — because the guard alone cannot order this settle against a concurrent
 * `release`: the authority `exists` is a plain subquery, and a subquery keeps
 * its statement's READ COMMITTED snapshot even where EvalPlanQual re-checks the
 * agents row the UPDATE locks. A settle whose statement began while the claim
 * was still `held` could therefore commit after the release had already freed
 * the key. With the lock taken first, the guarded UPDATE is a *second*
 * statement, and its fresh snapshot sees any release that committed while this
 * transaction waited.
 *
 * The claim-row touch ({@link touchClaimGeneration}) is the second half of that
 * ordering, for the race the agent lock cannot reach: a takeover locks the
 * *taking* agent's row, never the outgoing owner's, so only the claim row itself
 * is common ground between the two. Taking it here — after the agent lock, so
 * the table order stays `agents → claims → sessions`, and before the guarded
 * UPDATE, so that UPDATE is a later statement with a fresh subquery snapshot —
 * is what makes a takeover of this generation and this settle mutually
 * exclusive. Both locks are serialization only; the guarded UPDATE's `exists`
 * remains the sole authority.
 *
 * **The statement order is therefore** `agents` (own row, locked) → `claims`
 * (own generation, locked) → `agents` (own row again, already held) →
 * `sessions`. No operation of this aggregate takes those tables in another
 * order, and the only agents row this transaction ever locks is its own — a
 * takeover locks only its taker's — so the two meet on the claim row alone,
 * which both take *after* their agents row. There is no cycle to deadlock on.
 *
 * The session mirror is guarded the same way — its predicate repeats the lead
 * designation instead of reading it first — and `sessionSnapshotUpdated` is
 * derived from the rows that statement affected.
 *
 * **Not covered by a race test, deliberately.** The takeover interleaving spans
 * two transactions, but the window it closes is *between two statements inside
 * this one*. Nothing on the bus surface can suspend a caller there, so a test
 * shaped like that race would in fact run the two operations sequentially and
 * assert an outcome they already produce without the touch — a placebo. The
 * invariant is carried by the statement order above instead.
 * @param db - Database handle.
 * @param payload - Settle request.
 * @returns The modeled settle outcome.
 */
export async function runSettleCurrency(
  db: MakaioDatabase,
  payload: SessionOwnershipSettleCurrencyRequest,
): Promise<SessionOwnershipSettleCurrencyResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const { agents, sessions } = tables;
  const { target } = payload;
  const now = Date.now();

  return executeTransaction(db, async (tx): Promise<SessionOwnershipSettleCurrencyResult> => {
    // **Zero rows locked is terminal here**: no agent row exists, which is the
    // settle's own `not-found`. Reporting it straight from the lock is the same
    // verdict the guarded UPDATE below would reach through its classifying read,
    // one statement earlier.
    if (!(await lockAgentAllocation(tx, tables, payload.agentId))) return { outcome: 'not-found' };

    // **Zero rows touched is terminal here**: no live claim carries the caller's
    // token, so the guarded UPDATE's authority `exists` could not have matched
    // either — the refusal is simply decided one statement early. The
    // classifying read below reaches `not-owner` on an absent claim, which is
    // the same verdict, by the same route.
    if (!(await touchClaimGeneration(tx, tables, payload.claimToken))) {
      return classifySettleRefusal(tx, tables, payload);
    }

    // TODO(#1140): Wave 2 — the settled columns below are already authoritative
    // storage state, but nothing reads them yet: `resolveAgentResumeIdentity`
    // and `planAgentRecovery` still resume a restarted member from
    // `agents.adapter_session_id`. The SessionService ownership authority
    // (reserveStart / settleMovement / reconcile) is what makes these the
    // resume identity's input; this PR is the storage foundation it lands on.
    const [updated] = await tx
      .update(agents)
      .set({
        currentAdapterSessionId: target.currentAdapterSessionId,
        currentAdapterSessionIdState: target.currentAdapterSessionIdState,
        currencyFence: payload.fence,
        revision: payload.expectedRevision + 1,
        lastActivityAt: now,
      })
      .where(buildSettlePredicate(tables, payload))
      .returning();

    if (updated === undefined) return classifySettleRefusal(tx, tables, payload);

    // The pair is **resolved onto the session row's own terms, not copied** —
    // the same translation the lead designation publishes, for the same reason:
    // `inherited` points at the reading row's *own* origin, and a lead's origin
    // is generally not its session's, so copying the target verbatim would make
    // the session resolve to its own origin instead of the lead's. Reading the
    // pair back out of the agents row rather than off `target` is what makes
    // that possible, and it is sound because this statement follows the agent
    // UPDATE inside one transaction: its correlated subqueries see the currency
    // just settled.
    const mirrored = await tx
      .update(sessions)
      .set({ ...buildLeadCurrencyMirror(tables, payload.agentId) })
      .where(and(eq(sessions.sessionId, updated.sessionId), eq(sessions.leadAgentId, payload.agentId)))
      .returning({ sessionId: sessions.sessionId });

    return {
      outcome: 'settled',
      revision: payload.expectedRevision + 1,
      currency: { adapterSessionId: updated.adapterSessionId ?? null, ...target },
      sessionSnapshotUpdated: mirrored.length > 0,
    };
  });
}
