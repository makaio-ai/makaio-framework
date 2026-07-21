import type { AgentAttachResolvedRequest } from '@makaio/contracts/session';
import type { SubagentConfig } from '@makaio/contracts';

/**
 * Build the trusted local adapter selection for a managed subagent session.
 * @param adapterName - Resolved adapter type name.
 * @param config - Validated subagent runtime configuration.
 * @param providerContext - Resolved provider context, when configured.
 * @param cwd - Effective child working directory.
 * @returns Local resolved-attach agent selection.
 */
export function buildSubagentAgentSelection(
  adapterName: string,
  config: SubagentConfig,
  providerContext: SubagentConfig['providerContext'],
  cwd: string | undefined,
): AgentAttachResolvedRequest['agent'] {
  return {
    kind: 'adapter',
    adapterName,
    ...(providerContext !== undefined && { providerContext }),
    ...(config.model !== undefined && { model: config.model }),
    ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
    ...(config.adapterConfig !== undefined && { adapterConfig: config.adapterConfig }),
    ...(cwd !== undefined && { cwd }),
    ...(config.tools !== undefined && { allowedTools: config.tools }),
    ...(config.disallowedTools !== undefined && { disallowedTools: config.disallowedTools }),
    ...(config.allowedDirectories !== undefined && { allowedDirectories: config.allowedDirectories }),
  };
}
