import { parseReasoningLevel, buildSystemPrompt } from '@makaio/ai-adapters-claude-process-shared';
import type {
  HookCallback,
  HookCallbackMatcher,
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveToolPolicy } from '@makaio/contracts';
import type {
  McpResolvedServer,
  NativeForkDirective,
  ResolvedToolPolicy,
  ResponseSchemaDescriptor,
} from '@makaio/contracts';
import { ClaudeSessionConfig, CreateToolApprovalHandler } from '../types/index.js';
import { SessionLifecycle, type AIReasoningLevel } from '@makaio/ai-adapters-core';

/**
 * Arguments for building SDK query options.
 */
interface BuildQueryOptionsArgs {
  /** Session configuration */
  config: ClaudeSessionConfig;
  /** Session lifecycle for abort handling */
  lifecycle: SessionLifecycle;
  /** Factory for the tool approval handler; receives the query's resolved tool policy. */
  createToolApprovalHandler: CreateToolApprovalHandler;
  /** Session ID for the query */
  sessionId: string;
  /** Previous adapter session ID for resume attempts. */
  resumeAdapterSessionId?: string;
  /**
   * Native fork directive from the session orchestrator.
   * When set, maps to SDK `forkSession` (tip) or `resumeSessionAt` (mid-history).
   * Takes precedence over `resumeAdapterSessionId` when both are present.
   */
  nativeFork?: NativeForkDirective;
  /** Optional structured output descriptor. */
  responseSchema?: ResponseSchemaDescriptor;
  /**
   * Port of the in-process HTTP MCP server.
   * When set, adds the makaio MCP server to the query's mcpServers config.
   */
  mcpServerPort?: number;
}

/**
 * Narrow the shared Claude prompt helper output to the SDK `Options` surface.
 *
 * The runtime accepts the broader prompt shapes preserved by
 * `buildSystemPrompt(...)`, but the published SDK typings lag that surface and
 * omit array prompts plus preset metadata such as `excludeDynamicSections`.
 * Keep the richer runtime payload and isolate the typing gap here.
 * @param systemPrompt - Prompt payload produced by the shared helper.
 * @returns Prompt payload typed for the SDK query options.
 */
function toSdkSystemPrompt(systemPrompt: ReturnType<typeof buildSystemPrompt>): NonNullable<Options['systemPrompt']> {
  return systemPrompt as NonNullable<Options['systemPrompt']>;
}

/**
 * Convert a Makaio `McpResolvedServer` transport config to the Claude Agent SDK
 * `McpServerConfig` shape. The two types share the same field names and semantics,
 * so this is a structural reshape rather than a semantic transformation.
 * @param server - Resolved server from the Makaio MCP session context.
 * @returns SDK-compatible server configuration.
 */
function toSdkServerConfig(server: McpResolvedServer): McpServerConfig {
  const { transport } = server;
  if (transport.type === 'stdio') {
    const config: McpStdioServerConfig = {
      type: 'stdio',
      command: transport.command,
      ...(transport.args !== undefined && { args: transport.args }),
      ...(transport.env !== undefined && { env: transport.env }),
      ...(transport.alwaysLoad !== undefined && { alwaysLoad: transport.alwaysLoad }),
    };
    return config;
  }
  if (transport.type === 'sse') {
    const config: McpSSEServerConfig = {
      type: 'sse',
      url: transport.url,
      ...(transport.headers !== undefined && { headers: transport.headers }),
      ...(transport.tools !== undefined && { tools: transport.tools }),
      ...(transport.alwaysLoad !== undefined && { alwaysLoad: transport.alwaysLoad }),
    };
    return config;
  }
  if (transport.type === 'http') {
    const config: McpHttpServerConfig = {
      type: 'http',
      url: transport.url,
      ...(transport.headers !== undefined && { headers: transport.headers }),
      ...(transport.tools !== undefined && { tools: transport.tools }),
      ...(transport.alwaysLoad !== undefined && { alwaysLoad: transport.alwaysLoad }),
    };
    return config;
  }
  // Exhaustive check — ensures a compile error if new transport types are added without handling them here.
  const _exhaustive: never = transport;
  throw new Error(`Unknown MCP transport type: ${(_exhaustive as { type: string }).type}`);
}

/**
 * Build the `mcpServers` record for an SDK query from upstream servers and the
 * Makaio in-process MCP server.
 *
 * Precedence (lowest → highest):
 * 1. `configMcpServers` — static user overrides from provider config
 * 2. `upstreamServers`  — runtime session servers (override static config)
 * 3. `makaio`           — in-process MCP server (always wins)
 *
 * Returns `undefined` when neither upstream servers nor the Makaio port are present.
 * @param upstreamServers - Resolved upstream MCP servers from session context.
 * @param configMcpServers - Any provider-config-level mcpServers already set by the user.
 * @param mcpServerPort - In-process Makaio HTTP MCP server port.
 * @returns Record of server name → SDK config, or `undefined` when no servers are needed.
 */
export function buildMcpServersRecord(
  upstreamServers: McpResolvedServer[] | undefined,
  configMcpServers: Record<string, McpServerConfig> | undefined,
  mcpServerPort: number | undefined,
): Record<string, McpServerConfig> | undefined {
  const hasUpstream = upstreamServers && upstreamServers.length > 0;
  const hasMakaio = mcpServerPort !== undefined;

  if (!hasUpstream && !hasMakaio) {
    return configMcpServers && Object.keys(configMcpServers).length > 0 ? configMcpServers : undefined;
  }

  const upstreamRecord: Record<string, McpServerConfig> = {};
  for (const server of upstreamServers ?? []) {
    upstreamRecord[server.name] = toSdkServerConfig(server);
  }

  return {
    ...(configMcpServers ?? {}),
    ...upstreamRecord,
    ...(hasMakaio && { makaio: { type: 'http' as const, url: `http://localhost:${mcpServerPort}/mcp` } }),
  };
}

/**
 * Derive the `maxThinkingTokens` value to pass to the SDK query.
 *
 * Returns `undefined` (omit the param entirely) when:
 * - No `reasoningEffort` is configured, or
 * - `reasoningEffort` is `'none'` (thinking explicitly disabled).
 *
 * A non-zero token budget is returned only when an active reasoning level
 * (`'low'`, `'medium'`, `'high'`, `'extra-high'`) is present.
 * @param reasoningEffort - The configured reasoning effort level, if any.
 * @returns Token budget for `maxThinkingTokens`, or `undefined` to omit the field.
 */
function resolveMaxThinkingTokens(reasoningEffort: AIReasoningLevel | undefined): number | undefined {
  if (!reasoningEffort || reasoningEffort === 'none') {
    return undefined;
  }
  return parseReasoningLevel(reasoningEffort);
}

/**
 * Resolve the session identity fields for the SDK query.
 *
 * Priority (highest to lowest):
 * 1. Native tip fork → `resume` + `forkSession: true` (branch from tip of source session)
 * 2. Native mid-history fork → `resume` + `resumeSessionAt` + `forkSession: true`
 *    (branch from a specific message)
 * 3. Resume → `resume` (continue the same session)
 * 4. New session → `sessionId` (create a fresh session)
 *
 * The native fork paths take precedence over plain resume because fork mode is
 * an explicit orchestrator decision, not a fallback.
 * @param sessionId - Local session ID (used for new sessions only)
 * @param resumeAdapterSessionId - Provider session to resume (ignored when nativeFork is set)
 * @param nativeFork - Native fork directive from the session orchestrator
 * @returns Partial SDK Options with the correct session identity fields
 */
function resolveSessionIdentityOptions(
  sessionId: string,
  resumeAdapterSessionId: string | undefined,
  nativeFork: NativeForkDirective | undefined,
): Partial<Options> {
  // Resumed and forked sessions may carry SDK permission rules persisted before this
  // query; that session history is operator-trusted and not filtered here. While caller
  // tool lists are set, new `updatedPermissions` are not persisted (see connector).
  if (nativeFork !== undefined) {
    const { sourceAdapterSessionId, forkPointMessageId } = nativeFork;
    if (forkPointMessageId !== undefined) {
      // Mid-history fork: resume up to the specified message, then branch.
      return { resume: sourceAdapterSessionId, resumeSessionAt: forkPointMessageId, forkSession: true };
    }
    // Tip fork: resume to tip and branch.
    return { resume: sourceAdapterSessionId, forkSession: true };
  }

  if (resumeAdapterSessionId !== undefined) {
    return { resume: resumeAdapterSessionId };
  }

  return { sessionId };
}

/**
 * Map the caller-granted tool policy onto the SDK tool options.
 *
 * SDK semantics (`@anthropic-ai/claude-agent-sdk` `Options`):
 * - `tools` specifies the base set of available built-in tools; `[]` disables all.
 * - `allowedTools` lists tools that are auto-allowed without prompting, i.e. they
 *   never reach `canUseTool`.
 * - `disallowedTools` removes tools from the model's context.
 *
 * The caller lists use Makaio tool names (`read_file`, `shell_exec(git status)`, MCP
 * `mcp__…`) and arrive resolved with `resolveToolPolicy('claude', …)`. An allowlist maps
 * to `tools` as an availability filter for the granted native built-ins
 * (`policy.nativeAvailableTools`: base names, MCP excluded, so `shell_exec(git status)`
 * makes `Bash` available). Command rules, MCP tools, and every tool `tools` does not
 * remove are enforced per call by the adapter-owned PreToolUse hook
 * ({@link createToolPolicyHook}) and again by the connector's `canUseTool` handler.
 * The allowlist is deliberately NOT mapped to SDK `allowedTools`: auto-allowed tools
 * skip `canUseTool`, this connector's path into the central tool approval service
 * (session policy overrides, harness policy, `.makaioignore` deny rules).
 * The overrides below are the second layer behind the hook, so that `canUseTool` sees
 * as many calls as possible. With caller lists, SDK `allowedTools` is set to `[]` so
 * provider-config `queryOptions.allowedTools` (operator auto-approvals) are dropped;
 * this overrides the provider value because the caller spreads these options after the
 * provider-config query options. The SDK still appends `Skill` entries derived from the
 * `skills` option to `allowedTools` before spawning the CLI, so those calls skip
 * `canUseTool`; the hook denies them when the lists do not cover `Skill`.
 * Provider-config `queryOptions.permissionMode` can bypass `canUseTool` too, so with
 * caller lists it is forced to `'default'`, the only mode that routes every
 * non-auto-approved call to `canUseTool` (SDK `PermissionMode`): `'bypassPermissions'`
 * skips all checks, `'acceptEdits'` auto-accepts file edits, `'auto'` lets a model
 * classifier decide, `'dontAsk'` denies whatever is not pre-approved without asking, and
 * `'plan'` executes no tools. Without caller lists the provider values stay untouched.
 * The denylist is translated to native entries with rules kept (`Bash(rm -rf:*)`), since
 * SDK `disallowedTools` accepts permission rules. Absent policies emit no fields, so
 * provider-config query options stay untouched.
 * Trust boundary (see `ToolLists` in `@makaio/contracts`): the lists bound the model, not
 * the operator; these overrides stop an ordinary provider config from accidentally
 * weakening them, while trusted operator input can still deliberately widen what runs.
 * @param policy - Caller tool policy resolved for this query.
 * @returns Partial SDK Options carrying only the fields the policy defines.
 */
function resolveToolPolicyOptions(policy: ResolvedToolPolicy): Partial<Options> {
  const { nativeAvailableTools, nativeDisallowedTools, restricts } = policy;
  return {
    ...(nativeAvailableTools !== undefined && { tools: [...nativeAvailableTools] }),
    // Second layer behind the PreToolUse hook: auto-approved tools and non-default
    // permission modes skip `canUseTool`.
    ...(restricts && { allowedTools: [], permissionMode: 'default' as const }),
    ...(nativeDisallowedTools !== undefined && { disallowedTools: [...nativeDisallowedTools] }),
  };
}

/**
 * Build the PreToolUse deny output for a call the caller tool lists reject.
 * @param reason - Why the tool policy denied the call.
 * @returns PreToolUse hook output carrying a `deny` decision.
 */
function toolPolicyDenyOutput(reason: string): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Create the adapter-owned PreToolUse hook that enforces the caller tool lists.
 *
 * Invariant: this hook is the authoritative gate for the caller lists. The SDK evaluates
 * PreToolUse hooks before settings permission rules, the permission mode, SDK
 * `allowedTools` (including the `Skill` entries the `skills` option adds), and
 * `canUseTool`, and a hook `deny` wins over any other hook's `allow` regardless of
 * order. The hook registers without a matcher, so it runs for every tool: `tools` does
 * not remove account-level MCP connectors, which load even with `settingSources: []`.
 * On pass it returns `{}` and never `'allow'`: a hook `allow` would skip `canUseTool` and
 * with it central approval. Provider-config PreToolUse hooks are wrapped by
 * {@link wrapProviderPreToolUseHook}, so with caller lists none of them can skip
 * `canUseTool` or rewrite the input past the lists.
 * Residual gaps: policy-level `disableAllHooks` settings and `CLAUDE_CODE_SIMPLE`
 * disable hooks (the `canUseTool` check and the option overrides remain). Hooks loaded
 * from settings files (`settingSources`) are not part of the query options and cannot be
 * wrapped: such a hook can still return `'allow'`, which skips `canUseTool` and with it
 * central approval (the lists stay enforced, since this hook's `deny` wins), or rewrite
 * the input without a decision, so the input that runs can differ from the input checked
 * here.
 * @param policy - Caller tool policy resolved for this query.
 * @returns PreToolUse hook callback.
 */
function createToolPolicyHook(policy: ResolvedToolPolicy): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const decision = policy.checkToolCall(input.tool_name, toolInput);
    if (decision.allowed) return {};
    return toolPolicyDenyOutput(decision.reason);
  };
}

/**
 * Wrap a provider-config PreToolUse hook so it cannot bypass the caller tool lists or
 * central approval.
 *
 * The provider hook runs unchanged; its output is then adjusted:
 * - A PreToolUse `updatedInput` is checked against the policy (the adapter-owned hook
 *   only saw the original input); a failing input turns the output into a `deny`.
 * - A PreToolUse `permissionDecision: 'allow'` (with its reason) is removed, and so is a
 *   legacy top-level `decision: 'approve'` (with its `reason`), so the call still reaches
 *   `canUseTool`. A checked `updatedInput` and all other fields are kept.
 * - `deny`, `ask`, `defer`, or no decision pass through unchanged.
 * Async outputs (`{ async: true }`) pass through unchanged: they carry no decision and no
 * `updatedInput` (SDK `AsyncHookJSONOutput`).
 * @param hook - Provider PreToolUse hook callback.
 * @param policy - Caller tool policy resolved for this query.
 * @returns Wrapped hook callback.
 */
function wrapProviderPreToolUseHook(hook: HookCallback, policy: ResolvedToolPolicy): HookCallback {
  return async (input, toolUseID, options) => {
    const output = await hook(input, toolUseID, options);
    if (input.hook_event_name !== 'PreToolUse' || 'async' in output) return output;

    let result: SyncHookJSONOutput = output;
    if (result.decision === 'approve') {
      result = { ...result };
      delete result.decision;
      delete result.reason;
    }

    const specific = result.hookSpecificOutput;
    if (specific?.hookEventName !== 'PreToolUse') return result;
    if (specific.updatedInput !== undefined) {
      const decision = policy.checkToolCall(input.tool_name, specific.updatedInput);
      if (!decision.allowed) return toolPolicyDenyOutput(decision.reason);
    }
    if (specific.permissionDecision !== 'allow') return result;

    const withoutAllow: PreToolUseHookSpecificOutput = { ...specific };
    delete withoutAllow.permissionDecision;
    delete withoutAllow.permissionDecisionReason;
    return { ...result, hookSpecificOutput: withoutAllow };
  };
}

/**
 * Merge the adapter-owned tool policy hook into the provider-config hooks.
 *
 * With caller lists, every provider PreToolUse callback is wrapped by
 * {@link wrapProviderPreToolUseHook} (matcher fields such as `matcher` and `timeout` are
 * kept), and the policy hook is appended after the provider PreToolUse matchers; hooks
 * for other events stay untouched. Without caller lists the provider hooks are returned
 * as is.
 * @param providerHooks - Provider-config `queryOptions.hooks`, if any.
 * @param policy - Caller tool policy resolved for this query.
 * @returns Hooks for the SDK query, or `undefined` when there are none.
 */
function resolveHooks(providerHooks: Options['hooks'], policy: ResolvedToolPolicy): Options['hooks'] {
  if (!policy.restricts) return providerHooks;
  const providerMatchers = (providerHooks?.PreToolUse ?? []).map(
    (matcher): HookCallbackMatcher => ({
      ...matcher,
      hooks: matcher.hooks.map((hook) => wrapProviderPreToolUseHook(hook, policy)),
    }),
  );
  const policyMatcher: HookCallbackMatcher = { hooks: [createToolPolicyHook(policy)] };
  return {
    ...providerHooks,
    PreToolUse: [...providerMatchers, policyMatcher],
  };
}

/**
 * Build query options for SDK query() call.
 * Extracted to avoid duplication between initialize() and createQuery().
 * @param args - Arguments for building query options
 * @returns SDK query options
 * @throws {@link ToolNameError} When a caller tool list entry is malformed, names no Makaio
 * or MCP tool, or carries a command rule on a tool other than `shell_exec`.
 */
export function buildQueryOptions({
  lifecycle,
  createToolApprovalHandler,
  config,
  sessionId,
  resumeAdapterSessionId,
  nativeFork,
  responseSchema,
  mcpServerPort,
}: BuildQueryOptionsArgs): Options {
  const maxThinkingTokens = resolveMaxThinkingTokens(config.reasoningEffort);

  // Provider `extraArgs` become CLI flags and can carry `--permission-mode`,
  // `--dangerously-skip-permissions`, `--allowedTools`, or `--settings`. They are trusted
  // operator input (see `ToolLists` trust boundary) and deliberately not filtered.
  const extraArgs = {
    ...(config.providerConfig?.queryOptions?.extraArgs ?? {}),
    'replay-user-messages': null,
  };

  const abortController = new AbortController();
  lifecycle.onAbort(() => abortController.abort());

  const baseSystemPromptFromConfig = config.providerConfig?.queryOptions?.systemPrompt;
  const systemPrompt = toSdkSystemPrompt(buildSystemPrompt(baseSystemPromptFromConfig, config.systemPrompt));

  const mcpServers = buildMcpServersRecord(
    config.mcpUpstreamServers,
    config.providerConfig?.queryOptions?.mcpServers,
    mcpServerPort,
  );

  const sessionIdentity = resolveSessionIdentityOptions(sessionId, resumeAdapterSessionId, nativeFork);

  // Resolved once per query; the options, the PreToolUse hook, and `canUseTool` share it.
  // Invalid list entries throw a ToolNameError here.
  const toolPolicy = resolveToolPolicy('claude', {
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
  });
  const hooks = resolveHooks(config.providerConfig?.queryOptions?.hooks, toolPolicy);

  return {
    // Trusted operator input (see `ToolLists` trust boundary), passed through unfiltered:
    // `sandbox` (`autoAllowBashIfSandboxed` lets Bash skip `canUseTool`; the PreToolUse
    // hook still enforces the lists), `agents`/`agent` with their own `permissionMode`, and
    // `spawnClaudeCodeProcess`/`executableArgs`, which can launch any process and so lie
    // outside what any in-process gate can constrain.
    ...(config.providerConfig?.queryOptions ?? {}),
    cwd: config.cwd,
    model: config.model,
    ...sessionIdentity,
    extraArgs,
    env: config.env,
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    includePartialMessages: true,
    persistSession: config.ephemeral ? false : (config.providerConfig?.queryOptions?.persistSession ?? true),
    stderr: (data) => console.warn(data),
    // Must stay after the provider-config spread: with caller tool lists it overrides
    // provider `tools`/`disallowedTools`, clears provider `allowedTools` auto-approvals,
    // resets provider `permissionMode` to `'default'`, wraps provider PreToolUse hooks,
    // and appends the policy hook.
    ...resolveToolPolicyOptions(toolPolicy),
    ...(hooks !== undefined && { hooks }),
    canUseTool: createToolApprovalHandler(toolPolicy),
    abortController,
    systemPrompt,
    ...(responseSchema !== undefined && {
      outputFormat: { type: 'json_schema' as const, schema: responseSchema.schema },
    }),
    ...(mcpServers !== undefined && { mcpServers }),
  };
}
