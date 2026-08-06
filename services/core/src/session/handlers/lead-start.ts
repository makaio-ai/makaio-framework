import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  type MakaioSessionAgent,
  type SessionOwnershipReservation,
  type StartAgentRequest,
  type StartAgentResponse,
} from '@makaio/contracts';
import { runExclusiveStart } from '../ownership/index.js';
import { reserveStartFor } from '../utils/start-reservation.js';
import type { MachineScopedAdapterInstance } from '../utils/resolution.js';
import { mintClaimToken } from '../ownership/claim-token.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { completeCallerOwnedStart, type CallerOwnedStart } from './caller-owned-start.js';
import {
  abandonDispatchedStart,
  rollbackReservedStart,
  StartClaimTokens,
  type StartCleanupPolicy,
} from './lead-start-cleanup.js';
import { buildCallerOwnedAgentRow } from './lead-start-request.js';
import { SessionStartError } from './session-start-error.js';

/**
 * Path A owns the agent row it minted, so its cleanup writes the terminal
 * status. Stated once, at the top of the path that holds the claim.
 */
const CALLER_OWNED_STATUS: StartCleanupPolicy = { writesAgentStatus: true };

/** Everything a fresh lead start needs beyond the payload it dispatches. */
export interface LeadStartRequest {
  /** Session the agent is started into. */
  readonly sessionId: string;
  /**
   * Instance this start dispatches to, and the machine every one of its
   * ownership acts names.
   *
   * **The two halves arrive together because they are one key.** An adapter
   * instance ID is a one-way hash of `(machineId, adapterName)`, so a start that
   * reserves and settles under one machine while dispatching to another
   * machine's instance builds an ownership key no other actor computes — it
   * collides with nothing, and therefore protects nothing. A runtime on the
   * instance's real machine would reserve the same provider session under *its*
   * identity and win, which is the second writer this whole seam exists to
   * refuse. The resolver hands out the pair or nothing, so there is no shape in
   * which this start holds one half.
   */
  readonly instance: MachineScopedAdapterInstance;
  /** Adapter type name, carried onto the agent row and any claim. */
  readonly adapterName: string;
  /** Provider config to stamp on the agent's runtime row once the start lands. */
  readonly providerConfigId?: string;
  /**
   * Lead the caller observed on the session row, or `null` when it names none.
   *
   * Compare-and-swapped, never assumed: a fresh start runs for a session with
   * no *agents*, which is not the same as a session with no *designation*. A
   * lead whose agent row was dropped — deleted, or disposed by a removal whose
   * clear could not run because the row was already gone — leaves the session
   * naming an agent it does not have, and the send path deliberately does not
   * clear it. Hard-coding `null` here would then make the reservation lose a
   * race it is not in: the CAS fails against the stale name, the start rolls
   * back, and that session can never start a lead again.
   *
   * Passing what was read keeps the designation's single writer intact — the
   * reserving transaction still writes it, still under compare-and-swap — and
   * leaves a genuinely concurrent start as the only thing that can win it away.
   */
  readonly expectedLeadAgentId: string | null;
  /**
   * The adapter dispatch, composed by the caller and complete but for the agent
   * identity — which this seam mints, persists and supplies, because a
   * reservation verifies the (agent, session) pair against storage before
   * anything is dispatched.
   */
  readonly startRequest: StartAgentRequest;
}

/** How a fresh lead start ended, for the caller that has a send to continue. */
export type LeadStartResult =
  | {
      /** The agent is live, owns its provider session and is `idle` in storage. */
      outcome: 'started';
      /** The agent row as it now stands, for the caller's in-memory session. */
      agent: MakaioSessionAgent;
    }
  | {
      /**
       * Another start won the designation race. Nothing was left behind: this
       * attempt's agent row is deleted and it dispatched nothing.
       */
      outcome: 'lead-conflict';
      /** Lead the session actually names, or `null` when it has none. */
      currentLeadAgentId: string | null;
    };

/** A reservation attempt, as the start path has to branch on it. */
type ReservationAttempt =
  | { kind: 'reserved'; reservation: SessionOwnershipReservation }
  | { kind: 'lead-conflict'; currentLeadAgentId: string | null }
  | { kind: 'refused'; outcome: string };

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
  const reserved = await reserveStartFor(bus, {
    sessionId: request.sessionId,
    agentId,
    adapterName: request.adapterName,
    instance: request.instance,
    role: 'lead',
    resumeProviderSessionId: null,
    expectedLeadAgentId: request.expectedLeadAgentId,
  });

  if (reserved.outcome === 'reserved') return { kind: 'reserved', reservation: reserved.reservation };
  if (reserved.outcome === 'lead-conflict') {
    return { kind: 'lead-conflict', currentLeadAgentId: reserved.currentLeadAgentId };
  }
  // `occupied` and `machine-identity-unavailable` cannot occur — a keyless
  // reservation takes no key and reads no machine-scoped triple — but they stay
  // in the total branch rather than being narrowed away, because they mean to a
  // caller exactly what `not-found` and `agent-disposed` mean: do not dispatch.
  return { kind: 'refused', outcome: reserved.outcome };
}

/**
 * Run one fresh lead start, from the agent row to the status transition.
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
    adapterId: request.instance.adapterId,
    adapterName: request.adapterName,
    sessionId: request.sessionId,
    role: 'lead',
    runtime: request.startRequest,
    ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
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
    await rollbackReservedStart(bus, agentId, undefined);
    throw error;
  }
  if (attempt.kind === 'lead-conflict') {
    // The reserving transaction rolled back, so the row this attempt created is
    // the only thing left to take back.
    await rollbackReservedStart(bus, agentId, undefined);
    return { outcome: 'lead-conflict', currentLeadAgentId: attempt.currentLeadAgentId };
  }
  if (attempt.kind === 'refused') {
    await rollbackReservedStart(bus, agentId, undefined);
    throw new SessionStartError(
      'start-failed',
      `[session.start] reservation for agent ${agentId} was refused: ${attempt.outcome}`,
    );
  }

  const { reservation } = attempt;
  // **The policy deliberately names no reservation, unlike the reserved
  // attach's.** Naming it would make a post-dispatch failure clear the
  // designation this start made, and for a *fresh* start there is no previous
  // lead to restore — the clear is the whole effect. That leaves the session
  // holding the `dead` row this failure kept (I15) with nothing designated, and
  // `resolveTargetAgents` raises for a default send against a session whose
  // lead it cannot resolve: the session becomes unreachable by default sends
  // instead of merely degraded.
  //
  // Kept, the lead names an agent the session legitimately has, and the next
  // send's own consumer rule finds it `dead` and recovers it. Attach differs
  // because it can displace an *existing* lead and therefore has one to put
  // back. Pinned by case 31's uncertain half and the recovery case below it.
  // Seeded with the one generation knowable here, which is none for the keyless
  // reservation a fresh start takes. The settlement adds whatever generation it
  // actually wrote through.
  const claimTokens = new StartClaimTokens([reservation.claim?.claimToken]);
  let startResult: StartAgentResponse;
  try {
    startResult = await bus.request(AdapterSubjects.startAgent, { ...request.startRequest, agentId });
  } catch (error) {
    // A throw carries no disposition, so the provider may hold a live session.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS, claimTokens);
    throw error;
  }
  if (!startResult.success) {
    if (startResult.dispatch === 'not-dispatched') await rollbackReservedStart(bus, agentId, reservation);
    else await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS, claimTokens);
    throw new SessionStartError(
      'start-failed',
      `[session.start] Failed to start agent (sessionId=${request.sessionId}, adapterName=${request.adapterName}): ${startResult.message}`,
    );
  }

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
    policy: CALLER_OWNED_STATUS,
    claimTokens,
    settlementClaimToken,
    ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
    // The settlement is the one keyed act a fresh start performs — its
    // reservation is keyless — so this is where naming the wrong machine costs
    // something: the claim lands in a namespace the instance's own runtime never
    // looks in. Named unconditionally now, because the instance cannot arrive
    // here without it: the settlement is keyed, so the machine is not optional
    // for this path however keyless its reservation was.
    machineId: request.instance.machineId,
  };
  await completeCallerOwnedStart(bus, dispatched, startResult.adapterSessionId);
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
 * Start the lead agent of a session that has none — the reserved fresh start.
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
