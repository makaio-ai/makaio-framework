/**
 * The `storage:sessionOwnership.claim` operation, in-memory side.
 *
 * Takes and takes over ownership keys, and runs the sessions phase — the lead
 * designation and the currency mirror that goes with it. The volatile twin of
 * `ownership-drizzle-handler.ts`'s claim half, and held to the same contract.
 *
 * **Where atomicity comes from.** The SQL backend gets it from a transaction;
 * here it comes from never `await`-ing between a state read and its paired
 * write. Every function below is synchronous end to end, so no other bus request
 * can interleave between a decision and the write it authorizes. An `await`
 * introduced into these bodies would silently drop that guarantee.
 * @packageDocumentation
 */
import {
  isInactiveSafeLeadDesignationMutation,
  normalizeSessionOwnershipClaimRequest,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipClaimResult,
} from '@makaio/contracts/session';
import type { SessionStorageMemoryState } from './memory-store.js';
import { classifyRecoveryGuard } from './ownership-recovery-guard.js';
import {
  agentCurrencySnapshot,
  allocateFence,
  ensureMemoryRuntimeInstance,
  findClaimByKey,
  findClaimByToken,
  memoryMayTakeOver,
  resolveLeadCurrencyMirror,
  runtimeInstanceKey,
} from './ownership-memory-rows.js';

/**
 * Result of the lead designation sub-procedure.
 *
 * - `ok` — the designation either succeeded, was already satisfied, or was not
 *   requested at all. `previousLeadAgentId` is honest either way.
 * - `conflict` — the session's current lead does not match the expectation.
 * - `refused` — the session does not exist, or the agent may not be designated.
 */
type LeadOutcome =
  | { readonly kind: 'ok'; readonly leadDesignated: boolean; readonly previousLeadAgentId: string | null }
  | { readonly kind: 'conflict'; readonly currentLeadAgentId: string | null }
  | { readonly kind: 'refused'; readonly result: SessionOwnershipClaimResult };

/**
 * Commit the lifecycle half of a successful guarded reservation.
 * @param agent - Locked in-memory agent row.
 * @param payload - Claim request carrying the optional recovery guard.
 * @param result - Claim decision whose success gates the status transition.
 * @returns The unchanged claim result.
 */
function finishRecoveryClaim(
  agent: MakaioSessionAgent | undefined,
  payload: SessionOwnershipClaimRequest,
  result: SessionOwnershipClaimResult,
): SessionOwnershipClaimResult {
  if (
    payload.recoveryGuard !== undefined &&
    agent !== undefined &&
    (result.outcome === 'claimed' || result.outcome === 'idempotent')
  ) {
    const recoveryAttemptId = payload.recoveryAttemptId;
    if (recoveryAttemptId === undefined) throw new Error('guarded recovery claim requires recoveryAttemptId');
    const preimage = {
      status: agent.status,
      adapterId: agent.adapterId,
      ...(agent.runtimeOwner === undefined
        ? {}
        : {
            binding: {
              adapterId: agent.adapterId,
              ownerMachineId: agent.runtimeOwner.machineId,
              ownerInstanceId: agent.runtimeOwner.instanceId,
            },
          }),
      ...(agent.recoveryAttemptId === undefined ? {} : { recoveryAttemptId: agent.recoveryAttemptId }),
    };
    agent.status = 'starting';
    agent.adapterId = payload.adapterId;
    if (payload.ownerInstance === undefined) throw new Error('guarded recovery claim requires ownerInstance');
    agent.runtimeOwner = { machineId: payload.machineId, instanceId: payload.ownerInstance.instanceId };
    agent.recoveryAttemptId = recoveryAttemptId;
    agent.lastActivityAt = Date.now();
    return { ...result, recovery: { attemptId: recoveryAttemptId, preimage } };
  }
  return result;
}

/**
 * Run the sessions phase of a claim: read the designation, then move it.
 *
 * All reads and the optional write happen synchronously — the caller must not
 * `await` between calling this function and acting on its result.
 *
 * The SQL backend takes the session row with a self-update before reading the
 * lead off it, and repeats the claiming agent's membership as a condition of its
 * designating UPDATE, because concurrent writers exist between its statements.
 * Here `agent` was resolved in this same synchronous block and nothing can have
 * run since, so the pre-image is simply the stored value and the designation
 * needs no guard of its own.
 *
 * A designation that actually promotes a new lead also publishes that lead's
 * currency onto the session row, in the same synchronous block: the session
 * snapshot is defined as the designated lead's currency, so leaving the previous
 * lead's pair standing would publish a currency no agent holds. The pair is
 * resolved onto the session row's own terms rather than copied — see
 * {@link resolveLeadCurrencyMirror}. Two cases mirror nothing: the already-lead
 * retry, whose snapshot is the settle's to keep, and a **clear**, which leaves
 * the last lead's snapshot standing rather than falling back to the row's own
 * origin.
 *
 * A **clear** also drops the "already satisfied" disjunct and the liveness
 * demand: unsetting is never idempotent-by-self-match, and unsetting a departed
 * lead is giving authority up, which a removed agent must still be able to do.
 *
 * A request that carries no designation is the same `ok` with nothing
 * designated, decided here rather than at each call site: every claim path ends
 * in the same "designate, then report" shape, and only the rollback of an
 * already-written claim differs between them.
 * @param state - Shared in-memory state
 * @param payload - Claim request carrying the optional designation, the session
 *   being designated and the lead the caller expects to find (`null` = expects no
 *   lead)
 * @param agent - Agent being designated as lead, whose currency the snapshot mirrors
 * @returns Lead outcome (ok, conflict or refusal)
 */
function designateLead(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  agent: MakaioSessionAgent,
): LeadOutcome {
  const session = state.sessions.get(payload.sessionId);
  if (session === undefined) {
    return { kind: 'refused', result: { outcome: 'not-found', missing: 'session' } };
  }
  // Acquisition may only act on a live session. Cleanup-only clear and restore
  // requests must still CAS after closure so a failed replacement cannot leave
  // a stale lead standing or erase the prior one it replaced.
  if (session.status !== 'active' && (session.status !== 'closed' || !isInactiveSafeLeadDesignationMutation(payload))) {
    return { kind: 'refused', result: { outcome: 'session-not-active', status: session.status } };
  }
  const previousLeadAgentId = session.leadAgentId ?? null;
  const designation = payload.designateLead;
  if (designation === undefined) return { kind: 'ok', leadDesignated: false, previousLeadAgentId };

  const clearing = designation.clear === true;
  const target = clearing ? null : agent.agentId;
  // A designation may not be made — or kept — by a removed agent; a clear is
  // exempt, because giving authority up is the one act it must still perform.
  if (!clearing && agent.status === 'disposed') {
    return { kind: 'refused', result: { outcome: 'agent-disposed' } };
  }
  // Already satisfied: the session already names this agent as lead.
  if (!clearing && previousLeadAgentId === agent.agentId) {
    return { kind: 'ok', leadDesignated: false, previousLeadAgentId };
  }
  // CAS: the stored lead must match the caller's expectation.
  if (previousLeadAgentId !== designation.expectedLeadAgentId) {
    return { kind: 'conflict', currentLeadAgentId: previousLeadAgentId };
  }

  session.leadAgentId = target ?? undefined;
  if (!clearing) {
    const mirror = resolveLeadCurrencyMirror(agent, session.adapterSessionId ?? null);
    session.currentAdapterSessionId = mirror.currentAdapterSessionId;
    session.currentAdapterSessionIdState = mirror.currentAdapterSessionIdState;
  }
  return { kind: 'ok', leadDesignated: true, previousLeadAgentId };
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
 * A pair that exists but whose agent is `disposed` is `agent-disposed`: the rows
 * are there, and the refusal is about authority rather than existence.
 * `disposed` is absorbing for ownership — a removed agent may never re-acquire
 * it — so every path that can end in a claim comes through here.
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
  if (agent.status === 'disposed') return { kind: 'refused', result: { outcome: 'agent-disposed' } };
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
 * Report a claim that was taken, or recognized as already taken.
 * @param outcome - Whether this call took the generation or found its own
 * @param claim - The generation as it now stands, or `null` for a keyless reservation
 * @param lead - What the sessions phase established
 * @returns The modeled claim outcome
 */
function takenClaim(
  outcome: 'claimed' | 'idempotent',
  claim: AdapterSessionClaimRecord | null,
  lead: Extract<LeadOutcome, { kind: 'ok' }>,
): SessionOwnershipClaimResult {
  return {
    outcome,
    claim: claim === null ? null : structuredClone(claim),
    leadDesignated: lead.leadDesignated,
    previousLeadAgentId: lead.previousLeadAgentId,
  };
}

/**
 * Take a free ownership key.
 *
 * The claim is written before the lead designation runs and rolled back when
 * that designation is refused, so a `lead-conflict` leaves nothing behind — the
 * same all-or-nothing outcome the SQL backend gets from its transaction.
 * @param state - Shared in-memory state
 * @param payload - Claim request being acquired
 * @returns The modeled claim outcome
 */
function acquireFreeKey(state: SessionStorageMemoryState, payload: KeyedClaimRequest): SessionOwnershipClaimResult {
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
    ownerInstanceId: payload.ownerInstance.instanceId,
    claimToken: payload.claimToken,
    fence: allocateFence(state, payload.agentId, 0),
    status: 'held',
    claimedAt: now,
    updatedAt: now,
  };

  state.claims.set(claimId, structuredClone(claim));

  const lead = designateLead(state, payload, targets.agent);
  if (lead.kind !== 'ok') {
    state.claims.delete(claimId);
    return lead.kind === 'conflict'
      ? { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId }
      : lead.result;
  }
  return takenClaim('claimed', claim, lead);
}

/**
 * Take over the incumbent generation, fencing the previous one out.
 *
 * The new fence rises strictly above the superseded row's fence, the taking
 * agent's currency fence, and every claim that agent still holds — the per-agent
 * total order the contract states, which is what keeps generations comparable
 * after the agent's provider session moves to another key. A failing lead
 * designation restores the superseded generation exactly as it stood.
 *
 * The SQL backend re-states its takeover authorization as a condition of the
 * UPDATE and classifies the zero-row case, because a competitor may commit
 * between its classifying read and its write. Here there is no such window and
 * therefore no such branch:
 * `existing` is the very object the claims map holds, read in the same
 * synchronous block, so it cannot have been released, superseded or revived in
 * between. A compare-and-swap spelled out anyway could only ever pass, and its
 * unreachable failure branch would have to invent a holder to report.
 * @param state - Shared in-memory state
 * @param payload - Claim request taking the key over
 * @param existing - Claim row currently holding the key
 * @returns The modeled claim outcome
 */
function takeOverClaim(
  state: SessionStorageMemoryState,
  payload: KeyedClaimRequest,
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
    ownerInstanceId: payload.ownerInstance.instanceId,
    status: 'held',
    claimedAt: now,
    updatedAt: now,
  };

  state.claims.set(existing.claimId, structuredClone(updated));

  const lead = designateLead(state, payload, targets.agent);
  if (lead.kind !== 'ok') {
    state.claims.set(existing.claimId, structuredClone(existing));
    return lead.kind === 'conflict'
      ? { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId }
      : lead.result;
  }
  return takenClaim('claimed', updated, lead);
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
 *   `not-found` with `missing: 'agent'`, and one that has since been removed is
 *   `agent-disposed` — the same answers every other path gives, through the same
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
  payload: KeyedClaimRequest,
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
  if (lead.kind === 'refused') return lead.result;
  return takenClaim('idempotent', existing, lead);
}

/**
 * Reserve a start that has no ownership key yet.
 *
 * The whole effect is the lead designation and its currency mirror: a fresh
 * start's provider identity does not exist until the provider mints it, so there
 * is nothing to own — but the designation still has to be atomic, compare-and-
 * swap and mirrored. The claims phase is therefore empty: no row, no fence, no
 * token stored, and the request's `claimToken` is never even looked at.
 * @param state - Shared in-memory state
 * @param payload - Claim request carrying no provider session
 * @returns The modeled claim outcome
 */
function runKeylessReservation(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
): SessionOwnershipClaimResult {
  // The agent is asked for first here, unlike a keyed claim: with no claim row
  // to file there is no reference to a session to be missing, so the agent's own
  // existence and membership are what the request stands or falls on.
  const agent = state.agents.get(payload.agentId);
  if (agent === undefined || agent.sessionId !== payload.sessionId) {
    return { outcome: 'not-found', missing: 'agent' };
  }
  if (agent.status === 'disposed' && payload.designateLead?.clear !== true) {
    return { outcome: 'agent-disposed' };
  }

  const lead = designateLead(state, payload, agent);
  if (lead.kind === 'conflict') return { outcome: 'lead-conflict', currentLeadAgentId: lead.currentLeadAgentId };
  if (lead.kind === 'refused') return lead.result;
  return takenClaim('claimed', null, lead);
}

/** A claim request whose ownership key is present — everything but a keyless reservation. */
type KeyedClaimRequest = SessionOwnershipClaimRequest & {
  readonly providerSessionId: string;
  readonly ownerInstance: { readonly instanceId: string };
};

/**
 * Execute the keyed half after the optional recovery snapshot has been checked.
 * @param state - Shared in-memory state.
 * @param payload - Claim request whose provider key is present.
 * @param providerSessionId - Provider key narrowed from the request.
 * @param agent - Claiming agent row, when present.
 * @param existing - Generation observed on the key before any write.
 * @returns The modeled claim outcome.
 */
function runKeyedClaim(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  providerSessionId: string,
  agent: MakaioSessionAgent | undefined,
  existing: AdapterSessionClaimRecord | undefined,
): SessionOwnershipClaimResult {
  const ownerInstance = payload.ownerInstance;
  if (ownerInstance === undefined) throw new Error('keyed session ownership claim requires ownerInstance');
  const ownerKey = runtimeInstanceKey(ownerInstance.instanceId, payload.machineId);
  const ownerAlreadyExisted = state.runtimeInstances.has(ownerKey);
  ensureMemoryRuntimeInstance(state, ownerInstance.instanceId, payload.machineId, Date.now());
  const keyed: KeyedClaimRequest = { ...payload, providerSessionId, ownerInstance };

  if (existing === undefined) {
    const result = acquireFreeKey(state, keyed);
    if (!ownerAlreadyExisted && result.outcome !== 'claimed') state.runtimeInstances.delete(ownerKey);
    return finishRecoveryClaim(agent, payload, result);
  }
  if (existing.claimToken === keyed.claimToken) {
    // A token match is only this caller's own retry while the row still names
    // the same agent and session. A token presented by anyone else is a
    // competitor holding the key — never an idempotent success that would also
    // let it run the lead designation.
    if (existing.agentId === keyed.agentId && existing.sessionId === keyed.sessionId) {
      const result = repeatClaim(state, keyed, existing);
      if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
      return finishRecoveryClaim(agent, payload, result);
    }
    if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
    return { outcome: 'already-claimed', holder: structuredClone(existing) };
  }
  if (
    memoryMayTakeOver(
      state,
      {
        machineId: keyed.machineId,
        agentId: keyed.agentId,
        ownerInstanceId: keyed.ownerInstance.instanceId,
        topology: keyed.topology,
        supersededClaimToken: keyed.supersedes?.claimToken,
      },
      existing,
    )
  ) {
    const result = takeOverClaim(state, keyed, existing);
    if (!ownerAlreadyExisted && result.outcome !== 'claimed') state.runtimeInstances.delete(ownerKey);
    return finishRecoveryClaim(agent, payload, result);
  }
  if (!ownerAlreadyExisted) state.runtimeInstances.delete(ownerKey);
  return { outcome: 'already-claimed', holder: structuredClone(existing) };
}

/**
 * Run the keyless branch, registering a guarded recovery owner before the
 * agent/session phase and undoing a newly allocated volatile row on refusal.
 * @param state - Shared in-memory state.
 * @param payload - Keyless claim request.
 * @param agent - Claiming agent observed for the guard.
 * @returns The reservation outcome.
 */
function runKeylessClaim(
  state: SessionStorageMemoryState,
  payload: SessionOwnershipClaimRequest,
  agent: MakaioSessionAgent | undefined,
): SessionOwnershipClaimResult {
  const ownerInstance = payload.ownerInstance;
  const ownerKey =
    payload.recoveryGuard === undefined || ownerInstance === undefined
      ? undefined
      : runtimeInstanceKey(ownerInstance.instanceId, payload.machineId);
  const ownerAlreadyExisted = ownerKey === undefined || state.runtimeInstances.has(ownerKey);
  if (ownerKey !== undefined && ownerInstance !== undefined) {
    ensureMemoryRuntimeInstance(state, ownerInstance.instanceId, payload.machineId, Date.now());
  }
  const result = runKeylessReservation(state, payload);
  if (ownerKey !== undefined && !ownerAlreadyExisted && result.outcome !== 'claimed') {
    state.runtimeInstances.delete(ownerKey);
  }
  return finishRecoveryClaim(agent, payload, result);
}

/**
 * Take or take over the ownership claim on a provider session — or reserve a
 * start that has no provider session yet.
 *
 * A key held by another generation is `already-claimed` even when the lead
 * expectation is also wrong: ownership is decided before designation.
 *
 * Disposing the incumbent agent does not prove its runtime connector stopped.
 * Such a row therefore remains occupied until explicit supersession or durable
 * runtime identity establishes T1, T3, or T4. A deleted parent needs no takeover:
 * its cascade removes the claim and leaves the key free.
 * @param state - Shared in-memory state
 * @param request - Claim request
 * @returns The modeled claim outcome
 */
export function runClaim(state: SessionStorageMemoryState, request: unknown): SessionOwnershipClaimResult {
  const payload = normalizeSessionOwnershipClaimRequest(request);
  const { providerSessionId } = payload;
  const agent = state.agents.get(payload.agentId);
  const existing =
    providerSessionId === null
      ? undefined
      : findClaimByKey(state.claims, payload.machineId, payload.adapterId, providerSessionId);
  if (payload.recoveryGuard !== undefined && agent !== undefined) {
    const guardRefusal = classifyRecoveryGuard(
      payload,
      {
        status: agent.status,
        adapterId: agent.adapterId,
        runtimeOwner: agent.runtimeOwner,
        recoveryAttemptId: agent.recoveryAttemptId,
        revision: agent.revision ?? 0,
        currencyFence: agent.currencyFence ?? 0,
        currency: agentCurrencySnapshot(agent),
      },
      existing ?? null,
    );
    if (guardRefusal !== undefined) return guardRefusal;
  }

  if (providerSessionId === null) {
    return runKeylessClaim(state, payload, agent);
  }
  return runKeyedClaim(state, payload, providerSessionId, agent, existing);
}
