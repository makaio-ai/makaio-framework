import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type IMakaioSession, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { runExclusiveStart, type ExclusiveStart } from '../ownership/index.js';
import {
  planAgentRecovery,
  recoveryPlanRequiresHistory,
  type NativeResumeRecoveryPlan,
  type RecoveryPlan,
} from '../recovery-plan.js';
import { resolveAgentResumeIdentity } from '../session-resume-identity.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { dispatchAgentRehydrate } from '../utils/agent-recovery.js';
import { resolveLiveAdapterId } from '../utils/resolution.js';
import { classifyJoinedRow } from './in-flight-start-join.js';
import { abandonDispatchedStart, applySettlementOutcome, type StartCleanupPolicy } from './lead-start-cleanup.js';

/** One agent's outcome, as `session.restartAgents` reports it. */
type RestartAgentsHandlerResult =
  | { agentId: string; adapterId: string; success: true }
  | { agentId: string; adapterId: string; success: false; error: string };

/**
 * The rehydrate path does **not** own `agents.status`.
 *
 * `adapter.rehydrateAgent` writes `idle` unconditionally, before the service
 * settles, and this wave does not change that. So the shared start cleanup runs
 * here with every status write suppressed: releasing claims and stopping a
 * connector this runtime may not own are the parts that belong to ownership,
 * and the status column is not one of them.
 */
const ADAPTER_OWNED_STATUS: StartCleanupPolicy = { writesAgentStatus: false };

/**
 * Probe whether an adapter declares the `session:resume` capability.
 *
 * Best-effort: returns `false` when the adapter is unreachable or has no
 * handler, matching the attach-handler's `adapterSupportsResume` pattern.
 * @param bus - Bus for the capability query
 * @param adapterId - Live adapter instance ID
 * @returns `true` when the adapter declares `session:resume`
 */
async function adapterSupportsResume(bus: IMakaioBus, adapterId: string): Promise<boolean> {
  try {
    const result = await bus.requestOptional(AdapterSubjects.getCapabilities, { adapterId });
    return result.handled ? new Set(result.data.capabilities).has('session:resume') : false;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective machine identity for the restart handler.
 *
 * Prefers an explicit payload override (test/ops escape hatch), then falls back
 * to the runtime identity registered via the adapter-runtime identity handlers.
 *
 * Returns `undefined` only when both the payload and the runtime identity are
 * absent — downstream locality evaluation treats this as `missing-machine-id`
 * and degrades to deferred lazy recovery with history.
 * @param bus - Bus for identity resolution
 * @param payloadMachineId - Explicit machine ID from the request payload
 * @returns Effective machine identity, or `undefined` when unavailable
 */
async function resolveEffectiveMachineId(
  bus: IMakaioBus,
  payloadMachineId: string | undefined,
): Promise<string | undefined> {
  if (payloadMachineId !== undefined) return payloadMachineId;
  const identity = await bus.requestOptional(AdapterRuntimeSubjects.getMachineId, {});
  return identity.handled ? identity.data.machineId : undefined;
}

/** How a reservation attempt for a restart ended, as the path branches on it. */
type RestartReservation =
  /** Reserved, or no authority to reserve from — either way, dispatch. */
  | { kind: 'proceed' }
  /**
   * Another generation owns the key, or the authority cannot decide. Neither is
   * a failure of this agent: the send path recovers it with injected history.
   */
  | { kind: 'degrade' }
  /** The reservation was refused on grounds that make the agent unrecoverable here. */
  | { kind: 'refused'; outcome: string };

/**
 * Reserve the provider session this restart is about to resume.
 *
 * A restart reserves as a **member** regardless of the agent's stored role: the
 * session's lead designation is a statement about who speaks for the session
 * now, and a process coming back up must not re-take it from whoever holds it.
 *
 * An unhandled authority means there is nothing to reserve from, so nothing was
 * taken and nothing has to be given back — the same degradation the fresh-start
 * path accepts, rather than making the ownership extension a boot dependency of
 * restarting a session. An authority that *is* registered and answers
 * `machine-identity-unavailable` is different: it declined to decide, and a
 * native resume dispatched past a decline is exactly the unowned second writer
 * this aggregate exists to prevent.
 * @param bus - Bus the reservation is issued on
 * @param agent - Agent being restarted
 * @param adapterId - Live adapter instance the rehydrate will be dispatched to
 * @param resumeProviderSessionId - Provider session the plan resumes
 * @param machineId - Effective machine identity the plan was decided for
 * @returns Whether to dispatch, degrade to history injection, or report failure
 */
async function reserveRestart(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  adapterId: string,
  resumeProviderSessionId: string,
  machineId: string | undefined,
): Promise<RestartReservation> {
  const result = await bus.requestOptional(SessionSubjects.ownership.reserveStart, {
    sessionId: agent.sessionId,
    agentId: agent.agentId,
    adapterId,
    adapterName: agent.adapterName,
    role: 'member',
    resumeProviderSessionId,
    // The effective identity, which is the composed one unless the caller named
    // a machine. Omitting it here would let the plan be decided for one machine
    // and the key reserved in another's namespace — and a handler asked to act
    // for a named machine would answer `machine-identity-unavailable` on a host
    // that has no identity of its own, refusing the very operation the override
    // exists to make possible.
    ...(machineId !== undefined && { machineId }),
  });
  if (!result.handled) return { kind: 'proceed' };

  switch (result.data.outcome) {
    case 'reserved':
      return { kind: 'proceed' };
    case 'occupied':
    case 'machine-identity-unavailable':
      return { kind: 'degrade' };
    default:
      return { kind: 'refused', outcome: result.data.outcome };
  }
}

/**
 * Settle the provider session the rehydrated agent resumed.
 *
 * The rehydrate re-attaches the connector to a conversation this runtime has
 * just reserved, so the currency has to name it — otherwise the next movement
 * would be settled against a generation nobody recorded. The settle-outcome
 * table applies unchanged apart from its status writes, which this path does
 * not own.
 * @param bus - Bus the settlement is issued on
 * @param agent - Agent that was rehydrated
 * @param adapterId - Live adapter instance the connector lives on
 * @param providerSessionId - Provider session the agent resumed
 * @param machineId - Effective machine identity the reservation was taken under
 */
async function settleRestartedAgent(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  adapterId: string,
  providerSessionId: string,
  machineId: string | undefined,
): Promise<void> {
  const settled = await bus.requestOptional(SessionSubjects.ownership.settleMovement, {
    sessionId: agent.sessionId,
    agentId: agent.agentId,
    adapterId,
    adapterName: agent.adapterName,
    movement: { confirmed: true, providerSessionId },
    // The same identity the reservation used: the settlement writes through the
    // generation that reservation took, and a settle in another machine's
    // namespace would find no claim of the caller's and refuse as `not-owner`.
    ...(machineId !== undefined && { machineId }),
  });
  // No authority means no currency to be refused ownership of, exactly as at
  // the reservation.
  if (!settled.handled) return;
  await applySettlementOutcome(bus, adapterId, agent.agentId, settled.data.outcome, ADAPTER_OWNED_STATUS);
}

/**
 * Decide how one agent regains its conversation.
 *
 * The resolved resume identity is **both** the gate and the target: the verdict
 * is evaluated against it and the plan resumes it. Reading the target from the
 * raw `adapterSessionId` origin column instead is what let a settled movement be
 * evaluated and then discarded.
 * @param bus - Bus for the capability probe
 * @param session - Session row supplying the structural locality signals
 * @param agent - Agent being restarted
 * @param adapterId - Live adapter instance the probe and dispatch address
 * @param machineId - Effective machine identity, or `undefined` when unavailable
 * @returns The agent's recovery plan
 */
async function planRestart(
  bus: IMakaioBus,
  session: IMakaioSession,
  agent: MakaioSessionAgent,
  adapterId: string,
  machineId: string | undefined,
): Promise<RecoveryPlan> {
  const resumeIdentity = resolveAgentResumeIdentity(session, agent);
  const verdict = evaluateNativeLocality({
    intent: 'resume',
    session,
    localMachineId: machineId,
    adapterSupportsNative: await adapterSupportsResume(bus, adapterId),
    targetAdapterName: agent.adapterName,
    currentCwd: agent.cwd,
    targetCwd: agent.cwd,
    resumeIdentity,
  });
  return planAgentRecovery(verdict, resumeIdentity.adapterSessionId);
}

/**
 * Reserve, rehydrate, persist and settle one agent — the whole durable attempt.
 *
 * Runs as one in-flight-start attempt, so every durable step is inside it. That
 * is not tidiness: a consumer that joins this attempt runs none of these steps,
 * and anything left outside would run a second time under the joiner's own
 * inputs — persisting an adapter instance nothing dispatched to, and settling
 * the provider session the joiner *planned* to resume over the one this attempt
 * actually did.
 *
 * A dispatch failure is always a throw, because `adapter.rehydrateAgent` has no
 * failure response. Every one of them is therefore of unknown extent: the
 * provider may hold a live session, so the claims are retired as `abandoned`
 * rather than released, and no status is written — the agent row belongs to the
 * adapter on this path.
 * @param bus - Bus every step is issued on
 * @param agent - Agent being restarted
 * @param adapterId - Live adapter instance every step names
 * @param plan - The native-resume plan being executed
 * @param machineId - Effective machine identity every ownership act names
 * @returns This agent's entry in the handler's result list
 */
async function runReservedRehydrate(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  adapterId: string,
  plan: NativeResumeRecoveryPlan,
  machineId: string | undefined,
): Promise<RestartAgentsHandlerResult> {
  const { agentId, adapterId: storedAdapterId } = agent;
  const reservation = await reserveRestart(bus, agent, adapterId, plan.resumeAdapterSessionId, machineId);
  if (reservation.kind === 'degrade') {
    // The modeled degrade: another generation owns this provider session, so
    // the agent takes exactly the plan it would have taken had it never had one.
    return { agentId, adapterId: storedAdapterId, success: true };
  }
  if (reservation.kind === 'refused') {
    return {
      agentId,
      adapterId: storedAdapterId,
      success: false,
      error: `Ownership reservation refused: ${reservation.outcome}`,
    };
  }

  try {
    await dispatchAgentRehydrate(bus, agent, { cwd: agent.cwd, model: agent.model, plan }, adapterId);
  } catch (error) {
    await abandonDispatchedStart(bus, agentId, ADAPTER_OWNED_STATUS);
    throw error;
  }
  agent.adapterId = adapterId;
  await bus.requestOptional(AgentStorageSubjects.updateRuntime, { agentId, adapterId });
  await settleRestartedAgent(bus, agent, adapterId, plan.resumeAdapterSessionId, machineId);
  return { agentId, adapterId, success: true };
}

/**
 * Wait for an attempt this call joined, and report what it left behind.
 *
 * **A rejection outranks the row on this path**, which is the one place the
 * wave's "the row the attempt left behind is the verdict" rule does not carry.
 * That rule holds because a failing attempt *writes* the row: a fresh start
 * deletes it before dispatch and compare-and-swaps it to `dead` after one. A
 * rehydrate writes no status at all — the adapter owns that column here — so a
 * failed Path-B attempt leaves the row exactly as it found it, which for a
 * restart is typically a pre-existing `idle`. Classifying that would read the
 * row's *pre-attempt* state as the attempt's result and report a restart that
 * demonstrably failed as a success.
 *
 * The rejection is admissible precisely because it is this process's own: the
 * seam only ever hands back a promise for an attempt running here. Where no
 * rejection can be observed — the attempt belongs to another process, or to one
 * that died — nothing changes: there is no entry to join, and the row-state rule
 * and the status compare-and-swap arbitrate as before.
 * @param bus - Bus the re-read is issued on
 * @param agent - Agent whose start was joined
 * @param start - The joined attempt
 * @returns This agent's entry in the handler's result list
 */
async function joinReservedRehydrate(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  start: ExclusiveStart,
): Promise<RestartAgentsHandlerResult> {
  let failure: { readonly error: unknown } | undefined;
  await start.settled.catch((error: unknown) => {
    failure = { error };
  });
  if (failure !== undefined) {
    return {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      success: false,
      error: `Concurrent start for this agent failed: ${describeRestartFailure(failure.error)}`,
    };
  }
  return reportJoinedRestart(bus, agent);
}

/**
 * Report a restart whose agent another attempt brought up.
 *
 * Reached only when that attempt *succeeded*, so the stored row now describes
 * its result and is classified by the same table the send path applies to a
 * joined start. A restart whose agent is up has done its job; one whose row is
 * `dead`, gone or `disposed` has not, and says so rather than reporting another
 * attempt's success as its own.
 * @param bus - Bus the re-read is issued on
 * @param agent - Agent whose start was joined
 * @returns This agent's entry in the handler's result list
 */
async function reportJoinedRestart(bus: IMakaioBus, agent: MakaioSessionAgent): Promise<RestartAgentsHandlerResult> {
  const stored = await bus.requestOptional(AgentStorageSubjects.get, { agentId: agent.agentId });
  const row = stored.handled ? stored.data.agent : agent;
  // The instance the joined attempt bound the agent to, falling back to the
  // caller's view only when the row is gone — never to an instance this call
  // resolved for a dispatch it did not make.
  const { agentId, adapterId } = row ?? agent;
  if (classifyJoinedRow(row) === 'use') return { agentId, adapterId, success: true };
  return {
    agentId,
    adapterId,
    success: false,
    error: 'A concurrent start for this agent ended without a usable runtime',
  };
}

/**
 * Restart one agent: plan, then run — or join — the reserved rehydrate.
 *
 * A `fresh-with-history` plan is **deferred**, not executed: a restart produces
 * no turn, so this handler has nothing to attach injected history to. The
 * send-path recovery rehydrates the agent and injects the stored conversation in
 * one step, which is why deferring reports success — the agent record is intact
 * and reachable.
 *
 * The reserved rehydrate itself is exclusive per agent. Finding an attempt
 * already in flight means this process is starting that identity somewhere else,
 * and a restart must then consume that attempt's result rather than open a
 * second lifecycle beside it.
 * @param bus - Bus every step is issued on
 * @param session - Session row supplying the structural locality signals
 * @param agent - Agent being restarted
 * @param machineId - Effective machine identity, or `undefined` when unavailable
 * @returns This agent's entry in the handler's result list
 */
async function restartAgent(
  bus: IMakaioBus,
  session: IMakaioSession,
  agent: MakaioSessionAgent,
  machineId: string | undefined,
): Promise<RestartAgentsHandlerResult> {
  // A deferred or refused agent keeps its stored adapter ID: nothing was
  // dispatched for it, so re-stamping the row with a freshly resolved instance
  // would advertise a binding that does not exist.
  const { agentId, adapterId: storedAdapterId } = agent;
  if (agent.status === 'disposed') {
    // Checked before anything is dispatched or reserved: rehydrating a removed
    // agent throws, and every ownership operation refuses it by predicate
    // anyway, so the round-trip would only turn a known answer into a slower
    // one.
    return {
      agentId,
      adapterId: storedAdapterId,
      success: false,
      error: 'Agent is disposed and can no longer be restarted',
    };
  }

  // Resolved before anything reads or reserves against it, so the probe, the
  // reservation, the dispatch, the settlement and the runtime write all name one
  // instance — and one *machine*, since the instance ID is derived from it. A
  // caller that named a machine gets its whole restart in that machine's
  // namespace rather than a key mixing its identity with this runtime's.
  const adapterId = await resolveLiveAdapterId(bus, agent, machineId);

  const plan = await planRestart(bus, session, agent, adapterId, machineId);
  if (recoveryPlanRequiresHistory(plan)) return { agentId, adapterId: storedAdapterId, success: true };

  let result: RestartAgentsHandlerResult | undefined;
  const start = runExclusiveStart(agentId, async () => {
    result = await runReservedRehydrate(bus, agent, adapterId, plan, machineId);
  });
  if (start.joined) return joinReservedRehydrate(bus, agent, start);
  await start.settled;
  if (result === undefined) {
    // Unreachable: this call registered the attempt, so its callback ran.
    return { agentId, adapterId: storedAdapterId, success: false, error: 'Restart produced no result' };
  }
  return result;
}

/**
 * Describe why one agent's restart failed, for the caller's result list.
 *
 * The `cause` is preferred over the wrapper: a rehydrate dispatch failure
 * arrives wrapped by the bus, and the wrapper's own message names the transport
 * rather than what the provider refused.
 * @param error - Whatever the restart threw
 * @returns Human-readable failure text
 */
function describeRestartFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handle explicit session agent runtime restoration — the reserved rehydrate.
 *
 * Resolves the local machine identity from the adapter-runtime identity registry
 * (same source as the attach handler), then decides each agent's recovery plan
 * from the session row's structural locality signals and the agent's **own**
 * settled resume currency. An agent whose currency the ownership seam has
 * settled answers for itself, so a lead that abandoned its provider session no
 * longer degrades members that still hold their own conversation.
 *
 * A `native-resume` plan is executed here, and only after the provider session
 * it names has been reserved: coming back up is precisely the moment at which
 * another runtime may still be holding the conversation, and two connectors
 * writing one provider session is what the reservation refuses. A refusal is not
 * an error — it degrades the agent to the same deferred, history-injected
 * recovery an unresumable agent takes.
 *
 * The request payload accepts an optional `machineId` override for testing and
 * operational tooling; production callers should omit it so the handler resolves
 * the runtime identity itself. When identity resolution is unavailable, locality
 * evaluation degrades to `missing-machine-id`, which defers every agent to lazy
 * recovery with history — the safe default that avoids empty-provider-context
 * rehydration.
 *
 * A `starting` agent needs no branch of its own: it has no settled currency, so
 * its plan is fresh-with-history and it is deferred like any other unresumable
 * agent. Whether that row is *stale* is decided by the send path's in-flight
 * rule, never by its status.
 * @param bus - Bus every step is issued on
 * @returns Cleanup function
 */
export function registerRestartAgentsHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.restartAgents, async (ctx) => {
    const { sessionId, machineId: payloadMachineId } = ctx.payload;
    const listResult = await bus.requestOptional(AgentStorageSubjects.listBySession, { sessionId });
    const agents = listResult.handled ? listResult.data.agents : [];
    const results: RestartAgentsHandlerResult[] = [];

    const machineId = await resolveEffectiveMachineId(bus, payloadMachineId);
    const sessionResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = sessionResult.handled ? sessionResult.data.session : null;

    for (const agent of agents) {
      // No session row means no locality input, no conversation to project —
      // and no reachable recovery either: the send path resolves its targets
      // from the session row's agents, so an agent whose session row cannot be
      // read is never selected for the deferred fresh-with-history recovery.
      // Reporting success here would leave a dead connector behind a green
      // result; the orphan is a failure the caller must see.
      if (session === null) {
        results.push({
          agentId: agent.agentId,
          adapterId: agent.adapterId,
          success: false,
          error: 'Session row could not be read; agent has no reachable recovery path',
        });
        continue;
      }
      try {
        results.push(await restartAgent(bus, session, agent, machineId));
      } catch (error) {
        results.push({
          agentId: agent.agentId,
          adapterId: agent.adapterId,
          success: false,
          error: describeRestartFailure(error),
        });
      }
    }

    ctx.setResult({ sessionId, results });
  });
}
