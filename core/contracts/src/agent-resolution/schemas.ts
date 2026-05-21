import { z } from 'zod';
import { AIReasoningLevelSchema } from '../model/schemas.js';
import { ContextModeSchema } from '../subagent/schemas.js';
import { CompressionModeSchema } from '../session/schemas/compression.js';
import { ApprovalPolicySchema } from '../harness/schemas.js';
import { McpProfileConfigSchema } from '../mcp/schemas.js';
import { AgentSelectionBaseSchema } from '../adapter/schemas/agent-resolution.js';

// ============================================================================
// Resolved Agent Configuration
// ============================================================================

/**
 * The concrete adapter configuration produced by resolving an `AgentSelection`.
 *
 * This is the canonical output of the resolution pipeline — what the
 * framework orchestrator needs to start an agent via `adapter.startAgent`.
 *
 * Contains both framework-level fields (adapter, model, tools, prompt) and
 * host-level fields (contextMode, compressionMode, approvalPolicy, etc.)
 * that flow through the orchestrator into the agent lifecycle.
 */
export const ResolvedAgentConfigSchema = z.object({
  /** Adapter driver name (e.g., `'anthropic-sdk'`, `'openai-node'`). */
  adapterName: z.string(),

  /** Provider config UUID for credential/endpoint resolution. */
  providerConfigId: z.string().optional(),

  /** Model identifier (e.g., `'sonnet'`, `'gpt-4o'`). */
  model: z.string().optional(),

  /** Final combined system prompt. */
  systemPrompt: z.string().optional(),

  /** Context mode for spawned agents. */
  contextMode: ContextModeSchema,

  /** Compression mode for session context management. */
  compressionMode: CompressionModeSchema,

  /** Merged tool allowlist. */
  allowedTools: z.array(z.string()).optional(),

  /** Merged tool blocklist. */
  disallowedTools: z.array(z.string()).optional(),

  /** Directory restrictions for file-system tool execution. */
  allowedDirectories: z.array(z.string()).optional(),

  /** Reasoning effort for supported models. */
  reasoningEffort: AIReasoningLevelSchema.optional(),

  /** Resolved approval policy from persona/profile cascade. */
  approvalPolicy: ApprovalPolicySchema.optional(),

  /** Resolved harness ID. */
  harnessId: z.string().optional(),

  /** Profile ID used in resolution. */
  profileId: z.string().optional(),

  /** MCP server configuration from the resolved profile, if any. */
  mcpConfig: McpProfileConfigSchema.optional(),
});

export type ResolvedAgentConfig = z.infer<typeof ResolvedAgentConfigSchema>;

// ============================================================================
// Agent Resolution Context
// ============================================================================

/**
 * Context available to the agent resolution handler.
 *
 * All fields are optional — callers pass what they have:
 * - **Pre-session** (`resolveAgentConfig` from the frontend picker): only `projectId`
 * - **In-session** (`sendMessage`): `sessionId`, `projectId`, `promptText`, `sessionContext`
 *
 * Resolvers use what's available. VirtualModel intent classification needs
 * `promptText`; persona/profile resolution only needs `projectId` for scoping.
 */
export const AgentResolutionContextSchema = z.object({
  /** Session ID for correlation and VirtualModel resolution. */
  sessionId: z.string().optional(),

  /** Project scope for persona/profile/virtualModel entity resolution. */
  projectId: z.string().optional(),

  /** User prompt text for VirtualModel intent classification. */
  promptText: z.string().optional(),

  /** Session context with history, injected context, etc. */
  sessionContext: z.unknown().optional(),
});

export type AgentResolutionContext = z.infer<typeof AgentResolutionContextSchema>;

// ============================================================================
// Agent Resolution RPC
// ============================================================================

/**
 * Schemas for the `agentResolution` bus namespace.
 *
 * Single RPC: `resolve` — translates a host-tier `AgentSelection`
 * (persona, profile, virtual-model, or future kinds) into the concrete
 * adapter configuration needed to start an agent.
 *
 * Framework handles `kind: 'adapter'` inline — it never hits this RPC.
 * Host packages register a handler that dispatches on `kind` to the
 * appropriate domain service (PersonaSubjects.resolve, ProfileSubjects.get,
 * VirtualModelSubjects.resolve).
 */
export const AgentResolutionSchemas = {
  /**
   * Resolve a host-tier agent selection into concrete adapter config.
   *
   * Subject: `agentResolution.resolve`
   * Type: Request (RPC)
   *
   * The framework orchestrator calls this for any `agent.kind` it doesn't
   * handle natively. The host-tier handler dispatches to the appropriate
   * domain service based on `kind`.
   * @example
   * ```typescript
   * // In the framework orchestrator (sendMessage path):
   * if (agent.kind !== 'adapter') {
   *   const config = await bus.request(AgentResolutionSubjects.resolve, {
   *     selection: agent,
   *     context: { sessionId, projectId, promptText },
   *   });
   *   // config.adapterName, config.model, config.systemPrompt, etc.
   * }
   * ```
   */
  resolve: {
    request: z.object({
      /** The agent selection to resolve (any host-tier kind). */
      selection: AgentSelectionBaseSchema,
      /** Resolution context — pass what you have, all fields optional. */
      context: AgentResolutionContextSchema.optional(),
    }),
    response: ResolvedAgentConfigSchema,
  },
} satisfies import('@makaio/core').SchemaRecord;

/** Inferred request type for `agentResolution.resolve`. */
export type AgentResolutionRequest = z.infer<typeof AgentResolutionSchemas.resolve.request>;

/** Inferred response type for `agentResolution.resolve`. */
export type AgentResolutionResponse = z.infer<typeof AgentResolutionSchemas.resolve.response>;
