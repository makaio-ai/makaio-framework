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
import { buildProviderContext } from '../../provider-context/index.js';
import { resolveAdapterId } from './resolution.js';
import { getFullConversation } from '../context/get-full-conversation.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { executePipeline } from '../session-editor/pipeline-executor.js';

/**
 * Configuration for recovering dead agents during liveness verification.
 */
export interface RecoveryConfig {
  /** Working directory for agent execution */
  cwd?: string;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514', 'gpt-4o') */
  model?: string;
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
    ? await buildProviderContext(bus, options.providerConfigId)
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
 * @param bus - Bus instance
 * @param agents - Agents to verify
 * @param recoveryConfig - Configuration for recovering dead agents
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
      // Agent is dead, recover it via connector swap
      const recovered = await recoverAgent(bus, agent, recoveryConfig);
      verifiedAgents.push(recovered);
      recoveredAgentIds.add(recovered.agentId);
    }
  }

  return { verifiedAgents, recoveredAgentIds };
}

// Re-export from recovery-context.ts — single source of truth for framework-safe recovery.
export { buildRecoveryContext } from './recovery-context.js';

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
 * @param bus - Bus instance
 * @param deadAgent - The dead agent to recover
 * @param recoveryConfig - Configuration for the recovered connector
 * @returns Same agent reference — identity preserved
 */
export async function recoverAgent(
  bus: IMakaioBus,
  deadAgent: MakaioSessionAgent,
  recoveryConfig: RecoveryConfig,
): Promise<MakaioSessionAgent> {
  // Re-resolve adapter instance ID by adapterName on every recovery attempt.
  // Persisted adapter IDs can be stale after runtime restart/failover.
  const resolvedAdapterId = await resolveAdapterId(bus, deadAgent.adapterName).catch(() => deadAgent.adapterId);

  await bus.request(AdapterSubjects.rehydrateAgent, {
    adapterId: resolvedAdapterId,
    agentId: deadAgent.agentId,
    cwd: recoveryConfig.cwd,
    model: recoveryConfig.model ?? deadAgent.model,
    ...(deadAgent.adapterSessionId !== undefined && { adapterSessionId: deadAgent.adapterSessionId }),
  });

  deadAgent.adapterId = resolvedAdapterId;
  return deadAgent;
}
