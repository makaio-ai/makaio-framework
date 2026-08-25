import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionSubjects,
  type SessionOwnershipReservation,
  type StartAgentResponse,
} from '@makaio/contracts';
import { runExclusiveStart } from '../ownership/index.js';
import { reserveStartFor } from '../utils/start-reservation.js';
import { toMachineScopedAdapterInstance } from '../utils/resolution.js';
import { mintClaimToken } from '../ownership/claim-token.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { completeCallerOwnedStart, type CallerOwnedStart } from './caller-owned-start.js';
import {
  abandonDispatchedStart,
  rollbackReservedStart,
  StartClaimTokens,
  stopStartedConnector,
  type StartCleanupPolicy,
} from './lead-start-cleanup.js';
import {
  buildCallerOwnedAgentRow,
  type LeadStartDispatchRequest,
  type LeadStartRequest,
  type LeadStartResult,
} from './lead-start-request.js';
import { SessionStartError } from './session-start-error.js';

/**
 * Path A owns the agent row it minted, so its cleanup writes the terminal
 * status. Stated once, at the top of the path that holds the claim.
 */
const CALLER_OWNED_STATUS: StartCleanupPolicy = { writesAgentStatus: true, connectorOnlyTeardown: true };

/**
 * Select post-dispatch cleanup semantics for an explicit lead transition.
 * @param request - Lead start whose transition owns the policy.
 * @param reservation - Reservation that installed the new designation.
 * @returns Cleanup policy for every failure after provider dispatch begins.
 */
function cleanupPolicyFor(request: LeadStartRequest, reservation: SessionOwnershipReservation): StartCleanupPolicy {
  return request.leadTransition.kind === 'replace' ? { ...CALLER_OWNED_STATUS, reservation } : CALLER_OWNED_STATUS;
}

/** A reservation attempt, as the start path has to branch on it. */
type ReservationAttempt =
  | { kind: 'reserved'; reservation: SessionOwnershipReservation }
  | { kind: 'lead-conflict'; currentLeadAgentId: string | null }
  | { kind: 'refused'; outcome: string; status?: 'closed' | 'archived' | 'discovered' };

/**
 * Take the keyless reservation a fresh start runs under.
 *
 * Keyless because a fresh start knows no provider session: the provider mints
 * its own identity, and the reservation's whole purpose here is the pre-dispatch
 * lead designation and the agent-row existence check that goes with it.
 *
 * Issued as a **hard** request. An absent authority is not a lightweight host
 * but a broken composition: the same call that registers this path's handler
 * registers the authority, and the orchestrator that owns `sendMessage`
 * declares the session package as a critical dependency — so a host that can
 * dispatch a start and cannot reserve one is forbidden by the package graph. A
 * degrade here would make that misconfiguration indistinguishable from a
 * supported topology, and every start it let through would dispatch unowned.
 * The throw is caught by the caller, which rolls the pre-dispatch row back
 * before it propagates.
 *
 * `machine-identity-unavailable` cannot arise on this path either: a keyless
 * reservation never reads the machine-scoped key triple and falls back to the
 * designation sentinel, so a host with no machine identity still reserves.
 * @param bus - Bus the reservation is issued on.
 * @param request - The start being reserved for.
 * @param agentId - Caller-minted agent identity the reservation is taken for.
 * @returns What the authority answered, as the start path branches on it.
 */
async function reserveLeadStart(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
): Promise<ReservationAttempt> {
  const claimToken = mintClaimToken();
  let reserved;
  try {
    reserved = await reserveStartFor(bus, {
      sessionId: request.sessionId,
      agentId,
      adapterName: request.adapterName,
      instance: request.instance,
      role: 'lead',
      resumeProviderSessionId: null,
      expectedLeadAgentId: request.expectedLeadAgentId,
      claimToken,
    });
  } catch (error) {
    await bus
      .requestOptional(SessionSubjects.ownership.release, { agentId, claimToken, disposition: 'released' })
      .catch(() => undefined);
    throw error;
  }

  if (reserved.outcome === 'reserved') return { kind: 'reserved', reservation: reserved.reservation };
  if (reserved.outcome === 'lead-conflict') {
    return { kind: 'lead-conflict', currentLeadAgentId: reserved.currentLeadAgentId };
  }
  if (reserved.outcome === 'session-not-active') {
    return { kind: 'refused', outcome: reserved.outcome, status: reserved.status };
  }
  // `occupied` and `machine-identity-unavailable` cannot occur — a keyless
  // reservation takes no key and reads no machine-scoped triple — but they stay
  // in the total branch rather than being narrowed away, because they mean to a
  // caller exactly what `not-found` and `agent-disposed` mean: do not dispatch.
  return { kind: 'refused', outcome: reserved.outcome };
}

/**
 * Require every response coordinate to name this exact reserved start.
 * @param bus - Bus used to retire the uncertain attempt on omission.
 * @param request - Reserved start and its selected adapter/session identity.
 * @param agentId - Agent whose dispatched attempt is being checked.
 * @param claimTokens - Generations the attempt may retire.
 * @param result - Successful response whose identity must be proven.
 * @param targetOwnerInstanceId - Runtime incarnation the start targeted.
 * @param policy - Transition-aware cleanup for a rejected response.
 * @returns The response narrowed to a proved exact runtime owner.
 */
async function requireStartResponseIdentity(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
  claimTokens: StartClaimTokens,
  result: Extract<StartAgentResponse, { success: true }>,
  targetOwnerInstanceId: string,
  policy: StartCleanupPolicy,
): Promise<Extract<StartAgentResponse, { success: true }> & { readonly ownerInstanceId: string }> {
  if (
    result.agentId === agentId &&
    result.adapterId === request.instance.adapterId &&
    result.sessionId === request.sessionId &&
    result.ownerInstanceId === targetOwnerInstanceId
  ) {
    return { ...result, ownerInstanceId: result.ownerInstanceId };
  }
  await abandonDispatchedStart(bus, agentId, policy, claimTokens);
  await stopStartedConnector(bus, request.instance.adapterId, agentId, targetOwnerInstanceId, true);
  const mismatch =
    result.ownerInstanceId === undefined
      ? 'adapter omitted its owner instance'
      : result.ownerInstanceId !== targetOwnerInstanceId
        ? 'adapter owner mismatch'
        : 'adapter response identity mismatch';
  throw new SessionStartError('start-failed', `[session.start] ${mismatch} for agent ${agentId}`);
}

/**
 * Dispatch one authority-targeted lead start and validate the answering runtime.
 * @param bus - Bus carrying the adapter RPC and cleanup.
 * @param request - Resolved lead-start request.
 * @param agentId - Caller-owned agent identity.
 * @param reservation - Authority decision selecting the runtime incarnation.
 * @param claimTokens - Generations the attempt may retire.
 * @param policy - Transition-aware cleanup for any post-dispatch failure.
 * @returns Successful response from the exact selected runtime.
 */
async function dispatchReservedLeadStart(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
  reservation: SessionOwnershipReservation,
  claimTokens: StartClaimTokens,
  policy: StartCleanupPolicy,
): Promise<Extract<StartAgentResponse, { success: true }> & { readonly ownerInstanceId: string }> {
  let startResult: StartAgentResponse;
  const payload: LeadStartDispatchRequest = {
    ...request.startRequest,
    adapterId: request.instance.adapterId,
    sessionId: request.sessionId,
    role: 'lead',
    agentId,
    ownerInstanceId: reservation.ownerInstanceId,
  };
  try {
    startResult = request.dispatch
      ? await request.dispatch(payload)
      : await bus.request(AdapterSubjects.startAgent, payload);
  } catch (error) {
    await abandonDispatchedStart(bus, agentId, policy, claimTokens);
    await stopStartedConnector(bus, request.instance.adapterId, agentId, reservation.ownerInstanceId, true);
    throw error;
  }
  if (!startResult.success) {
    const failure = new SessionStartError(
      'start-failed',
      `[session.start] Failed to start agent (sessionId=${request.sessionId}, adapterName=${request.adapterName}): ${startResult.message}`,
    );
    if (startResult.dispatch === 'not-dispatched') await rollbackReservedStart(bus, agentId, reservation);
    else {
      await abandonDispatchedStart(bus, agentId, policy, claimTokens);
      await stopStartedConnector(bus, request.instance.adapterId, agentId, reservation.ownerInstanceId, true);
    }
    throw failure;
  }
  return requireStartResponseIdentity(
    bus,
    request,
    agentId,
    claimTokens,
    startResult,
    reservation.ownerInstanceId,
    policy,
  );
}

/**
 * Undo a pre-dispatch attempt whose keyless reservation may have committed before throwing.
 * @param bus - Bus the row and guarded designation are cleaned up on.
 * @param request - Lead transition whose request guard was validated by the reservation.
 * @param agentId - Caller-minted agent identity to remove.
 */
async function rollbackUncertainLeadReservation(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
): Promise<void> {
  await rollbackReservedStart(bus, agentId, undefined, {
    sessionId: request.sessionId,
    agentId,
    expectedLeadAgentId: request.expectedLeadAgentId,
    transition: request.leadTransition.kind,
  });
}

/**
 * Run one lead transition, from the agent row to the status transition.
 *
 * The order is the point. The row and its reservation exist *before* the
 * dispatch, so the session's lead is designated before any provider session can
 * be created under it and a movement announced during the start has a
 * legitimate writer. Everything after the dispatch is about giving back what the
 * start took when it does not end with an agent this runtime may own.
 * @param bus - Bus every step is issued on.
 * @param request - The start to run.
 * @param agentId - Caller-minted agent identity, already registered with the seam.
 * @returns The started agent, or the designation race it lost.
 */
async function runLeadStartAttempt(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
): Promise<LeadStartResult> {
  const agent = buildCallerOwnedAgentRow({
    agentId,
    instance: request.instance,
    adapterName: request.adapterName,
    sessionId: request.sessionId,
    role: 'lead',
    runtime: request.startRequest,
    ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
    ...(request.personaId !== undefined && { personaId: request.personaId }),
    ...(request.profileId !== undefined && { profileId: request.profileId }),
  });
  let attempt: ReservationAttempt;
  try {
    // **Inside the region, not before it.** A write whose transaction commits
    // and whose response is then lost throws here with the row already stored,
    // and a region that started after it would leave that row behind — the same
    // reason the adapter records its own row acquisition at the write's *issue*
    // rather than at its return (I20).
    await bus.requestOptional(AgentStorageSubjects.set, { agentId, agent });
    attempt = await reserveLeadStart(bus, request, agentId);
  } catch (error) {
    // Nothing reached the provider, so this is the pre-dispatch cleanup: the row
    // this attempt may have stored is the only thing to take back, and leaving it
    // would strand a `starting` agent that every later send has to arbitrate
    // over. The delete is unconditional for the same reason the write is inside
    // the region: whether it landed is exactly what a lost response does not
    // say, and deleting a row that was never written is a no-op.
    //
    // Deliberately *not* degraded into an unreserved start. A reservation
    // throws when the authority is absent, or when it is registered and its
    // storage is not; both are broken compositions rather than lightweight
    // hosts, and the framework's own package graph makes both unreachable (the
    // session service registers the authority in the same call as this path's
    // handler, and depends on the session-storage package that registers the
    // ownership handlers in one all-or-nothing block). A hand-composed host
    // that manages either cannot enforce single ownership at all, so starting
    // anyway would make a misconfiguration indistinguishable from a supported
    // topology.
    await rollbackUncertainLeadReservation(bus, request, agentId);
    throw error;
  }
  if (attempt.kind === 'lead-conflict') {
    // The reserving transaction rolled back, so the row this attempt created is
    // the only thing left to take back.
    const rollback = await rollbackReservedStart(bus, agentId, undefined);
    if (!rollback.rowDeleted) {
      throw new SessionStartError(
        'start-unresolved',
        `[session.start] lost lead designation for agent ${agentId}, but its rollback could not be confirmed`,
      );
    }
    return { outcome: 'lead-conflict', currentLeadAgentId: attempt.currentLeadAgentId };
  }
  if (attempt.kind === 'refused') {
    await rollbackReservedStart(bus, agentId, undefined);
    throw new SessionStartError(
      attempt.outcome === 'session-not-active' ? 'session-not-active' : 'start-failed',
      `[session.start] reservation for agent ${agentId} was refused: ${attempt.outcome}`,
      undefined,
      undefined,
      attempt.status,
    );
  }

  const { reservation } = attempt;
  const cleanupPolicy = cleanupPolicyFor(request, reservation);
  // A fresh transition deliberately names no reservation. Naming it would make
  // a post-dispatch failure clear the designation this start made, but there is
  // no previous lead to restore. That would leave the session holding the
  // `dead` row this failure kept (I15) with nothing designated, and
  // `resolveTargetAgents` would make the session unreachable by default sends
  // instead of merely degraded. A replacement does carry the reservation so
  // the same failure path atomically restores the prior designation.
  //
  // Kept, the lead names an agent the session legitimately has, and the next
  // send's own consumer rule finds it `dead` and recovers it. Attach differs
  // because it can displace an *existing* lead and therefore has one to put
  // back. Pinned by case 31's uncertain half and the recovery case below it.
  // Seeded with the one generation knowable here, which is none for the keyless
  // reservation a fresh start takes. The settlement adds whatever generation it
  // actually wrote through.
  const claimTokens = new StartClaimTokens([reservation.claim?.claimToken]);
  const startResult = await dispatchReservedLeadStart(bus, request, agentId, reservation, claimTokens, cleanupPolicy);

  // Minted before the settle and releasable from the moment it exists: a
  // settlement whose transaction commits and whose response is then lost leaves
  // nothing else that names the successor generation (I15b), and a failure of
  // the completion is exactly when that matters.
  const settlementClaimToken = mintClaimToken();
  claimTokens.add(settlementClaimToken);
  const dispatched: CallerOwnedStart = {
    sessionId: request.sessionId,
    agentId,
    adapterId: request.instance.adapterId,
    adapterName: request.adapterName,
    policy: cleanupPolicy,
    claimTokens,
    settlementClaimToken,
    admitSessionBeforeFinalAdoption: true,
    ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
    // A keyless reservation may use the authority's designation sentinel, but
    // the connector-producing dispatch is scoped to the selected runtime. Never
    // let the sentinel escape into settlement or durable runtime ownership.
    machineId: request.instance.machineId,
    ownerInstanceId: request.instance.ownerInstanceId,
  };
  await completeCallerOwnedStart(
    bus,
    dispatched,
    startResult.adapterSessionId,
    startResult.settlementAckToken,
    startResult.ownerInstanceId,
  );
  return {
    outcome: 'started',
    agent: {
      ...agent,
      status: 'idle',
      ...(startResult.adapterSessionId !== undefined && { adapterSessionId: startResult.adapterSessionId }),
    },
  };
}

/**
 * Start or replace a session lead under the ownership reservation.
 *
 * The whole attempt runs inside the in-flight-start seam, registered *before*
 * the agent row is written. There is therefore no instant at which a `starting`
 * row is visible without an entry a concurrent consumer can join, which is what
 * lets that consumer wait for this attempt instead of opening a second
 * lifecycle for the same identity.
 * @param bus - Bus every step is issued on.
 * @param request - The start to run.
 * @returns The started agent, or the designation race this start lost.
 */
export async function startLeadAgent(bus: IMakaioBus, request: LeadStartRequest): Promise<LeadStartResult> {
  if (toMachineScopedAdapterInstance(request.instance) === undefined) {
    throw new SessionStartError(
      'start-failed',
      `[session.start] lead transition requires a machine-scoped adapter instance (sessionId=${request.sessionId})`,
    );
  }
  const agentId = crypto.randomUUID();
  let result: LeadStartResult | undefined;
  await runExclusiveStart(agentId, async () => {
    result = await runLeadStartAttempt(bus, request, agentId);
    // A lost designation race built nothing for *this* identity: the winner's
    // agent is a different one, and a joiner waiting on this attempt must not
    // read the row it never wrote as a connector of its own.
    return result.outcome === 'started' ? 'connected' : 'no-connector';
  }).settled;
  if (result === undefined) {
    // Unreachable: the identity is minted here, so the seam has no existing
    // entry to hand back instead of running the attempt.
    throw new SessionStartError('start-failed', `[session.start] start for agent ${agentId} produced no result`);
  }
  return result;
}
