/**
 * Allocating a claim generation, Drizzle side.
 *
 * Two operations take ownership keys — `claim` and `settleMovement` — and they
 * must take them identically: same guards, same fence rule, same unique index,
 * same takeover rule. The statements that do it therefore live here rather than
 * inside either operation, so neither can grow a guard the other silently lacks.
 *
 * What stays with the operations is what they legitimately disagree about:
 * `claim` recognizes its own token as a retry and may designate a lead;
 * `settleMovement` recognizes the key the agent already holds and settles under
 * it. This module decides nothing about either — it writes, and reports the row
 * or the reason there is none.
 * @packageDocumentation
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SessionOwnershipClaimResult, SessionOwnershipRecoveryOwnerGeneration } from '@makaio/contracts';
import { readAgent, readLeadAgentId } from './ownership-drizzle-reads.js';
import {
  buildAcquisitionSelect,
  buildTakeoverFence,
  buildAgentGuard,
  type AgentRow,
  type ClaimAcquisition,
  type ClaimRow,
  type OwnershipTables,
  type OwnershipTransaction,
} from './ownership-drizzle-rows.js';

/**
 * The refusals a claim reaches by looking at the rows it references.
 *
 * A subset of the claim response rather than a type of its own: `settleMovement`
 * reports the same findings under its own names, and having one producer keeps
 * the two operations from disagreeing about what a broken `(agent, session)`
 * pair or a removed agent means.
 */
export type ClaimTargetRefusal = Extract<SessionOwnershipClaimResult, { outcome: 'not-found' | 'agent-disposed' }>;

/** Rows a claim must reference, or the refusal to report instead. */
export type ClaimTargets =
  | { readonly kind: 'ok'; readonly agent: AgentRow }
  | { readonly kind: 'refused'; readonly result: ClaimTargetRefusal };

/**
 * Resolve the rows a claim references, in the order the contract reports them.
 *
 * Every path states these guards inside the statement that needs them — the
 * acquisition in its SELECT, the takeover in its UPDATE's predicate, the
 * designation in its own — and comes here only to explain a write that produced
 * no row. All of them must reach the same verdict, so the decision tree lives
 * once, here.
 *
 * The order is what the answers mean. A session that does not exist at all is
 * the more specific finding, so it is named first; a `(agent, session)` pair
 * that does not exist because the agent belongs elsewhere is `agent`, because
 * what the claim references is that agent *in that session*. A pair that does
 * exist but whose agent is `disposed` is `agent-disposed` — the rows are there,
 * and the refusal is about authority rather than existence. Only once all of
 * that holds is there nothing left to report — for the acquiring path that means
 * the key was taken and freed by a competitor between the two statements, which
 * is the only reason its retry loop may run.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param target - The `(agent, session)` pair being claimed for.
 * @returns The claiming agent, or the refusal to report.
 */
export async function resolveClaimTargets(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  target: { readonly sessionId: string; readonly agentId: string },
): Promise<ClaimTargets> {
  // `readLeadAgentId` reports `undefined` for a session that does not exist.
  // Asked first, so a request naming neither an existing session nor an existing
  // agent reports the more specific of the two.
  if ((await readLeadAgentId(tx, tables, target.sessionId)) === undefined) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'session' } };
  }
  const agent = await readAgent(tx, tables, target.agentId);
  if (agent === undefined || agent.sessionId !== target.sessionId) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'agent' } };
  }
  if (agent.status === 'disposed') return { kind: 'refused', result: { outcome: 'agent-disposed' } };
  return { kind: 'ok', agent };
}

/**
 * Attempt the acquiring INSERT for a free ownership key.
 *
 * The first statement that touches the claim table, deliberately: only the
 * per-agent allocation lock precedes it, the write lock precedes every read, and
 * the unique ownership index — not a preceding read — is what decides the
 * winner.
 *
 * The conflict target is the *owner* index. The token index is deliberately not
 * swallowed: `claimToken` is unique among live claims per the contract, so a
 * conflict there is a caller that reused a still-live token, and failing the
 * call loudly is the correct answer rather than silently reporting a modeled
 * outcome.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - The generation being taken.
 * @param now - Acquisition timestamp.
 * @returns The inserted row, or `undefined` when the key was already held or a
 *   guard in the acquiring SELECT did not hold.
 */
export async function insertClaimGeneration(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  now: number,
): Promise<ClaimRow | undefined> {
  const { adapterSessionClaims } = tables;
  const [inserted] = await tx
    .insert(adapterSessionClaims)
    .select(buildAcquisitionSelect(tables, acquisition, crypto.randomUUID(), now))
    .onConflictDoNothing({
      target: [adapterSessionClaims.machineId, adapterSessionClaims.adapterId, adapterSessionClaims.providerSessionId],
    })
    .returning();
  return inserted;
}

/**
 * What authorizes repointing an incumbent generation at the taking agent.
 *
 * - `named-token` — the caller named the generation through `supersedes`, having
 *   separately established its owner is gone. Storage records that conclusion;
 *   it does not evaluate the evidence behind it.
 * - `same-instance`, `owner-retired`, and `owner-superseded` — durable runtime
 *   identity proves T1, T3, or T4 respectively. T4 is only resolved for an
 *   explicitly machine-exclusive topology.
 *
 * A *deleted* agent or session is neither: both foreign keys cascade, so the
 * claim row goes with its parent and the next claimant does a plain acquisition.
 */
export type TakeoverAuthorization = 'named-token' | 'same-instance' | 'owner-retired' | 'owner-superseded';

/**
 * Build the storage-provable predicate for an owner-identity takeover.
 *
 * The classification read only chooses a branch. This predicate repeats the
 * fact in the repointing UPDATE, so a generation can never be taken because a
 * stale service-side observation said it was eligible.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - Generation being taken.
 * @param authorization - Owner-identity authorization being exercised.
 * @returns Predicate that must still hold on the incumbent row.
 */
function buildOwnerAuthorizationPredicate(
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  authorization: Exclude<TakeoverAuthorization, 'named-token'>,
) {
  const { adapterSessionClaims, runtimeInstances } = tables;
  if (authorization === 'same-instance') {
    return and(
      eq(adapterSessionClaims.status, 'held'),
      eq(adapterSessionClaims.agentId, acquisition.agentId),
      eq(adapterSessionClaims.ownerInstanceId, acquisition.ownerInstanceId),
    );
  }
  if (authorization === 'owner-retired') {
    return sql`exists (select 1 from ${runtimeInstances} where ${and(
      eq(runtimeInstances.instanceId, adapterSessionClaims.ownerInstanceId),
      eq(runtimeInstances.machineId, adapterSessionClaims.machineId),
      isNotNull(runtimeInstances.retiredAt),
    )})`;
  }
  return sql`(select ${runtimeInstances.incarnation} from ${runtimeInstances}
      where ${eq(runtimeInstances.instanceId, acquisition.ownerInstanceId)}
        and ${eq(runtimeInstances.machineId, adapterSessionClaims.machineId)})
    > (select ${runtimeInstances.incarnation} from ${runtimeInstances}
      where ${eq(runtimeInstances.instanceId, adapterSessionClaims.ownerInstanceId)}
        and ${eq(runtimeInstances.machineId, adapterSessionClaims.machineId)})`;
}

/**
 * Repoint the incumbent generation at the taking agent, fencing it out.
 *
 * Write-first, like every other operation here: the UPDATE carries its whole
 * authority in its own predicate, so nothing another process commits between
 * classifying the key and taking it can be acted on as if it were still true.
 * - the token that was read is repeated, so a competitor that read the same
 *   generation changes nothing and is told who holds the key;
 * - the taking agent's membership *and* liveness are a
 *   {@link buildAgentGuard} `exists` rather than a preceding read. The takeover
 *   repoints the row at that `(agent, session)` pair, and `storage:agent.set` /
 *   `updateStatus` can move or dispose an agent at any moment; a pre-read would
 *   let the row be filed under a session its owner has already left, or handed
 *   to an agent that has since been removed. That predicate also keeps the
 *   UPDATE off the foreign keys, where a missing row would fail as a driver
 *   error rather than as the `not-found` the contract models. `agents.session_id`
 *   is itself a foreign key, so a matching agent proves the session exists too;
 * - the fence is allocated by the statement ({@link buildTakeoverFence}) rather
 *   than computed from the classifying read.
 *
 * **The superseded token is overwritten, not retained.** Once this UPDATE lands,
 * the previous generation's token exists nowhere, so a caller presenting it is
 * answered by absence (`not-owner`) rather than by recognition — and, being
 * absent, it could be stored again. Keeping it as a tombstone so it could never
 * return would make the claim table grow with every takeover for the life of the
 * store, to defend against a caller reusing a token it minted itself. The
 * contract puts that guard where it costs nothing: a fresh random token per
 * claim attempt.
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
 * mutually exclusive on it.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - The generation being taken.
 * @param incumbent - Claim row currently holding the key.
 * @param authorization - What permits repointing the incumbent.
 * @param now - Takeover timestamp.
 * @param expectedOwnerGeneration - Exact generation a guarded recovery observed;
 *   omitted by ordinary claims and movements.
 * @returns The repointed row, or `undefined` when a guard did not hold.
 */
export async function takeOverClaimRow(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  incumbent: ClaimRow,
  authorization: TakeoverAuthorization,
  now: number,
  expectedOwnerGeneration?: SessionOwnershipRecoveryOwnerGeneration,
): Promise<ClaimRow | undefined> {
  const { adapterSessionClaims } = tables;
  const ownerAuthorization =
    authorization === 'named-token' ? undefined : buildOwnerAuthorizationPredicate(tables, acquisition, authorization);
  const expectedOwner =
    expectedOwnerGeneration === undefined
      ? undefined
      : and(
          eq(adapterSessionClaims.claimId, expectedOwnerGeneration.claimId),
          eq(adapterSessionClaims.claimToken, expectedOwnerGeneration.claimToken),
          eq(adapterSessionClaims.fence, expectedOwnerGeneration.fence),
          expectedOwnerGeneration.ownerInstanceId === null
            ? isNull(adapterSessionClaims.ownerInstanceId)
            : eq(adapterSessionClaims.ownerInstanceId, expectedOwnerGeneration.ownerInstanceId),
          eq(adapterSessionClaims.status, expectedOwnerGeneration.status),
        );

  const [updated] = await tx
    .update(adapterSessionClaims)
    .set({
      claimToken: acquisition.claimToken,
      fence: buildTakeoverFence(tables, acquisition.agentId, incumbent.fence),
      agentId: acquisition.agentId,
      sessionId: acquisition.sessionId,
      adapterName: acquisition.adapterName,
      ownerInstanceId: acquisition.ownerInstanceId,
      status: 'held',
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(adapterSessionClaims.claimId, incumbent.claimId),
        eq(adapterSessionClaims.claimToken, incumbent.claimToken),
        isNotNull(adapterSessionClaims.ownerInstanceId),
        buildAgentGuard(tables, acquisition.agentId, acquisition.sessionId, 'live'),
        ...(ownerAuthorization === undefined ? [] : [ownerAuthorization]),
        ...(expectedOwner === undefined ? [] : [expectedOwner]),
      ),
    )
    .returning();

  return updated;
}

/**
 * Decide which storage-provable fact permits replacing an incumbent.
 *
 * Legacy rows have no owner identity, so no replacement authorization applies
 * to them. Movement has its narrower same-generation adoption rule at its own
 * fast path.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param acquisition - Generation contending for the key.
 * @param incumbent - Generation currently holding the key.
 * @param namedToken - Whether the caller explicitly named this generation.
 * @returns The authorization to repeat in the takeover UPDATE, or `undefined`.
 */
export async function resolveTakeoverAuthorization(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  acquisition: ClaimAcquisition,
  incumbent: ClaimRow,
  namedToken: boolean,
): Promise<TakeoverAuthorization | undefined> {
  // An unknown process owner cannot satisfy any takeover predicate. The one
  // migration bridge is movement's same-agent fast path, which adopts the row
  // without replacing its generation.
  if (incumbent.ownerInstanceId === null) return undefined;
  if (namedToken) return 'named-token';

  if (
    incumbent.status === 'held' &&
    incumbent.agentId === acquisition.agentId &&
    incumbent.ownerInstanceId === acquisition.ownerInstanceId
  ) {
    return 'same-instance';
  }

  const { runtimeInstances } = tables;
  const [owner] = await tx
    .select()
    .from(runtimeInstances)
    .where(
      and(
        eq(runtimeInstances.instanceId, incumbent.ownerInstanceId),
        eq(runtimeInstances.machineId, incumbent.machineId),
      ),
    )
    .limit(1);
  if (owner?.retiredAt !== null && owner?.retiredAt !== undefined) return 'owner-retired';

  if (acquisition.topology === 'machine-exclusive') {
    const [requester] = await tx
      .select()
      .from(runtimeInstances)
      .where(
        and(
          eq(runtimeInstances.instanceId, acquisition.ownerInstanceId),
          eq(runtimeInstances.machineId, acquisition.machineId),
        ),
      )
      .limit(1);
    if (owner !== undefined && requester !== undefined && requester.incarnation > owner.incarnation) {
      return 'owner-superseded';
    }
  }

  return undefined;
}
