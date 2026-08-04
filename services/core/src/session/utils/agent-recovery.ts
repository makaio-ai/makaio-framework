import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  type AIReasoningLevel,
  type IMakaioSession,
  type MakaioSessionAgent,
  type SessionContext,
} from '@makaio/contracts';
import type { PipelineStep } from '../../session-editor/types.js';
import { resolveRuntimeProviderContext } from '../../provider-context/index.js';
import { resolveLiveAdapterId } from './resolution.js';
import { getFullConversation } from '../context/get-full-conversation.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { executePipeline } from '../session-editor/pipeline-executor.js';
import { recoveryPlanResumeTarget, type RecoveryPlan } from '../recovery-plan.js';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';

/**
 * Configuration for recovering dead agents during liveness verification.
 */
export interface RecoveryConfig {
  /** Working directory for agent execution */
  cwd?: string;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514', 'gpt-4o') */
  model?: string;
  /**
   * Whether the replacement connector resumes the provider conversation or
   * starts fresh and receives the stored conversation as injected history.
   *
   * Required, and required to be the same value the caller feeds to its history
   * assembly (via `buildPlannedRecoveryContext`): the two halves of a
   * recovery are only correct together. Deciding native resume here while
   * building history there replays the conversation into a provider session that
   * already holds it; deciding fresh here without building history there starts
   * the model blank on a session with prior turns.
   *
   * Locality evaluation belongs to the caller — see `planAgentRecovery`.
   */
  plan: RecoveryPlan;
}

/**
 * Ensure agent cwd matches desired cwd, swapping connector if needed.
 * Must be called while agent is idle (before message routing).
 * @param bus - Bus instance
 * @param agent - Agent to validate/swap
 * @param desiredCwd - Target working directory
 * @param options - Optional request flags (e.g., skip interactive warnings)
 * @returns Swap result with previous cwd when a swap occurred
 */
export async function ensureAgentCwd(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  desiredCwd: string,
  options?: { skipWarning?: boolean },
): Promise<{ swapped: false } | { swapped: true; previousCwd: string }> {
  if (agent.cwd === desiredCwd) {
    return { swapped: false };
  }

  const result = await bus.request(AgentSubjects.cwd.change, {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    adapterName: agent.adapterName,
    adapterSessionId: agent.adapterSessionId ?? '',
    sessionId: agent.sessionId,
    newCwd: desiredCwd,
    ...(options?.skipWarning ? { skipWarning: true } : {}),
  });

  if (!result.success) {
    throw new Error(`Failed to change cwd for agent ${agent.agentId}: ${result.reason ?? 'unknown'}`);
  }
  // Adapter may report success without previousCwd when its connector already
  // matches desired cwd (e.g., persisted agent.cwd was stale). Treat as no-op.
  if (!result.previousCwd) {
    agent.cwd = desiredCwd;
    return { swapped: false };
  }

  agent.cwd = desiredCwd;
  return { swapped: true, previousCwd: result.previousCwd };
}

/**
 * Ensure an agent uses the desired model and/or reasoning effort, performing an
 * in-place change or connector swap as needed.
 *
 * Mirrors the `ensureAgentCwd()` pattern. At least one of `desiredModel`,
 * `options.reasoningEffort`, or `options.providerConfigId` must be defined for a
 * change to occur.
 * @param bus - The bus instance for RPC
 * @param agent - The agent to change (mutated in-place on success)
 * @param desiredModel - The model identifier to switch to, or undefined to keep current model
 * @param options - Optional configuration: `providerConfigId` triggers a swap when it differs from the
 *   current one; `reasoningEffort` is applied after the model change; `skipWarning` suppresses the
 *   model-change confirmation dialog
 * @returns Discriminated union: no change, or changed with swap info
 */
export async function ensureAgentModel(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  desiredModel: string | undefined,
  options?: { providerConfigId?: string; reasoningEffort?: AIReasoningLevel; skipWarning?: boolean },
): Promise<{ changed: false } | { changed: true; swapped: boolean }> {
  const modelUnchanged = desiredModel === undefined || agent.model === desiredModel;
  const noReasoningChange = options?.reasoningEffort === undefined;
  const noProviderChange = !options?.providerConfigId;

  if (modelUnchanged && noReasoningChange && noProviderChange) {
    return { changed: false };
  }

  const providerContext = options?.providerConfigId
    ? await resolveRuntimeProviderContext(bus, {
        adapterName: agent.adapterName,
        providerConfigId: options.providerConfigId,
      })
    : undefined;

  const result = await bus.request(AgentSubjects.model.change, {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    adapterName: agent.adapterName,
    adapterSessionId: agent.adapterSessionId ?? '',
    ...(desiredModel !== undefined && { newModel: desiredModel }),
    ...(options?.reasoningEffort !== undefined && { reasoningEffort: options.reasoningEffort }),
    ...(options?.skipWarning !== undefined && { skipWarning: options.skipWarning }),
    ...(providerContext !== undefined && { providerContext }),
  });

  if (!result.success) {
    throw new Error(`Failed to change model for agent ${agent.agentId}: ${result.reason ?? 'unknown'}`);
  }

  if (desiredModel !== undefined) {
    agent.model = desiredModel;
  }
  return { changed: true, swapped: result.swapped ?? false };
}

/**
 * Verify liveness of agents and recover any that are dead.
 * Queries each agent via getAgent; if unresponsive, triggers connector swap via recoverAgent.
 *
 * The caller's `recoveryConfig.plan` applies to every agent recovered in this
 * batch and must be the same plan the caller feeds to its history assembly.
 *
 * The **adapter instance is resolved per agent**, inside the loop, and not once
 * for the batch: a batch may span adapters, and a persisted `adapterId` goes
 * stale across a runtime restart or failover. Resolving per agent is what keeps
 * each rehydrate addressed to the live instance that actually owns that agent's
 * adapter, and keeps a single unresolvable adapter from deciding the batch.
 * @param bus - Bus instance
 * @param agents - Agents to verify
 * @param recoveryConfig - Configuration for recovering dead agents, including the shared recovery plan
 * @returns Verified/recovered agents and set of recovered agent IDs
 */
export async function verifyAndRecoverAgents(
  bus: IMakaioBus,
  agents: MakaioSessionAgent[],
  recoveryConfig: RecoveryConfig,
): Promise<{ verifiedAgents: MakaioSessionAgent[]; recoveredAgentIds: Set<string> }> {
  const verifiedAgents: MakaioSessionAgent[] = [];
  const recoveredAgentIds = new Set<string>();

  for (const agent of agents) {
    const result = await bus.requestOptional(AdapterSubjects.getAgent, {
      adapterId: agent.adapterId,
      agentId: agent.agentId,
    });

    if (result.handled && result.data.agent !== null) {
      // Agent is alive
      verifiedAgents.push(agent);
    } else {
      // Agent is dead, recover it via connector swap — into the live instance
      // resolved for THIS agent, inside the loop, since a batch may span
      // adapters.
      const liveAdapterId = await resolveLiveAdapterId(bus, agent);
      const recovered = await recoverAgent(bus, agent, recoveryConfig, liveAdapterId);
      verifiedAgents.push(recovered);
      recoveredAgentIds.add(recovered.agentId);
    }
  }

  return { verifiedAgents, recoveredAgentIds };
}

// Re-export from recovery-context.ts — single source of truth for framework-safe recovery.
export { buildRecoveryContext, buildPlannedRecoveryContext } from './recovery-context.js';

/**
 * Build recovery context and apply optional additional transforms.
 * @param bus - Bus instance
 * @param session - Session to build context for
 * @param options - Optional transform pipeline to run before conversion
 * @returns SessionContext with transformed messageHistory and fresh-mode signal
 */
export async function buildRecoveryContextWithPipeline(
  bus: IMakaioBus,
  session: IMakaioSession,
  options?: { pipeline?: PipelineStep[] },
): Promise<SessionContext> {
  const contextResult = await getFullConversation(bus, session.sessionId);
  const pipeline = options?.pipeline ?? [];
  const transformedMessages =
    pipeline.length > 0 ? (await executePipeline(contextResult.messages, pipeline)).messages : contextResult.messages;

  return {
    messageHistory: transformedMessages.map(convertSessionMessage),
    isFirstTurn: true,
  };
}

/**
 * Recover a dead agent by triggering connector swap via the adapter.
 * The agent keeps its identity — no session mutation needed.
 *
 * Context delivery happens via the normal sendMessage path that follows
 * recovery (same handler invocation). No staging needed.
 *
 * **The adapter instance is an input, never resolved here.** The ownership key
 * is `(machine, adapter instance, provider session)`, so a caller that reserves
 * ownership before recovering must reserve against the very instance the
 * rehydrate is dispatched to. Resolving internally would put the reservation and
 * the dispatch in two different namespaces whenever the persisted ID went stale.
 *
 * The dispatch runs inside the in-flight-start seam, so a concurrent consumer
 * that finds this agent mid-recovery joins the attempt instead of starting a
 * second lifecycle for the same identity. A joined call dispatched nothing, so
 * it takes the adapter instance from the **stored agent row** — the attempt that
 * did run is the only thing that can say which instance the agent now lives on,
 * and re-stamping this caller's own input would advertise a binding that never
 * happened.
 * @param bus - Bus instance
 * @param deadAgent - The dead agent to recover; its `adapterId` is re-stamped to the instance the
 *   attempt actually used
 * @param recoveryConfig - Configuration for the recovered connector
 * @param adapterId - Live adapter instance to rehydrate into, resolved by the caller for THIS agent
 * @returns Same agent reference — identity preserved
 */
export async function recoverAgent(
  bus: IMakaioBus,
  deadAgent: MakaioSessionAgent,
  recoveryConfig: RecoveryConfig,
  adapterId: string,
): Promise<MakaioSessionAgent> {
  const start = runExclusiveStart(deadAgent.agentId, () =>
    dispatchAgentRehydrate(bus, deadAgent, recoveryConfig, adapterId),
  );
  await start.settled;

  if (!start.joined) {
    deadAgent.adapterId = adapterId;
    // Persisted, not only mutated in memory. The agent now lives on this
    // instance, and the row is what every later reader consults — including the
    // movement observer, which drops an announcement whose instance the row does
    // not name. Leaving the row on the previous instance would make the
    // replacement connector's own movements unrecordable.
    await bus.requestOptional(AgentStorageSubjects.updateRuntime, { agentId: deadAgent.agentId, adapterId });
    return deadAgent;
  }
  const stored = await bus.requestOptional(AgentStorageSubjects.get, { agentId: deadAgent.agentId });
  const row = stored.handled ? stored.data.agent : null;
  // An unreadable row leaves the caller's view untouched rather than guessing:
  // the previous binding is at least one this process once observed, while the
  // joiner's input is one nothing ever dispatched to.
  if (row !== null) deadAgent.adapterId = row.adapterId;
  return deadAgent;
}

/**
 * Dispatch one rehydrate, without entering the in-flight-start seam.
 *
 * Split out from {@link recoverAgent} for callers that own the seam entry
 * themselves because they have durable work — a reservation, a runtime write, a
 * settlement — that has to sit inside the *same* attempt. Entering twice would
 * make the inner call join its own outer entry and wait for a promise that is
 * waiting on it.
 * @param bus - Bus instance
 * @param deadAgent - The dead agent being recovered
 * @param recoveryConfig - Configuration for the recovered connector
 * @param adapterId - Live adapter instance to rehydrate into
 */
export async function dispatchAgentRehydrate(
  bus: IMakaioBus,
  deadAgent: MakaioSessionAgent,
  recoveryConfig: RecoveryConfig,
  adapterId: string,
): Promise<void> {
  // Only the plan's resume target puts the replacement connector into
  // native-resume mode; the rehydrate RPC carries no identity marker.
  const resumeAdapterSessionId = recoveryPlanResumeTarget(recoveryConfig.plan);
  await bus.request(AdapterSubjects.rehydrateAgent, {
    adapterId,
    agentId: deadAgent.agentId,
    cwd: recoveryConfig.cwd,
    model: recoveryConfig.model ?? deadAgent.model,
    ...(resumeAdapterSessionId !== undefined && { resumeAdapterSessionId }),
  });
}
