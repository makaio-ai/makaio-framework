import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type IMakaioSession, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { evaluateNativeLocality } from '../native-locality.js';
import { planAgentRecovery, recoveryPlanRequiresHistory, type RecoveryPlan } from '../recovery-plan.js';
import { resolveAgentResumeIdentity } from '../session-resume-identity.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { resolveOwnedAdapterInstance } from '../utils/resolution.js';
import { runOrJoinReservedRehydrate, type ExclusiveRehydrateOutcome } from './in-flight-start-join.js';

/** One agent's outcome, as `session.restartAgents` reports it. */
type RestartAgentsHandlerResult =
  | { agentId: string; adapterId: string; success: true }
  | { agentId: string; adapterId: string; success: false; error: string };

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
 * Report what the shared recovery decided as a restart.
 *
 * The durable work — the row claim, the reservation, the dispatch, the runtime
 * write, the settlement and the commit — and the whole join tail belong to the
 * shared seam, so a restart and a send recover an agent through one code path
 * and produce one set of ownership effects. What is restart-specific is only
 * what each outcome *means* to the caller's result list, which is this.
 *
 * A deferral reports **success**: another generation owns this provider
 * session, so the agent takes exactly the plan it would have taken had it never
 * had one, and the send path recovers it with injected history. A restart
 * produces no turn, so there is nothing here to attach that history to.
 * @param identity - Agent being restarted and the instance its row already names
 * @param outcome - What the shared recovery answered
 * @returns This agent's entry in the handler's result list
 */
function reportRestartOutcome(
  identity: { readonly agentId: string; readonly storedAdapterId: string },
  outcome: ExclusiveRehydrateOutcome | undefined,
): RestartAgentsHandlerResult {
  const { agentId, storedAdapterId } = identity;
  switch (outcome?.kind) {
    // The instance the agent is now bound to, read off the row the attempt left
    // behind — whether this call ran that attempt or joined one that did. Never
    // the instance this call resolved for a dispatch it may not have made.
    case 'rehydrated':
    case 'joined':
      return { agentId, adapterId: outcome.agent.adapterId, success: true };
    // A deferred or refused agent keeps its stored adapter ID: nothing was
    // dispatched for it, so re-stamping the row with a freshly resolved
    // instance would advertise a binding that does not exist.
    case 'deferred':
      return { agentId, adapterId: storedAdapterId, success: true };
    case 'refused':
      return {
        agentId,
        adapterId: storedAdapterId,
        success: false,
        error: `Ownership reservation refused: ${outcome.message ?? outcome.outcome}`,
      };
    case 'lost':
      return {
        agentId,
        adapterId: storedAdapterId,
        success: false,
        error: 'Another runtime claimed this agent’s recovery',
      };
    default:
      // Unreachable: a self-run attempt records its outcome before it settles.
      return { agentId, adapterId: storedAdapterId, success: false, error: 'Restart produced no result' };
  }
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
 * The reserved rehydrate itself is exclusive per agent, and this handler enters
 * it through the same run-or-join seam the send path uses. Finding an attempt
 * already in flight means this process is starting that identity somewhere else,
 * and a restart must then consume that attempt's result rather than open a
 * second lifecycle beside it — including the one bounded re-entry a joiner is
 * owed when the attempt it joined built no connector, because that attempt
 * answered for *its* inputs and this restart has not asked for its own yet.
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
  const instance = await resolveOwnedAdapterInstance(bus, {
    adapterName: agent.adapterName,
    storedAdapterId,
    ...(machineId !== undefined && { machineId }),
  });
  if (instance === undefined) {
    // No instance of this agent's adapter is derivable for the machine this
    // restart acts under, so there is none this restart could both reserve
    // under and dispatch to — the persisted ID cannot stand in, because the
    // machine it belongs to cannot be recovered from it. Reported exactly like
    // the deferral a non-native plan takes, and for the same reason: nothing
    // failed and nothing was dispatched, the agent record is intact, and the
    // send path recovers it with injected history.
    return { agentId, adapterId: storedAdapterId, success: true };
  }

  // The plan is decided for the same machine the reservation files under, which
  // is what the pair guarantees: deciding for one and reserving in another's
  // namespace was how a plan could be native for a machine whose key nobody
  // checked.
  const plan = await planRestart(bus, session, agent, instance.adapterId, instance.machineId);
  if (recoveryPlanRequiresHistory(plan)) return { agentId, adapterId: storedAdapterId, success: true };

  const outcome = await runOrJoinReservedRehydrate(bus, {
    agent,
    sessionId: agent.sessionId,
    instance,
    resumeProviderSessionId: plan.resumeAdapterSessionId,
    ...(agent.cwd !== undefined && { cwd: agent.cwd }),
    ...(agent.model !== undefined && { model: agent.model }),
  });
  return reportRestartOutcome({ agentId, storedAdapterId }, outcome);
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
