/**
 * The settle half of the in-memory ownership handlers.
 *
 * `settleCurrency`'s guard and write, shared verbatim with `settleMovement`, and
 * the claims phase a movement runs before them. The volatile twin of
 * `ownership-drizzle-settle.ts` and `ownership-drizzle-movement.ts`, held to the
 * same contract and synchronous end to end for the same reason.
 * @packageDocumentation
 */
import {
  resolveResumableAdapterSessionId,
  type AdapterSessionClaimRecord,
  type AdapterSessionCurrencyTarget,
  type MakaioSessionAgent,
  type OwnershipMovement,
  type SessionOwnershipSettleCurrencyRequest,
  type SessionOwnershipSettleCurrencyResult,
  type SessionOwnershipSettleMovementRequest,
  type SessionOwnershipSettleMovementResult,
} from '@makaio/contracts';
import type { SessionStorageMemoryState } from './memory-store.js';
import {
  agentCurrencySnapshot,
  allocateFence,
  assertCurrencyPairing,
  findClaimByKey,
  findClaimByToken,
  memoryMayTakeOver,
  resolveLeadCurrencyMirror,
} from './ownership-memory-rows.js';

/** Movement request whose runtime owner passed contract validation. */
export type IdentifiedMovementRequest = SessionOwnershipSettleMovementRequest & {
  readonly ownerInstance: { readonly instanceId: string };
};

/**
 * Refuse a settle the caller may not perform, or one that changes nothing.
 *
 * A removed agent is refused first and unconditionally: `disposed` is absorbing
 * for ownership, so its currency may not move again no matter which generation
 * asks, and reporting `not-owner` instead would invite the caller to go looking
 * for a generation that would work.
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

  if (agent.status === 'disposed') return { outcome: 'agent-disposed' };

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
 * Write an agent's currency, and mirror it when the agent leads its session.
 *
 * The volatile twin of `runSettleStatements`, and shared by the same two callers
 * for the same reason: `settleCurrency` and `settleMovement` must settle
 * *identically*, or the two backends would each have two definitions of what a
 * settle is. Synchronous end to end, so nothing can interleave between the
 * refusal decision and the write it authorizes.
 * @param state - Shared in-memory state
 * @param agent - Agent row the settle targets
 * @param payload - Settle request the caller may perform
 * @returns The settle outcome — the refusal, or the write that happened
 */
export function applySettle(
  state: SessionStorageMemoryState,
  agent: MakaioSessionAgent,
  payload: SessionOwnershipSettleCurrencyRequest,
): SessionOwnershipSettleCurrencyResult {
  const refusal = refuseSettle(state, agent, payload);
  if (refusal !== undefined) return refusal;

  const { agentId, fence, expectedRevision, target } = payload;

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

  return {
    outcome: 'settled',
    revision: expectedRevision + 1,
    currency: { adapterSessionId, ...target },
    sessionSnapshotUpdated,
  };
}

/**
 * What the claims phase of a movement produced, and how to undo it.
 *
 * The SQL backend gets all-or-nothing from its transaction. Here it comes from
 * an explicit undo: the claims phase writes before the settle can be judged
 * (the fence it allocates is an *input* to that judgement), so a refused settle
 * has to put the claim table back exactly as it stood. Everything is
 * synchronous, so nothing observes the intermediate state.
 */
export interface MovementClaimsPhase {
  /** The generation the settle writes through. */
  readonly generation: AdapterSessionClaimRecord;
  /** Provider sessions whose keys the movement retired. */
  readonly releasedProviderSessionIds: string[];
  /** Undo every write of the claims phase. */
  readonly rollback: () => void;
}

/**
 * Refuse a movement token that already names another live generation.
 *
 * Tokens are unique per generation, and this is the branch that *stores* the
 * one the request carried — the SQL backends enforce it here through
 * `uniq_adapter_session_claims_token`, and the memory `claim` path already
 * mirrors that. Without the same check the memory backend would quietly accept
 * a reused token and hand two generations one identity, which every later
 * token-keyed release and settle resolves to whichever it finds first.
 *
 * Not a modeled outcome, for the same reason the acquisition path is not: a
 * reused token is a caller minting one per attempt incorrectly, not a race the
 * store arbitrates. The message mirrors the SQL shape so the failure reads the
 * same whichever backend is wired up.
 * @param state - Shared in-memory state
 * @param claimToken - Token the movement carried
 * @param claimId - Row this call is about to write, whose own token is not foreign
 * @throws When the token already names a different generation
 */
function assertMovementTokenIsFree(state: SessionStorageMemoryState, claimToken: string, claimId: string): void {
  const tokenHolder = findClaimByToken(state.claims, claimToken);
  if (tokenHolder === undefined || tokenHolder.claimId === claimId) return;
  throw new Error(
    `UNIQUE constraint failed: adapter_session_claims.claim_token (uniq_adapter_session_claims_token): "${claimToken}" is already in use`,
  );
}

/** A resolved fast-path generation and its claims-phase rollback. */
interface OwnGeneration {
  /** Generation the movement may settle through. */
  readonly generation: AdapterSessionClaimRecord;
  /** Undo the fast path's writes, which are none before a movement settles. */
  readonly rollback: () => void;
}

/**
 * Resolve the movement fast path without crossing process ownership.
 * @param payload - Identified movement request.
 * @param incumbent - Generation currently on the target key.
 * @returns The usable generation, or `undefined` when allocation must arbitrate.
 */
function resolveOwnGeneration(
  payload: IdentifiedMovementRequest,
  incumbent: AdapterSessionClaimRecord | undefined,
): OwnGeneration | undefined {
  if (
    incumbent === undefined ||
    incumbent.agentId !== payload.agentId ||
    incumbent.status !== 'held' ||
    (incumbent.ownerInstanceId !== null && incumbent.ownerInstanceId !== payload.ownerInstance.instanceId)
  ) {
    return undefined;
  }
  return { generation: incumbent, rollback: (): void => {} };
}

/**
 * Adopt a legacy generation after it has successfully settled a movement.
 *
 * A refusal leaves the pre-existing claim untouched, so its response can report
 * exactly the same owner identity that reads and lists expose.
 * @param state - Shared in-memory state.
 * @param generation - Generation that settled the movement.
 * @param ownerInstanceId - Runtime instance that settled the movement.
 * @returns The persisted generation, adopted when it was legacy.
 */
export function adoptSettledLegacyGeneration(
  state: SessionStorageMemoryState,
  generation: AdapterSessionClaimRecord,
  ownerInstanceId: string,
): AdapterSessionClaimRecord {
  if (generation.ownerInstanceId !== null) return generation;
  const adopted = { ...generation, ownerInstanceId };
  state.claims.set(adopted.claimId, structuredClone(adopted));
  return adopted;
}

/**
 * Resolve the successor generation, and retire the ones it replaces.
 *
 * The agent's *own* live claim on the target key comes first, and when it exists
 * the request's token is discarded unused — which is what keeps a repeat
 * idempotent instead of minting a second generation for a key the agent already
 * owns. Otherwise the key is acquired under the same explicit or durable
 * owner-identity takeover rules as `claim`.
 *
 * Predecessors are retired by **row identity**, never by the request's token: in
 * the already-held case that token names no row at all, so a token-keyed delete
 * would remove the very generation being settled.
 * @param state - Shared in-memory state
 * @param payload - Movement request
 * @param providerSessionId - Key the movement resolves to
 * @returns The claims phase, or the refusal to report instead
 */
export function runMovementClaimsPhase(
  state: SessionStorageMemoryState,
  payload: IdentifiedMovementRequest,
  providerSessionId: string,
): MovementClaimsPhase | SessionOwnershipSettleMovementResult {
  const { machineId, adapterId, agentId } = payload;
  const incumbent = findClaimByKey(state.claims, machineId, adapterId, providerSessionId);

  let generation: AdapterSessionClaimRecord;
  let rollbackClaim: () => void;
  const ownGeneration = resolveOwnGeneration(payload, incumbent);

  if (ownGeneration !== undefined) {
    generation = ownGeneration.generation;
    rollbackClaim = ownGeneration.rollback;
  } else if (
    incumbent !== undefined &&
    !memoryMayTakeOver(
      state,
      {
        machineId,
        agentId,
        ownerInstanceId: payload.ownerInstance.instanceId,
        topology: payload.topology,
      },
      incumbent,
    )
  ) {
    return { outcome: 'already-claimed', holder: structuredClone(incumbent) };
  } else {
    const now = Date.now();
    const claimId = incumbent?.claimId ?? crypto.randomUUID();
    assertMovementTokenIsFree(state, payload.movement.claimToken, claimId);
    generation = {
      claimId,
      machineId,
      adapterId,
      adapterName: payload.adapterName,
      providerSessionId,
      sessionId: payload.sessionId,
      agentId,
      ownerInstanceId: payload.ownerInstance.instanceId,
      claimToken: payload.movement.claimToken,
      fence: allocateFence(state, agentId, incumbent?.fence ?? 0),
      status: 'held',
      claimedAt: now,
      updatedAt: now,
    };
    state.claims.set(claimId, structuredClone(generation));
    rollbackClaim =
      incumbent === undefined
        ? (): void => {
            state.claims.delete(claimId);
          }
        : (): void => {
            state.claims.set(claimId, structuredClone(incumbent));
          };
  }

  const retired =
    payload.movement.kind === 'confirmed'
      ? Array.from(state.claims.values()).filter(
          (claim) => claim.agentId === agentId && claim.status === 'held' && claim.claimId !== generation.claimId,
        )
      : [];
  for (const claim of retired) state.claims.delete(claim.claimId);

  return {
    generation,
    releasedProviderSessionIds: retired.map((claim) => claim.providerSessionId),
    rollback: (): void => {
      for (const claim of retired) state.claims.set(claim.claimId, structuredClone(claim));
      rollbackClaim();
    },
  };
}

/**
 * The provider session the movement resolves to, and the currency it writes.
 *
 * A `confirmed` movement names its successor outright. A `demote` names none —
 * it says only that the conversation left — so the key it voids is whatever the
 * agent's *current* currency resolves to, and the currency becomes `moved`:
 * nothing is resumable until a provider confirms a successor.
 * @param movement - What the provider did
 * @param agent - Agent whose conversation moved
 * @returns The key and currency target, or `null` when a demotion resolves no key
 */
export function resolveMovementTarget(
  movement: OwnershipMovement,
  agent: MakaioSessionAgent,
): { readonly providerSessionId: string; readonly currency: AdapterSessionCurrencyTarget } | null {
  if (movement.kind === 'confirmed') {
    return {
      providerSessionId: movement.providerSessionId,
      currency: { currentAdapterSessionId: movement.providerSessionId, currentAdapterSessionIdState: 'confirmed' },
    };
  }
  const providerSessionId = resolveResumableAdapterSessionId(agentCurrencySnapshot(agent));
  if (providerSessionId === null) return null;
  return { providerSessionId, currency: { currentAdapterSessionId: null, currentAdapterSessionIdState: 'moved' } };
}
