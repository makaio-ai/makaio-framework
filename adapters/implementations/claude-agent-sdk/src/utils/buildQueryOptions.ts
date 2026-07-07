import { parseReasoningLevel, buildSystemPrompt } from '@makaio/ai-adapters-claude-process-shared';
import type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { Options } from '@anthropic-ai/claude-agent-sdk';
import type { McpResolvedServer, NativeForkDirective, ResponseSchemaDescriptor } from '@makaio/contracts';
import { ClaudeSessionConfig } from '../types/index.js';
import { SessionLifecycle, type AIReasoningLevel } from '@makaio/ai-adapters-core';

/**
 * Arguments for building SDK query options.
 */
interface BuildQueryOptionsArgs {
  /** Session configuration */
  config: ClaudeSessionConfig;
  /** Session lifecycle for abort handling */
  lifecycle: SessionLifecycle;
  /** Factory for tool approval handler */
  createToolApprovalHandler: () => Options['canUseTool'];
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
 * Build query options for SDK query() call.
 * Extracted to avoid duplication between initialize() and createQuery().
 * @param args - Arguments for building query options
 * @returns SDK query options
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

  return {
    ...(config.providerConfig?.queryOptions ?? {}),
    cwd: config.cwd,
    model: config.model,
    ...sessionIdentity,
    extraArgs,
    env: config.env,
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    includePartialMessages: true,
    persistSession: config.providerConfig?.queryOptions?.persistSession ?? false,
    stderr: (data) => console.warn(data),
    canUseTool: createToolApprovalHandler(),
    abortController,
    systemPrompt,
    ...(responseSchema !== undefined && {
      outputFormat: { type: 'json_schema' as const, schema: responseSchema.schema },
    }),
    ...(mcpServers !== undefined && { mcpServers }),
  };
}
