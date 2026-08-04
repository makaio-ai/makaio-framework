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
import { resolveLiveAdapterIdForMachine } from './resolution.js';
import { getFullConversation } from '../context/get-full-conversation.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { executePipeline } from '../session-editor/pipeline-executor.js';
import { recoveryPlanResumeTarget, type RecoveryPlan } from '../recovery-plan.js';
import { failedRehydrateError } from '../handlers/reserved-rehydrate.js';
import {
  restoreProbedLiveAgent,
  runOrJoinReservedRehydrate,
  type ExclusiveRehydrateOutcome,
} from '../handlers/in-flight-start-join.js';

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
  /**
   * Machine identity every ownership act of this recovery names.
   *
   * A recovery reserves and settles under a machine, and addresses an adapter
   * instance that is derived from one — so both have to come from the *same*
   * identity or the key they build is one no other actor computes. Supplying it
   * is therefore not an optimisation: without it the instance is resolved for
   * this runtime's own machine (or falls back to the agent's persisted one)
   * while the authority files the acts under its default, which is the mixed key
   * the aggregate exists to prevent.
   *
   * Omitted only by a caller that genuinely has no machine identity — a headless
   * host, a test composition — where every act is unscoped and consistent for
   * that reason.
   */
  machineId?: string;
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
 * What a liveness-and-recovery pass leaves its caller with.
 *
 * Three sets rather than two, because a recovery can now end in a third state:
 * the agent's provider session is held by a generation this runtime does not
 * own, so no connector was built and none may be. The helper **names** that set
 * and decides nothing with it — it has no session, no orchestrator and no way
 * to start anything, and what a product does without those agents differs per
 * product.
 */
export interface VerifiedAgents {
  /** Agents this runtime may drive. */
  readonly usable: MakaioSessionAgent[];
  /** Agents recovered during this call. */
  readonly recoveredAgentIds: Set<string>;
  /**
   * Agents this runtime may **not** drive: their provider session is held by a
   * generation it does not own (I23a). Never empty-able by retrying — the
   * caller must decide what its product does without them.
   */
  readonly deferredAgentIds: Set<string>;
}

/**
 * Verify liveness of agents and recover any that are dead.
 * Queries each agent via getAgent; if unresponsive, triggers a reserved
 * rehydrate via recoverAgent.
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
 * @returns Usable agents, the ones recovered here, and the ones this runtime may not drive
 */
export async function verifyAndRecoverAgents(
  bus: IMakaioBus,
  agents: MakaioSessionAgent[],
  recoveryConfig: RecoveryConfig,
): Promise<VerifiedAgents> {
  const usable: MakaioSessionAgent[] = [];
  const recoveredAgentIds = new Set<string>();
  const deferredAgentIds = new Set<string>();

  for (const agent of agents) {
    const result = await bus.requestOptional(AdapterSubjects.getAgent, {
      adapterId: agent.adapterId,
      agentId: agent.agentId,
    });

    if (result.handled && result.data.agent !== null) {
      // Agent is alive — and where the row says otherwise, the probe is the
      // newer evidence and takes the contradiction back. A `dead` row for an
      // agent whose connector answers is the residue of a recovery claim
      // somebody else's probe vetoed, and nothing else lifts it: the per-turn
      // activity stamp moves a row only between `idle` and `active`.
      if (agent.status === 'dead') await restoreProbedLiveAgent(bus, agent.agentId);
      usable.push(agent);
      continue;
    }
    // Agent is dead, recover it under the ownership authority — into the live
    // instance resolved for THIS agent, inside the loop, since a batch may span
    // adapters, and for the machine every ownership act of this recovery names,
    // since the instance ID is derived from it.
    const liveAdapterId = await resolveLiveAdapterIdForMachine(bus, agent, recoveryConfig.machineId);
    if (liveAdapterId === undefined) {
      // No instance of this agent's adapter is derivable for that machine, and
      // the persisted one may not stand in: the machine it belongs to cannot be
      // recovered from it. That makes this an agent this runtime may not drive —
      // the same statement the authority's own `machine-identity-unavailable`
      // makes a round trip later, so it takes the same set.
      deferredAgentIds.add(agent.agentId);
      continue;
    }
    const recovered = await recoverAgent(bus, agent, recoveryConfig, liveAdapterId);
    if (recovered.kind === 'deferred') {
      deferredAgentIds.add(agent.agentId);
      continue;
    }
    usable.push(recovered.agent);
    recoveredAgentIds.add(recovered.agent.agentId);
  }

  return { usable, recoveredAgentIds, deferredAgentIds };
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

/** How one agent's recovery ended, for a caller that has a fallback for neither. */
export type AgentRecoveryOutcome =
  /** A connector is live again; the agent carries the instance it now lives on. */
  | { readonly kind: 'recovered'; readonly agent: MakaioSessionAgent }
  /**
   * This runtime may not drive the agent: its provider session is held by a
   * generation it does not own. Nothing was dispatched and nothing may be.
   */
  | { readonly kind: 'deferred'; readonly reason: 'occupied' | 'machine-identity-unavailable' };

/**
 * Recover a dead agent under the ownership authority.
 * The agent keeps its identity — no session mutation needed.
 *
 * Context delivery happens via the normal sendMessage path that follows
 * recovery (same handler invocation). No staging needed.
 *
 * **The adapter instance is an input, never resolved here.** The ownership key
 * is `(machine, adapter instance, provider session)`, so the reservation this
 * makes has to name the very instance the rehydrate is dispatched to. Resolving
 * internally would put the reservation and the dispatch in two different
 * namespaces whenever the persisted ID went stale.
 *
 * The reserved rehydrate runs inside the in-flight-start seam, so a concurrent
 * consumer that finds this agent mid-recovery joins the attempt instead of
 * starting a second lifecycle for the same identity — and consumes that join
 * through the shared seam, which classifies the row the attempt left behind
 * rather than reading its own success into the absence of a rejection.
 * @param bus - Bus instance
 * @param deadAgent - The dead agent to recover; its `adapterId` is re-stamped to the instance the
 *   attempt actually used
 * @param recoveryConfig - Configuration for the recovered connector
 * @param adapterId - Live adapter instance to rehydrate into, resolved by the caller for THIS agent
 * @returns The recovered agent, or the statement that this runtime may not drive it
 * @throws Whatever {@link failedRehydrateError} raises when the recovery failed rather than deferred
 */
export async function recoverAgent(
  bus: IMakaioBus,
  deadAgent: MakaioSessionAgent,
  recoveryConfig: RecoveryConfig,
  adapterId: string,
): Promise<AgentRecoveryOutcome> {
  const resumeTarget = recoveryPlanResumeTarget(recoveryConfig.plan);
  const outcome = await runOrJoinReservedRehydrate(bus, {
    agent: deadAgent,
    sessionId: deadAgent.sessionId,
    adapterId,
    resumeProviderSessionId: resumeTarget ?? null,
    // The same identity the caller resolved `adapterId` under, or none at all.
    // Reserving under a machine the instance was not derived for is the mixed
    // key; the caller is where both halves are known, so both travel together.
    ...(recoveryConfig.machineId !== undefined && { machineId: recoveryConfig.machineId }),
    ...(recoveryConfig.cwd !== undefined && { cwd: recoveryConfig.cwd }),
    ...((recoveryConfig.model ?? deadAgent.model) !== undefined && {
      model: recoveryConfig.model ?? deadAgent.model,
    }),
  });
  return classifyRecoveredAgent(deadAgent, outcome);
}

/**
 * Turn a reserved rehydrate's outcome into this helper's own answer.
 *
 * Only `deferred` is reported rather than raised: it is a modeled statement
 * about ownership that the caller has to act on, while a refused or lost
 * recovery leaves no connector and no honest way to continue with the agent.
 * @param agent - The agent being recovered.
 * @param outcome - What the recovery answered.
 * @returns The recovered agent, or the deferral.
 * @throws Whatever {@link failedRehydrateError} raises, for every outcome that is neither.
 */
function classifyRecoveredAgent(
  agent: MakaioSessionAgent,
  outcome: ExclusiveRehydrateOutcome | undefined,
): AgentRecoveryOutcome {
  switch (outcome?.kind) {
    case 'rehydrated':
    // A joined attempt built the connector, and the agent carries the instance
    // the stored row names — never the one this call resolved for a dispatch it
    // did not make.
    case 'joined':
      return { kind: 'recovered', agent: outcome.agent };
    case 'deferred':
      return { kind: 'deferred', reason: outcome.reason };
    // Exhaustive by type rather than by enumeration: the shared factory accepts
    // exactly the remaining members, so a new outcome stops compiling here
    // instead of silently becoming a start failure.
    default:
      throw failedRehydrateError(agent.agentId, outcome);
  }
}
