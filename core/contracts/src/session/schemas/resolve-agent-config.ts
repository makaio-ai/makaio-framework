import { z } from 'zod';
import { AgentSelectionSchema } from '../../adapter/schemas/index.js';
import { AIReasoningLevelSchema, ReasoningLevelMapSchema } from '../../model/index.js';
import { SystemPromptSchema } from '../../shared/index.js';

/**
 * RPC schema for resolving the concrete adapter config from an agent selection.
 *
 * The orchestrator uses this RPC to translate a frontend {@link AgentSelectionSchema}
 * (persona / profile / virtualModel / model) into the flat configuration needed to
 * start an agent: adapter name, model, provider reference, reasoning capability, and
 * optional runtime overrides.
 *
 * Callers receive enough information to populate `StartAgentRequest` without
 * performing their own resolution logic.
 */
export const ResolveAgentConfigSchema = {
  /**
   * Resolve the concrete adapter configuration for a given agent selection.
   *
   * Subject: `session.resolveAgentConfig`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const config = await bus.request(SessionSubjects.resolveAgentConfig, {
   *   selection: {
   *     kind: 'adapter',
   *     adapterName: 'openai-node',
   *     providerConfigId: 'provider-uuid',
   *     model: 'gpt-4o',
   *   },
   * });
   * // config.adapterName === 'openai-node'
   * // config.model       === 'gpt-4o'
   * ```
   */
  resolveAgentConfig: {
    request: z.object({
      /** The current frontend selection to resolve into a concrete agent config. */
      selection: AgentSelectionSchema,
      /**
       * Active project scope for pre-session resolution.
       * Required for project-scoped persona/profile resolution before a session exists.
       */
      projectId: z.string().optional(),
    }),
    response: z.object({
      /** Adapter driver name to use (e.g., `'openai-node'`, `'claude-code'`). */
      adapterName: z.string(),
      /**
       * Resolved model identifier (e.g., `'gpt-4o'`).
       * Optional because persona/profile resolution may not always produce a model
       * (e.g., a profile that only configures tooling with no explicit model).
       */
      model: z.string().optional(),
      /** ProviderConfig UUID for credential/endpoint resolution. */
      providerConfigId: z.string().optional(),
      /**
       * Reasoning effort level selected by the resolution path.
       * Present only when the selection carries an explicit reasoning preference.
       */
      reasoningEffort: AIReasoningLevelSchema.optional(),
      /**
       * Map of supported reasoning levels for the resolved model.
       * Absent when the model does not support extended thinking.
       *
       * Note: Virtual model resolution is best-effort at pre-session time.
       * Full resolution context (sessionId, promptText, sessionContext) is only
       * available at sendMessage time. Pre-session callers should treat
       * supportedReasoningLevels as advisory for virtual model selections.
       */
      supportedReasoningLevels: ReasoningLevelMapSchema.optional(),
      /**
       * System prompt override inherited from a persona or profile.
       * Absent when no system prompt is configured on the selection source.
       */
      systemPrompt: SystemPromptSchema.optional(),
      /**
       * Allowed tool names (adapter-specific).
       * Inherited from the selection source (e.g., a persona's tool policy).
       */
      allowedTools: z.array(z.string()).optional(),
      /**
       * Disallowed tool names (adapter-specific).
       * Takes precedence over `allowedTools`.
       */
      disallowedTools: z.array(z.string()).optional(),
      /**
       * Allowed filesystem directories (adapter-specific).
       * Inherited from the selection source (e.g., a persona's directory policy).
       */
      allowedDirectories: z.array(z.string()).optional(),
    }),
  },
};

/** Inferred request type for `session.resolveAgentConfig`. */
export type ResolveAgentConfigRequest = z.infer<typeof ResolveAgentConfigSchema.resolveAgentConfig.request>;

/** Inferred response type for `session.resolveAgentConfig`. */
export type ResolveAgentConfigResponse = z.infer<typeof ResolveAgentConfigSchema.resolveAgentConfig.response>;
