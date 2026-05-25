import type { IMakaioBus } from '@makaio/bus-core';
import { ContextModeSchema, type AgentWorkflowStep, type ProviderContext } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';

/** Agent configuration resolved from either an inline step or a named role. */
export interface AgentSpawnConfig {
  /** Adapter name used by the subagent runtime. */
  adapterName?: string;
  /** Model override from the step or resolved role. */
  model?: string;
  /** Harness ID from the step or resolved role. */
  harnessId?: string;
  /** Context mode to pass to the subagent runtime. */
  contextMode: NonNullable<AgentWorkflowStep['contextMode']>;
  /** Optional system prompt supplied by a resolved role. */
  systemPrompt?: string;
  /** Optional provider context supplied by a resolved role. */
  providerContext?: ProviderContext;
}

/**
 * Resolve the subagent spawn configuration for an agent workflow step.
 *
 * Both the in-process executor and isolated worker orchestrator call this
 * helper so role-backed and inline agent steps spawn with identical adapter,
 * model, harness, context-mode, system-prompt, and provider-context semantics.
 * @param bus - Message bus used for role resolution.
 * @param step - Agent workflow step to resolve.
 * @returns Spawn configuration fields for the subagent request.
 */
export async function resolveAgentSpawnConfig(bus: IMakaioBus, step: AgentWorkflowStep): Promise<AgentSpawnConfig> {
  if (!step.role) {
    return {
      adapterName: step.adapter,
      model: step.model,
      harnessId: step.harnessId,
      contextMode: step.contextMode ?? ContextModeSchema.enum.fresh,
    };
  }

  const role = await bus.request(WorkflowSubjects.resolveRole, { roleId: step.role });
  return {
    adapterName: role.adapterName,
    model: role.model,
    harnessId: role.harnessId,
    contextMode: role.contextMode ?? ContextModeSchema.enum.fresh,
    systemPrompt: role.systemPrompt,
    providerContext: role.providerContext,
  };
}
