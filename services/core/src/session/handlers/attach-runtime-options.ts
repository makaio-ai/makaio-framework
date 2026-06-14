import type {
  AdapterRuntimeOptions,
  AgentSelectionBase,
  AIReasoningLevel,
  ProviderContext,
  ResolvedAgentConfig,
} from '@makaio/contracts';

/** Runtime options plus model, providerContext, and reasoningEffort. */
export type ExtractableRuntimeOptions = Partial<
  AdapterRuntimeOptions & {
    adapterConfig: AgentSelectionBase['adapterConfig'];
    env: AgentSelectionBase['env'];
    mcpSessionContext: AgentSelectionBase['mcpSessionContext'];
    model: string;
    providerContext: ProviderContext;
    reasoningEffort: AIReasoningLevel;
  }
>;

/** Result of merging explicit and resolved runtime options. */
export type MergedRuntimeOptions = {
  runtimeOptions: ExtractableRuntimeOptions;
  mergedModel: string | undefined;
  mergedCwd: string | undefined;
};

/**
 * Extracts runtime options from agent selection base fields.
 * @param selection - Agent selection containing optional runtime override fields
 * @returns Filtered runtime options object
 */
export function extractRuntimeOptions(selection: AgentSelectionBase): ExtractableRuntimeOptions {
  return {
    ...(selection.model !== undefined && { model: selection.model }),
    ...(selection.reasoningEffort !== undefined && { reasoningEffort: selection.reasoningEffort }),
    ...(selection.cwd !== undefined && { cwd: selection.cwd }),
    ...(selection.allowedTools !== undefined && { allowedTools: selection.allowedTools }),
    ...(selection.disallowedTools !== undefined && { disallowedTools: selection.disallowedTools }),
    ...(selection.allowedDirectories !== undefined && { allowedDirectories: selection.allowedDirectories }),
    ...(selection.env !== undefined && { env: selection.env }),
    ...(selection.mcpSessionContext !== undefined && { mcpSessionContext: selection.mcpSessionContext }),
    ...(selection.adapterConfig !== undefined && { adapterConfig: selection.adapterConfig }),
    ...(selection.systemPrompt !== undefined && { systemPrompt: selection.systemPrompt }),
  };
}

/**
 * Merges explicit runtime options with resolved provider execution context and agent-selection values.
 * @param explicit - Runtime options extracted directly from the agent selection
 * @param resolved - Resolved agent config from host-tier resolution, or null for adapter kind
 * @param providerContext - Resolved provider execution context
 * @returns Merged runtime options plus merged model and cwd for identity persistence
 */
export function mergeRuntimeOptions(
  explicit: ExtractableRuntimeOptions,
  resolved: ResolvedAgentConfig | null,
  providerContext: ProviderContext | undefined,
): MergedRuntimeOptions {
  const mergedModel = explicit.model ?? resolved?.model;
  const mergedCwd = explicit.cwd;
  const runtimeOptions: ExtractableRuntimeOptions = omitUndefined({
    model: mergedModel,
    reasoningEffort: explicit.reasoningEffort ?? resolved?.reasoningEffort,
    cwd: mergedCwd,
    allowedTools: explicit.allowedTools ?? resolved?.allowedTools,
    disallowedTools: explicit.disallowedTools ?? resolved?.disallowedTools,
    allowedDirectories: explicit.allowedDirectories ?? resolved?.allowedDirectories,
    env: explicit.env,
    mcpSessionContext: explicit.mcpSessionContext,
    adapterConfig: explicit.adapterConfig,
    systemPrompt: explicit.systemPrompt ?? resolved?.systemPrompt,
    providerContext,
  });
  return { runtimeOptions, mergedModel, mergedCwd };
}

/**
 * Removes keys whose value is `undefined` from an object literal.
 * @param obj - Object potentially containing `undefined` values
 * @returns A new object with `undefined`-valued keys omitted
 */
function omitUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
