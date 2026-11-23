import type { WorkflowAgentStepNode, WorkflowResolvedRole } from '@makaio/contracts';

/**
 * Apply an authority-selected exact allowlist without retaining conflicting
 * resolver-owned deny rules.
 * @param role - Resolver-provided execution configuration.
 * @param allowedTools - Exact node-owned allowlist, when declared.
 * @returns Role configuration with the exact tool policy applied.
 */
export function applyExactAllowedTools(
  role: WorkflowResolvedRole,
  allowedTools: readonly string[] | undefined,
): WorkflowResolvedRole {
  if (allowedTools === undefined) return role;
  return { ...role, tools: [...allowedTools], disallowedTools: undefined };
}

/**
 * Resolve node-owned completion and exact tool policy for an agent step.
 * @param node - Agent step node definition.
 * @param role - Resolver-provided role configuration.
 * @returns Effective agent-step execution configuration.
 */
export function resolveAgentStepConfig(node: WorkflowAgentStepNode, role: WorkflowResolvedRole): WorkflowResolvedRole {
  const resolvedRole = applyExactAllowedTools(
    {
      ...role,
      ...(node.completion !== undefined ? { completion: node.completion } : {}),
    },
    node.allowedTools,
  );
  return requiresFreshAgentStepContext(resolvedRole) ? { ...resolvedRole, contextMode: 'fresh' } : resolvedRole;
}

/**
 * Determine whether an agent step belongs to the fresh-context turn cohort.
 *
 * These steps historically ran through a dedicated session-turn path whose
 * child sessions intentionally omitted parent-history inheritance. The unified
 * subagent executor must preserve that context contract explicitly.
 * @param role - Effective resolved role configuration.
 * @returns True when the role requires explicit fresh context.
 */
function requiresFreshAgentStepContext(role: WorkflowResolvedRole): boolean {
  return (
    role.completion === 'turn' &&
    [
      role.harnessId,
      role.contextMode,
      role.adapterConfig,
      role.tools,
      role.disallowedTools,
      role.allowedDirectories,
    ].every((value) => value === undefined)
  );
}
