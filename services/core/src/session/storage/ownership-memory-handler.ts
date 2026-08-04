/**
 * In-memory handlers for the `storage:sessionOwnership` namespace.
 *
 * The volatile twin of `ownership-drizzle-handler.ts`: same five operations,
 * same invariant — exactly one runtime owns a provider-native session within its
 * machine/adapter namespace, agent currency may only be written by the current
 * claim generation, and the session row's currency snapshot mirrors the
 * designated lead's.
 *
 * **Where atomicity comes from.** The SQL backend gets it from a transaction;
 * here it comes from never `await`-ing between a state read and its paired
 * write. Every handler body below is synchronous end to end, so no other bus
 * request can interleave between a decision and the write it authorizes. An
 * `await` introduced inside these bodies would silently drop that guarantee.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AdapterSessionClaimRecord,
  AdapterSessionCurrencySnapshot,
  AdapterSessionCurrencyState,
  MakaioSessionAgent,
  SessionOwnershipClaimRequest,
  SessionOwnershipClaimResult,
  SessionOwnershipSettleCurrencyRequest,
  SessionOwnershipSettleCurrencyResult,
} from '@makaio/contracts';
import { SessionOwnershipStorageSubjects } from '@makaio/contracts';
import { type SessionStorageMemoryState, createSessionStorageMemoryState } from './memory-store.js';

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Find the claim row whose ownership key matches `(machineId, adapterId, providerSessionId)`.
 * @param claims - In-memory claims store
 * @param machineId - Machine component of the ownership key
 * @param adapterId - Adapter component of the ownership key
 * @param providerSessionId - Provider session component of the ownership key
 * @returns The matching claim, or `undefined` when the key is unowned
 */
function findClaimByKey(
  claims: Map<string, AdapterSessionClaimRecord>,
  machineId: string,
  adapterId: string,
  providerSessionId: string,
): AdapterSessionClaimRecord | undefined {
  for (const claim of claims.values()) {
    if (
      claim.machineId === machineId &&
      claim.adapterId === adapterId &&
      claim.providerSessionId === providerSessionId
    ) {
      return claim;
    }
  }
  return undefined;
}

/**
 * Find the claim row that carries the given `claimToken`.
 * @param claims - In-memory claims store
 * @param claimToken - Opaque generation identifier to search for
 * @returns The matching claim, or `undefined` when no claim carries the token
 */
function findClaimByToken(
  claims: Map<string, AdapterSessionClaimRecord>,
  claimToken: string,
): AdapterSessionClaimRecord | undefined {
  for (const claim of claims.values()) {
    if (claim.claimToken === claimToken) return claim;
  }
  return undefined;
}

/**
 * The highest fence any claim the agent currently holds carries, or `0`.
 * @param claims - In-memory claims store
 * @param agentId - Agent whose live claims are inspected
 * @returns Highest live claim fence, or `0` when the agent holds none
 */
function maxLiveClaimFence(claims: Map<string, AdapterSessionClaimRecord>, agentId: string): number {
  let highest = 0;
  for (const claim of claims.values()) {
    if (claim.agentId === agentId && claim.fence > highest) highest = claim.fence;
  }
  return highest;
}

/**
 * Allocate a fence strictly above everything the claiming agent already carries.
 *
 * A fence is totally ordered **per agent**, not per ownership key: the floor is
 * the agent's own currency fence and every claim it still holds — so a second key
 * taken mid-movement can never share a fence with the first — plus, on a
 * takeover, the superseded row's fence.
 *
 * The SQL twin is `fenceAllocation` in `ownership-drizzle-rows.ts`, which has to
 * spell that floor as scalar subqueries so its write stays the transaction's
 * first statement. Here the whole claim path is synchronous, so nothing can move
 * the floor between reading it and storing the row.
 * @param state - Shared in-memory state
 * @param agentId - Agent the claim is being allocated for
 * @param floor - The part of the floor known outside the agent's own state: the
 *   superseded row's fence on a takeover, `0` on a fresh acquisition
 * @returns The fence to store on the claim row
 */
function allocateFence(state: SessionStorageMemoryState, agentId: string, floor: number): number {
  const currencyFence = state.agents.get(agentId)?.currencyFence ?? 0;
  return 1 + Math.max(floor, currencyFence, maxLiveClaimFence(state.claims, agentId));
}

/** The currency pair a promoted lead publishes onto its session row. */
interface LeadCurrencyMirror {
  /** Resume target to store, or `undefined` when the state names none. */
  readonly currentAdapterSessionId: string | undefined;
  /** Currency state to store, expressed in the session row's own terms. */
  readonly currentAdapterSessionIdState: AdapterSessionCurrencyState;
}

/**
 * Resolve the currency pair a session's lead publishes onto its session row.
 *
 * Both writers of that snapshot go through here — the claim that promotes a new
 * lead, and the settle that moves the standing lead's currency on — because both
 * can otherwise leave the session advertising a resume target no agent holds.
 *
 * The pair is *resolved*, not copied: `inherited` does not name a provider
 * session, it points at the row's own `adapterSessionId`, and the two rows have
 * different origins — the session keeps the one it was imported from, while a
 * lead that joined it carries its own. Copying `inherited` across would leave
 * the session resolving to its *own* origin while the lead resolves elsewhere.
 *
 * Only the pair's meaning is translated, never invented: the result is exactly
 * what `resolveResumableAdapterSessionId` yields for the lead, re-expressed in
 * the only terms the session row has for it — `inherited` when that is the
 * session's own origin, `confirmed` when it is some other provider session, and
 * `moved` when the lead has nothing resumable at all. `confirmed` and `moved`
 * already name their target independently of the row's origin and are mirrored
 * unchanged.
 * @param agent - Lead agent whose currency the session snapshot mirrors
 * @param sessionOrigin - The session row's own immutable origin identity
 * @returns The currency pair to store on the session row
 */
function resolveLeadCurrencyMirror(agent: MakaioSessionAgent, sessionOrigin: string | null): LeadCurrencyMirror {
  const state = agent.currentAdapterSessionIdState ?? 'inherited';
  if (state !== 'inherited') {
    return { currentAdapterSessionId: agent.currentAdapterSessionId, currentAdapterSessionIdState: state };
  }
  const leadOrigin = agent.adapterSessionId ?? null;
  if (leadOrigin === sessionOrigin) {
    return { currentAdapterSessionId: undefined, currentAdapterSessionIdState: 'inherited' };
  }
  if (leadOrigin === null) {
    return { currentAdapterSessionId: undefined, currentAdapterSessionIdState: 'moved' };
  }
  return { currentAdapterSessionId: leadOrigin, currentAdapterSessionIdState: 'confirmed' };
}

/**
 * Result of the lead designation sub-procedure.
 *
 * - `ok` — the designation either succeeded or was already satisfied.
 * - `conflict` — the session's current lead does not match the expectation.
 */
type LeadOutcome =
  | { readonly kind: 'ok'; readonly leadDesignated: boolean }
  | { readonly kind: 'conflict'; readonly currentLeadAgentId: string | null };

/**
 * Designate the claiming agent as its session's lead, compare-and-swap style.
 *
 * All reads and the optional write happen synchronously — the caller must not
 * `await` between calling this function and acting on its result.
 *
 * The SQL backend repeats the claiming agent's session membership as a condition
 * of its designating UPDATE, because a whole-record write can move that agent
 * between the claim write and the designation. Here `agent` was resolved in this
 * same synchronous block and nothing can have run since, so the membership the
 * caller established still holds and the designation needs no guard of its own.
 *
 * A designation that actually promotes a new lead also publishes that lead's
 * currency onto the session row, in the same synchronous block: the session
 * snapshot is defined as the designated lead's currency, so leaving the previous
 * lead's pair standing would publish a currency no agent holds. The pair is
 * resolved onto the session row's own terms rather than copied — see
 * {@link resolveLeadCurrencyMirror}. The already-lead case writes nothing and
 * therefore mirrors nothing: that snapshot is `settleCurrency`'s to keep.
 *
 * A request that carries no designation is the same `ok` with nothing designated,
 * decided here rather than at each call site: every claim path ends in the same
 * "designate, then report `leadDesignated`" shape, and only the rollback of an
 * already-written claim differs between them.
 * @param state - Shared in-memory state
 * @param payload - Claim request carrying the optional designation, the session
 *   being designated and the lead the caller expects to find (`null` = expects no
 *   lead)
 * @param agent - Agent being designated as lead, whose currency the snapshot mirrors
 * @returns Lead outcome (ok or conflict)
 */
function designateLead(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  agent: MakaioSessionAgent,
): LeadOutcome {
  if (payload.designateLead === undefined) return { kind: 'ok', leadDesignated: false };
  const expectedLeadAgentId = payload.designateLead.expectedLeadAgentId;

  const session = state.sessions.get(payload.sessionId);
  if (session === undefined) {
    return { kind: 'conflict', currentLeadAgentId: null };
  }
  // Already satisfied — the session already names this agent as lead.
  if (session.leadAgentId === agent.agentId) {
    return { kind: 'ok', leadDesignated: false };
  }
  // CAS pre-check: the stored lead must match the caller's expectation.
  if ((session.leadAgentId ?? null) !== expectedLeadAgentId) {
    return { kind: 'conflict', currentLeadAgentId: session.leadAgentId ?? null };
  }
  // Write the designation in-place (no await between here and callers acting on result).
  const mirror = resolveLeadCurrencyMirror(agent, session.adapterSessionId ?? null);
  session.leadAgentId = agent.agentId;
  session.currentAdapterSessionId = mirror.currentAdapterSessionId;
  session.currentAdapterSessionIdState = mirror.currentAdapterSessionIdState;
  return { kind: 'ok', leadDesignated: true };
}

/**
 * Assert that a currency pair satisfies the `confirmed ↔ id !== null` invariant.
 *
 * The request schema already enforces this before the handler sees the payload,
 * but the in-memory backend must also refuse to store a violating pair,
 * mirroring the SQL backends' CHECK constraints.
 * @param id - Candidate `currentAdapterSessionId`
 * @param currState - Candidate `currentAdapterSessionIdState`
 */
function assertCurrencyPairing(id: string | null, currState: string): void {
  if ((currState === 'confirmed') !== (id !== null)) {
    throw new Error(
      `Currency pairing invariant violated: confirmed ↔ id !== null (state="${currState}", id=${id === null ? 'null' : 'present'})`,
    );
  }
}

/**
 * Build the currency snapshot for an agent row, mapping absent fields to `null`.
 *
 * The contract models "never known" as `null`, so an absent field must not stay
 * `undefined` — that would make an unwritten currency indistinguishable from a
 * missing property.
 * @param agent - Agent whose currency is being read
 * @returns Currency snapshot with `null` for absent fields
 */
function agentCurrencySnapshot(agent: MakaioSessionAgent): AdapterSessionCurrencySnapshot {
  return {
    adapterSessionId: agent.adapterSessionId ?? null,
    currentAdapterSessionId: agent.currentAdapterSessionId ?? null,
    currentAdapterSessionIdState: agent.currentAdapterSessionIdState ?? 'inherited',
  };
}

/**
 * Rows a claim must reference, or the refusal to report instead.
 */
type ClaimTargets =
  | { readonly kind: 'ok'; readonly agent: MakaioSessionAgent }
  | { readonly kind: 'refused'; readonly result: SessionOwnershipClaimResult };

/**
 * Resolve the rows a claim references before anything is written.
 *
 * The SQL backend gets these guards from the acquiring statement's SELECT and
 * its foreign keys; here they are stated directly, so a claim naming a row that
 * does not exist is the contract's `not-found` on both backends rather than a
 * store failure on one of them.
 *
 * The membership equality is one of those guards, not an extra check: a claim
 * names an agent *in a session*, and an agent that belongs elsewhere makes that
 * pair non-existent — hence `missing: 'agent'`. Without it a caller could file
 * the key under a session the owning agent has nothing to do with and, with a
 * lead designation attached, hand that session's lead to it. A session that does
 * not exist at all is the more specific finding and is reported first.
 *
 * The token-uniqueness rejection asks whether the token names a generation *this
 * call is not the one who took it*. `incumbent` is that exception: a retry comes
 * here carrying the very token its own row holds, and a claim row can only be
 * its own foreign generation if it is a different row.
 * @param state - Shared in-memory state
 * @param payload - Claim request being acquired, taken over or repeated
 * @param incumbent - Claim row this call already operates on, whose token is
 *   therefore the caller's own; omitted when the call mints a fresh generation
 *   on a free key
 * @returns The claiming agent, or the `not-found` outcome to report
 * @throws When the caller's `claimToken` already names a *different* generation
 *   — tokens are unique per generation, so a reused one is a caller bug rather
 *   than a modeled outcome.
 */
function resolveClaimTargets(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  incumbent?: AdapterSessionClaimRecord,
): ClaimTargets {
  // The session is asked first, so a request naming neither an existing session
  // nor an existing agent reports the more specific of the two.
  if (!state.sessions.has(payload.sessionId)) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'session' } };
  }
  const agent = state.agents.get(payload.agentId);
  if (agent === undefined || agent.sessionId !== payload.sessionId) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'agent' } };
  }
  const tokenHolder = findClaimByToken(state.claims, payload.claimToken);
  if (tokenHolder !== undefined && tokenHolder.claimId !== incumbent?.claimId) {
    // The SQL backends fail here on `uniq_adapter_session_claims_token`; the
    // message mirrors that shape so a caller that reuses a token sees the same
    // failure regardless of which backend is wired up.
    throw new Error(
      `UNIQUE constraint failed: adapter_session_claims.claim_token (uniq_adapter_session_claims_token): "${payload.claimToken}" is already in use`,
    );
  }
  return { kind: 'ok', agent };
}

/**
 * Take a free ownership key.
 *
 * The claim is written before the lead designation runs and rolled back when
 * that designation conflicts, so a `lead-conflict` leaves nothing behind — the
 * same all-or-nothing outcome the SQL backend gets from its transaction.
 * @param state - Shared in-memory state
 * @param payload - Claim request being acquired
 * @returns The modeled claim outcome
 */
function acquireFreeKey(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
): SessionOwnershipClaimResult {
  const targets = resolveClaimTargets(state, payload);
  if (targets.kind === 'refused') return targets.result;

  const now = Date.now();
  const claimId = crypto.randomUUID();
  const claim: AdapterSessionClaimRecord = {
    claimId,
    machineId: payload.machineId,
    adapterId: payload.adapterId,
    adapterName: payload.adapterName,
    providerSessionId: payload.providerSessionId,
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    claimToken: payload.claimToken,
    fence: allocateFence(state, payload.agentId, 0),
    status: 'held',
    claimedAt: now,
    updatedAt: now,
  };

  state.claims.set(claimId, structuredClone(claim));

  const lead = designateLead(state, payload, targets.agent);
  if (lead.kind === 'conflict') {
    state.claims.delete(claimId);
    return { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId };
  }
  return { outcome: 'claimed', claim: structuredClone(claim), leadDesignated: lead.leadDesignated };
}

/**
 * Take over the generation the caller named, fencing the previous one out.
 *
 * The new fence rises strictly above the superseded row's fence, the taking
 * agent's currency fence, and every claim that agent still holds — the per-agent
 * total order the contract states, which is what keeps generations comparable
 * after the agent's provider session moves to another key. A failing lead
 * designation restores the superseded generation exactly as it stood.
 *
 * The SQL backend re-states the superseded token as a condition of its UPDATE
 * and classifies the zero-row case — a competitor may commit between its
 * classifying read and its write. Here there is no such window and therefore no
 * such branch: `existing` is the very object the claims map holds, read in the
 * same synchronous block, so it cannot have been released or superseded in
 * between. A compare-and-swap spelled out anyway could only ever pass, and its
 * unreachable failure branch would have to invent a holder to report.
 * @param state - Shared in-memory state
 * @param payload - Claim request carrying the `supersedes` token
 * @param existing - Claim row currently holding the key
 * @returns The modeled claim outcome
 */
function takeOverClaim(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  existing: AdapterSessionClaimRecord,
): SessionOwnershipClaimResult {
  const targets = resolveClaimTargets(state, payload, existing);
  if (targets.kind === 'refused') return targets.result;

  const now = Date.now();
  const updated: AdapterSessionClaimRecord = {
    ...existing,
    claimToken: payload.claimToken,
    fence: allocateFence(state, payload.agentId, existing.fence),
    agentId: payload.agentId,
    sessionId: payload.sessionId,
    adapterName: payload.adapterName,
    status: 'held',
    claimedAt: now,
    updatedAt: now,
  };

  state.claims.set(existing.claimId, structuredClone(updated));

  const lead = designateLead(state, payload, targets.agent);
  if (lead.kind === 'conflict') {
    state.claims.set(existing.claimId, structuredClone(existing));
    return { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId };
  }
  return { outcome: 'claimed', claim: structuredClone(updated), leadDesignated: lead.leadDesignated };
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
 * Both refuse before {@link designateLead} runs. Designating a lead off a generation
 * that has lost its settle authority is exactly the state the settle guards
 * refuse: the session would name a lead whose currency nothing may ever publish
 * again.
 *
 * The retry writes no claim, so a conflicting lead designation has nothing to
 * roll back — the generation the caller already holds stays untouched. A
 * designation that promotes the caller still mirrors its currency onto the
 * session, exactly as a fresh acquisition would: the promotion is the same
 * write either way, and only the claim behind it is older.
 * @param state - Shared in-memory state
 * @param payload - Claim request repeating the holder's token
 * @param existing - Claim row currently holding the key
 * @returns The modeled claim outcome
 */
function repeatClaim(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  existing: AdapterSessionClaimRecord,
): SessionOwnershipClaimResult {
  if (existing.status !== 'held') {
    return { outcome: 'already-claimed', holder: structuredClone(existing) };
  }

  const targets = resolveClaimTargets(state, payload, existing);
  if (targets.kind === 'refused') return targets.result;

  const lead = designateLead(state, payload, targets.agent);
  if (lead.kind === 'conflict') {
    return { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId };
  }
  return { outcome: 'idempotent', claim: structuredClone(existing), leadDesignated: lead.leadDesignated };
}

/**
 * Take or take over the ownership claim on a provider session.
 *
 * A key held by another generation is `already-claimed` even when the lead
 * expectation is also wrong: ownership is decided before designation.
 * @param state - Shared in-memory state
 * @param payload - Claim request
 * @returns The modeled claim outcome
 */
function runClaim(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
): SessionOwnershipClaimResult {
  const existing = findClaimByKey(state.claims, payload.machineId, payload.adapterId, payload.providerSessionId);
  if (existing === undefined) return acquireFreeKey(state, payload);
  if (existing.claimToken === payload.claimToken) {
    // A token match is only this caller's own retry while the row still names
    // the same agent and session. A token presented by anyone else is a
    // competitor holding the key — never an idempotent success that would also
    // let it run the lead designation.
    if (existing.agentId === payload.agentId && existing.sessionId === payload.sessionId) {
      return repeatClaim(state, payload, existing);
    }
    return { outcome: 'already-claimed', holder: structuredClone(existing) };
  }
  if (payload.supersedes?.claimToken === existing.claimToken) return takeOverClaim(state, payload, existing);
  return { outcome: 'already-claimed', holder: structuredClone(existing) };
}

// ─── Per-subject registration ────────────────────────────────────────────────

/**
 * Register the handler for `storage:sessionOwnership.read`.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerReadHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.read, (ctx) => {
    const { agentId } = ctx.payload;
    const agent = state.agents.get(agentId);
    if (agent === undefined) {
      ctx.setResult({ ownership: null });
      return;
    }
    const agentClaims = Array.from(state.claims.values())
      .filter((claim) => claim.agentId === agentId)
      .sort((a, b) => a.fence - b.fence || a.claimId.localeCompare(b.claimId));

    ctx.setResult({
      ownership: {
        agentId,
        sessionId: agent.sessionId,
        currency: agentCurrencySnapshot(agent),
        revision: agent.revision ?? 0,
        currencyFence: agent.currencyFence ?? 0,
        claims: agentClaims.map((claim) => structuredClone(claim)),
      },
    });
  });
}

/**
 * Refuse a settle the caller may not perform, or one that changes nothing.
 *
 * Authority before order: a caller whose claim row is gone is `not-owner` even
 * when its fence is also stale, because there is no generation left to name as
 * the one that outranked it. A live claim carrying a *different* fence than the
 * caller presented is `not-owner` for the same reason — authority is the pair
 * token + fence, and that pair does not exist, so `superseded` would have no
 * outranking generation to name. Idempotency is then decided before the revision
 * compare-and-swap on purpose — the movement seam re-announces on every
 * unconfirmed dispatch and on every confirmation, so a repeat must not be
 * reported as a lost race.
 *
 * A claim is an ownership of an agent *in a session*, so it must still be filed
 * under the session the agent is currently in. `storage:agent.set` can move an
 * agent to another session; a generation taken while it was in the old one is
 * `not-owner` from then on — nothing outranked it, it simply stopped being an
 * ownership of this agent. Without that check it would keep settling the agent
 * and, if the agent is lead in its new session, mirror the currency onto a
 * session its holder was never part of.
 * @param state - Shared in-memory state
 * @param agent - Agent row the settle targets
 * @param payload - Settle request
 * @returns The outcome to report, or `undefined` when the caller may write
 */
function refuseSettle(
  state: SessionStorageMemoryState,
  agent: MakaioSessionAgent,
  payload: SessionOwnershipSettleCurrencyRequest,
): SessionOwnershipSettleCurrencyResult | undefined {
  const { agentId, claimToken, fence, expectedRevision, target } = payload;
  const revision = agent.revision ?? 0;
  const currencyFence = agent.currencyFence ?? 0;

  const claim = findClaimByToken(state.claims, claimToken);
  if (
    claim === undefined ||
    claim.agentId !== agentId ||
    claim.sessionId !== agent.sessionId ||
    claim.status !== 'held' ||
    claim.fence !== fence
  ) {
    return { outcome: 'not-owner' };
  }
  if (fence < currencyFence) {
    return { outcome: 'superseded', currentFence: currencyFence };
  }

  const current = agentCurrencySnapshot(agent);
  if (
    current.currentAdapterSessionId === target.currentAdapterSessionId &&
    current.currentAdapterSessionIdState === target.currentAdapterSessionIdState &&
    currencyFence === fence
  ) {
    return { outcome: 'idempotent', revision, currency: current, sessionSnapshotUpdated: false };
  }
  if (revision !== expectedRevision) {
    return { outcome: 'currency-changed', revision, currency: current };
  }
  return undefined;
}

/**
 * Register the handler for `storage:sessionOwnership.settleCurrency`.
 *
 * The write itself is unconditional: {@link refuseSettle} has already decided
 * that this caller may perform it.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSettleCurrencyHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.settleCurrency, (ctx) => {
    const { agentId, fence, expectedRevision, target } = ctx.payload;

    const agent = state.agents.get(agentId);
    if (agent === undefined) {
      ctx.setResult({ outcome: 'not-found' });
      return;
    }
    const refusal = refuseSettle(state, agent, ctx.payload);
    if (refusal !== undefined) {
      ctx.setResult(refusal);
      return;
    }

    // Mirrors the SQL backends' CHECK constraint before anything is written.
    assertCurrencyPairing(target.currentAdapterSessionId, target.currentAdapterSessionIdState);

    const adapterSessionId = agent.adapterSessionId ?? null;
    agent.currentAdapterSessionId = target.currentAdapterSessionId ?? undefined;
    agent.currentAdapterSessionIdState = target.currentAdapterSessionIdState;
    agent.currencyFence = fence;
    agent.revision = expectedRevision + 1;
    agent.lastActivityAt = Date.now();

    // The session row's snapshot mirrors the designated lead's currency only.
    // `sessionSnapshotUpdated` is derived from the write actually happening, the
    // same way the SQL backend derives it from the rows its guarded mirror
    // UPDATE affected.
    //
    // The pair is resolved onto the session row's own terms rather than copied
    // from the target — see {@link resolveLeadCurrencyMirror}. It is read off
    // the agent, which the lines above have already settled, so what is mirrored
    // is the currency as it now stands.
    const session = state.sessions.get(agent.sessionId);
    let sessionSnapshotUpdated = false;
    if (session !== undefined && session.leadAgentId === agentId) {
      const mirror = resolveLeadCurrencyMirror(agent, session.adapterSessionId ?? null);
      session.currentAdapterSessionId = mirror.currentAdapterSessionId;
      session.currentAdapterSessionIdState = mirror.currentAdapterSessionIdState;
      sessionSnapshotUpdated = true;
    }

    ctx.setResult({
      outcome: 'settled',
      revision: expectedRevision + 1,
      currency: { adapterSessionId, ...target },
      sessionSnapshotUpdated,
    });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.release`.
 *
 * Only a clean release removes the row and frees the ownership key; `releasing`
 * and `abandoned` keep blocking it, because the provider process may still be
 * alive and a second owner attaching to a live conversation is the outcome this
 * aggregate exists to prevent.
 *
 * **Asymmetry with `settleCurrency`, deliberately.** The settle additionally
 * requires the claim to be filed under the agent's *current* session; the
 * release does not. A settle exercises the claim as authority over an agent's
 * currency, so a claim that no longer represents an ownership of that agent's
 * session may not carry it. A release only gives the claim up, and giving
 * something up needs no authority beyond having been the one who took it — token
 * plus agent. Requiring session membership here would strand exactly the claims
 * that most need retiring: an agent reassigned to another session would leave
 * its old generation unreleasable, blocking the ownership key forever.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerReleaseHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.release, (ctx) => {
    const { agentId, claimToken, disposition } = ctx.payload;

    const claim = findClaimByToken(state.claims, claimToken);
    if (claim === undefined) {
      ctx.setResult({ outcome: 'not-found' });
      return;
    }
    if (claim.agentId !== agentId) {
      ctx.setResult({ outcome: 'not-owner', holder: structuredClone(claim) });
      return;
    }
    if (disposition === 'released') {
      // **Token and agent are the whole condition — the status is not consulted,
      // deliberately**, exactly as in the SQL twin. A generation already marked
      // `abandoned` is therefore still cleanly releasable by a delayed
      // `released` of its own, which looks like it bypasses "blocks until a
      // takeover" and does not: `abandoned` is a *presumption* filed by an
      // observer that the owner died with teardown unconfirmed, and it blocks
      // everyone else because no one else can know. A `released` carrying that
      // generation's own token is the one party who can know refuting it, and
      // the row's purpose — keeping a possibly-live provider conversation from
      // being attached to twice — is fulfilled rather than bypassed. Requiring
      // `held` here would strand the key against the very owner coming back to
      // confirm its own teardown.
      state.claims.delete(claim.claimId);
      ctx.setResult({ outcome: 'released' });
      return;
    }

    const marked: AdapterSessionClaimRecord = { ...claim, status: disposition, updatedAt: Date.now() };
    state.claims.set(claim.claimId, structuredClone(marked));
    ctx.setResult({ outcome: 'marked', claim: structuredClone(marked) });
  });
}

/**
 * Register the handler for `storage:sessionOwnership.listClaims`.
 * @param bus - The bus instance to register the handler on
 * @param state - Shared in-memory state
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListClaimsHandler(bus: IMakaioBus, state: SessionStorageMemoryState): () => void {
  return bus.on(SessionOwnershipStorageSubjects.listClaims, (ctx) => {
    const { machineId, adapterId, providerSessionId, statuses } = ctx.payload;

    const claims = Array.from(state.claims.values()).filter(
      (claim) =>
        claim.machineId === machineId &&
        (adapterId === undefined || claim.adapterId === adapterId) &&
        (providerSessionId === undefined || claim.providerSessionId === providerSessionId) &&
        (statuses === undefined || statuses.includes(claim.status)),
    );
    claims.sort((a, b) => a.claimedAt - b.claimedAt || a.claimId.localeCompare(b.claimId));

    ctx.setResult({ claims: claims.map((claim) => structuredClone(claim)) });
  });
}

// ─── Handler registration ─────────────────────────────────────────────────────

/**
 * Register in-memory session ownership storage handlers.
 *
 * Pass a shared `SessionStorageMemoryState` to make these handlers operate on
 * the same session and agent rows as `registerMemorySessionStorage` and
 * `registerMemoryAgentStorage`. Omit it (or pass `undefined`) to get an isolated
 * private store — useful only for unit tests that exercise ownership without
 * needing real sessions or agents.
 * @param bus - The bus instance to register handlers on
 * @param state - Shared in-memory state; defaults to a new isolated instance
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerMemorySessionOwnershipStorage(
  bus: IMakaioBus,
  state: SessionStorageMemoryState = createSessionStorageMemoryState(),
): () => void {
  const unsubs = [
    registerReadHandler(bus, state),
    bus.on(SessionOwnershipStorageSubjects.claim, (ctx) => {
      ctx.setResult(runClaim(state, ctx.payload));
    }),
    registerSettleCurrencyHandler(bus, state),
    registerReleaseHandler(bus, state),
    registerListClaimsHandler(bus, state),
  ];

  return () => {
    for (let index = unsubs.length - 1; index >= 0; index -= 1) unsubs[index]?.();
  };
}
