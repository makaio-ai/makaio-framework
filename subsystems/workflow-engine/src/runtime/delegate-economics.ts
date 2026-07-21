import type { AwaitSubagentResponse, WorkflowDelegateEconomics, WorkflowResolvedRole } from '@makaio/contracts';

/**
 * Build a secret-free snapshot from the exact role binding used for execution.
 * @param resolved - Resolved role passed to the spawned subagent.
 * @param durationMs - Measured delegate runtime duration.
 * @param usage - Frozen subagent execution metrics, when available.
 * @returns Truthful runtime economics without unavailable token estimates.
 */
export function buildDelegateEconomics(
  resolved: WorkflowResolvedRole,
  durationMs: number,
  usage: AwaitSubagentResponse['usage'] | undefined,
): WorkflowDelegateEconomics {
  const providerContext = resolved.providerContext?.state === 'resolved' ? resolved.providerContext : undefined;
  const providerConfigId = resolved.providerConfigId ?? providerContext?.providerConfigId;
  return {
    durationMs,
    ...(usage !== undefined
      ? {
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          toolCallCount: usage.toolCallCount,
        }
      : {}),
    binding: {
      adapterName: resolved.adapterName,
      ...(providerConfigId !== undefined ? { providerConfigId } : {}),
      ...(providerContext !== undefined ? { providerDefinitionId: providerContext.definitionId } : {}),
      ...(resolved.model !== undefined ? { model: resolved.model } : {}),
      ...(providerContext !== undefined
        ? {
            auth: {
              mode: providerContext.auth.mode,
              owner: providerContext.auth.method.owner,
              methodId: providerContext.auth.method.methodId,
            },
          }
        : {}),
    },
  };
}
