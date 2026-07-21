import type { WorkflowDelegateAgentNode, WorkflowDelegateRoleNode, WorkflowResolvedRole } from '@makaio/contracts';

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
 * Resolve node-owned completion and exact tool policy for a delegate role.
 * @param node - Delegate-role node definition.
 * @param role - Resolver-provided role configuration.
 * @returns Effective delegate-role execution configuration.
 */
export function resolveDelegateRoleConfig(
  node: WorkflowDelegateRoleNode,
  role: WorkflowResolvedRole,
): WorkflowResolvedRole {
  const resolvedRole = applyExactAllowedTools(
    {
      ...role,
      ...(node.completion !== undefined ? { completion: node.completion } : {}),
    },
    node.allowedTools,
  );
  return requiresFreshDelegateRoleContext(resolvedRole) ? { ...resolvedRole, contextMode: 'fresh' } : resolvedRole;
}

/**
 * Resolve node-owned completion and exact tool policy for an explicit delegate agent.
 * @param node - Delegate-agent node definition.
 * @param role - Resolver-provided agent configuration.
 * @returns Effective delegate-agent execution configuration.
 */
export function resolveDelegateAgentConfig(
  node: WorkflowDelegateAgentNode,
  role: WorkflowResolvedRole,
): WorkflowResolvedRole {
  return applyExactAllowedTools(
    { ...role, completion: node.completion ?? role.completion ?? 'tool' },
    node.allowedTools,
  );
}

/**
 * Determine whether a delegate role belongs to the fresh-context turn cohort.
 *
 * These roles historically ran through a dedicated session-turn path whose
 * child sessions intentionally omitted parent-history inheritance. The unified
 * subagent executor must preserve that context contract explicitly.
 * @param role - Effective resolved role configuration.
 * @returns True when the role requires explicit fresh context.
 */
function requiresFreshDelegateRoleContext(role: WorkflowResolvedRole): boolean {
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
