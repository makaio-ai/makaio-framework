import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionSubjects,
  type MakaioSessionAgent,
  type SessionOwnershipReservation,
  type StartAgentRequest,
  type StartAgentResponse,
} from '@makaio/contracts';
import { runExclusiveStart } from '../ownership/index.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import {
  abandonDispatchedStart,
  applySettlementOutcome,
  rollbackReservedStart,
  type StartCleanupPolicy,
} from './lead-start-cleanup.js';
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
  /** Live adapter instance the start is dispatched to and reserved against. */
  readonly adapterId: string;
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
  | { kind: 'reserved'; reservation: SessionOwnershipReservation | undefined }
  | { kind: 'lead-conflict'; currentLeadAgentId: string | null }
  | { kind: 'refused'; outcome: string };

/**
 * Take the keyless reservation a fresh start runs under.
 *
 * Keyless because a fresh start knows no provider session: the provider mints
 * its own identity, and the reservation's whole purpose here is the pre-dispatch
 * lead designation and the agent-row existence check that goes with it.
 *
 * A host with no ownership authority registered gets `reserved` with no
 * reservation. That is the honest reading: there is no authority to reserve
 * from, so nothing was taken and nothing has to be rolled back — the same
 * degradation every other optional session-storage read in this path accepts,
 * rather than making the authority a hard dependency of sending a message.
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
  const result = await bus.requestOptional(SessionSubjects.ownership.reserveStart, {
    sessionId: request.sessionId,
    agentId,
    adapterId: request.adapterId,
    adapterName: request.adapterName,
    role: 'lead',
    resumeProviderSessionId: null,
    expectedLeadAgentId: request.expectedLeadAgentId,
  });
  if (!result.handled) return { kind: 'reserved', reservation: undefined };

  const reserved = result.data;
  if (reserved.outcome === 'reserved') return { kind: 'reserved', reservation: reserved.reservation };
  if (reserved.outcome === 'lead-conflict') {
    return { kind: 'lead-conflict', currentLeadAgentId: reserved.currentLeadAgentId };
  }
  // `occupied` cannot occur — a keyless reservation takes no key — and the rest
  // (`not-found`, `agent-disposed`, `machine-identity-unavailable`) all mean the
  // same thing to a caller: do not dispatch.
  return { kind: 'refused', outcome: reserved.outcome };
}

/**
 * Settle the provider session the adapter reported, and complete the start.
 *
 * The origin identity is written first and separately from the currency: the
 * agent row's `adapterSessionId` is the immutable provider session the agent
 * started *from*, and the ownership seam is the only writer of where that
 * conversation currently lives.
 *
 * A start that returned no provider session (an idle fork start) has nothing to
 * settle — the movement observer settles it when the provider confirms — and is
 * treated exactly as an accepted settlement so the status transition still runs.
 * @param bus - Bus the settlement is issued on.
 * @param request - The start being completed.
 * @param agentId - Agent the start was for.
 * @param providerSessionId - Provider session the adapter reported, when it did.
 */
async function settleStartedAgent(
  bus: IMakaioBus,
  request: LeadStartRequest,
  agentId: string,
  providerSessionId: string | undefined,
): Promise<void> {
  if (providerSessionId !== undefined || request.providerConfigId !== undefined) {
    await bus.requestOptional(AgentStorageSubjects.updateRuntime, {
      agentId,
      ...(providerSessionId !== undefined && { adapterSessionId: providerSessionId }),
      ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
    });
  }
  if (providerSessionId === undefined) return;

  const settled = await bus.requestOptional(SessionSubjects.ownership.settleMovement, {
    sessionId: request.sessionId,
    agentId,
    adapterId: request.adapterId,
    adapterName: request.adapterName,
    movement: { confirmed: true, providerSessionId },
  });
  // No authority means no currency to be refused ownership of, exactly as at the
  // reservation.
  if (!settled.handled) return;
  await applySettlementOutcome(bus, request.adapterId, agentId, settled.data.outcome, CALLER_OWNED_STATUS);
}

/**
 * Hand the completed start its `starting → idle` transition.
 *
 * Permitted only after an accepted settlement (§7.5), and always as a
 * compare-and-swap, because the row this attempt is finishing may already have
 * been claimed for recovery by another runtime. Losing that arbitration is a
 * modeled loss, not corruption: the start gives its claims up, stops the
 * connector it can no longer account for, and reports failure.
 * @param bus - Bus the transition is issued on.
 * @param request - The start being completed.
 * @param agentId - Agent the start was for.
 */
async function commitStartedAgent(bus: IMakaioBus, request: LeadStartRequest, agentId: string): Promise<void> {
  const transition = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId,
    status: 'idle',
    expectedStatus: ['starting'],
  });
  // Unhandled means no agent storage in this host, so there is no row for a peer
  // to have taken and nothing to arbitrate.
  if (!transition.handled || transition.data.transitioned) return;

  await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS);
  await bus.requestOptional(AdapterSubjects.stopAgent, { adapterId: request.adapterId, agentId });
  throw new SessionStartError(
    'start-lost',
    `[session.start] start for agent ${agentId} was claimed by another runtime before it completed`,
  );
}

/**
 * Build the agent row a caller-owned start persists before it dispatches.
 *
 * This is now the **only** whole-record write for such a start: supplying
 * `agentId` transfers row ownership, and the adapter suppresses its own. So the
 * row has to carry what that suppressed write would have carried — the runtime
 * facts the request names (model, working directory, allowed directories,
 * client and harness) — or they simply never reach storage, and every reader of
 * `session.agents` sees an agent with no model and no cwd.
 *
 * One field is deliberately not mirrored: the adapter resolves an absent `cwd`
 * against its own platform defaults, which the service cannot see. A
 * caller-owned row therefore records the working directory the caller asked
 * for, and nothing when it asked for none — the honest reading, and not a
 * regression for the one caller that has this seam, which always resolves a
 * directory before composing the request.
 * @param request - The start being run, carrying the composed adapter request.
 * @param agentId - Caller-minted agent identity.
 * @returns The row to persist before dispatching.
 */
function buildCallerOwnedAgentRow(request: LeadStartRequest, agentId: string): MakaioSessionAgent {
  const now = Date.now();
  const { model, cwd, allowedDirectories, clientId, harnessId } = request.startRequest;
  return {
    agentId,
    adapterId: request.adapterId,
    adapterName: request.adapterName,
    sessionId: request.sessionId,
    role: 'lead',
    // Not `idle`: no connector is confirmed yet, and a consumer that read `idle`
    // here would use the agent without rehydrating it. The origin identity is
    // deliberately absent — it is written after the dispatch reports one.
    status: 'starting',
    createdAt: now,
    lastActivityAt: now,
    ...(model !== undefined && { model }),
    ...(cwd !== undefined && { cwd }),
    ...(allowedDirectories !== undefined && { allowedDirectories }),
    ...(clientId !== undefined && { clientId }),
    ...(harnessId !== undefined && { harnessId }),
    ...(request.providerConfigId !== undefined && { providerConfigId: request.providerConfigId }),
  };
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
  const agent = buildCallerOwnedAgentRow(request, agentId);
  await bus.requestOptional(AgentStorageSubjects.set, { agentId, agent });

  let attempt: ReservationAttempt;
  try {
    attempt = await reserveLeadStart(bus, request, agentId);
  } catch (error) {
    // Nothing reached the provider, so this is the pre-dispatch cleanup: the row
    // written a moment ago is the only thing to take back, and leaving it would
    // strand a `starting` agent that every later send has to arbitrate over.
    //
    // Deliberately *not* degraded into an unreserved start. A reservation only
    // throws when the authority is registered and its storage is not, and that
    // is a broken composition rather than a lightweight host: the framework's
    // own package graph makes it unreachable (the session service depends on
    // the session-storage package, which registers the ownership handlers in
    // the same all-or-nothing block), and a hand-composed host that manages it
    // cannot enforce single ownership at all. Starting anyway would make a
    // misconfiguration indistinguishable from a supported topology — the degrade
    // this wave grants is for an authority that is *absent*, which takes nothing
    // and therefore has nothing to give back.
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
  let startResult: StartAgentResponse;
  try {
    startResult = await bus.request(AdapterSubjects.startAgent, { ...request.startRequest, agentId });
  } catch (error) {
    // A throw carries no disposition, so the provider may hold a live session.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS);
    throw error;
  }
  if (!startResult.success) {
    if (startResult.dispatch === 'not-dispatched') await rollbackReservedStart(bus, agentId, reservation);
    else await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS);
    throw new SessionStartError(
      'start-failed',
      `[session.start] Failed to start agent (sessionId=${request.sessionId}, adapterName=${request.adapterName}): ${startResult.message}`,
    );
  }

  await settleStartedAgent(bus, request, agentId, startResult.adapterSessionId);
  await commitStartedAgent(bus, request, agentId);
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
  }).settled;
  if (result === undefined) {
    // Unreachable: the identity is minted here, so the seam has no existing
    // entry to hand back instead of running the attempt.
    throw new SessionStartError('start-failed', `[session.start] start for agent ${agentId} produced no result`);
  }
  return result;
}
