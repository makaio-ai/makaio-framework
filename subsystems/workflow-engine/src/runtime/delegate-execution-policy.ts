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
  const resolvedRole = {
    ...role,
    ...(node.completion !== undefined ? { completion: node.completion } : {}),
  };
  return applyExactAllowedTools(resolvedRole, node.allowedTools);
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
 * Determine whether a resolved delegate role preserves session-turn semantics.
 * @param role - Effective resolved role configuration.
 * @returns True when the session-turn path preserves the resolved semantics.
 */
export function shouldUseSessionTurnForDelegateRole(role: WorkflowResolvedRole): boolean {
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
