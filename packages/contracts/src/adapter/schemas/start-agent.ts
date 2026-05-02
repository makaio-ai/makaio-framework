import { z } from 'zod';
import { MessageInputSchema } from '../../shared/index.js';
import { AgentRoleSchema } from '../../session/schemas.js';
import { SessionContextSchema } from '../../session/session-context.js';
import { McpSessionContextSchema } from '../../mcp/schemas.js';
import { AIReasoningLevelSchema } from '../../model/index.js';
import { AdapterRuntimeOptionsSchema } from './runtime-options.js';
import { ProviderContextSchema } from './provider-context.js';

type StartAgentMode = 'create' | 'resume' | 'fork';

/**
 * Common fields for all startAgent request modes.
 * Extracted to avoid repetition in discriminated union variants.
 */
const StartAgentBaseSchema = z
  .object({
    /** Target adapter instance ID */
    adapterId: z.string(),

    /** Resolved harness ID for tool policy lookup. */
    harnessId: z.string().optional(),

    /** Client package identifier for client-scoped harness resolution. */
    clientId: z.string().optional(),

    /** Initial message to send to the agent. Omit for idle agent creation. */
    initialMessage: MessageInputSchema.optional(),

    /** Model to use (adapter-specific, e.g., 'sonnet', 'opus') */
    model: z.string().optional(),

    /** Reasoning effort level to apply for this agent invocation. */
    reasoningEffort: AIReasoningLevelSchema.optional(),

    /** Environment variables to pass to agent execution */
    env: z.record(z.string(), z.string()).optional(),

    /** Agent role in session. Session/orchestration layer must resolve this explicitly. */
    role: AgentRoleSchema,

    /**
     * Session context with decision signals.
     * Agent uses this to decide: native resume vs fresh with history.
     */
    sessionContext: SessionContextSchema.optional(),

    /**
     * MCP session context with resolved servers and tools.
     * Passes direct/discoverable tool information to adapter.
     */
    mcpSessionContext: McpSessionContextSchema.optional(),

    /**
     * Unresolved provider context (credential refs, not plaintext).
     * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
     */
    providerContext: ProviderContextSchema.optional(),

    /**
     * When true, the agent is ephemeral: session creation, agent storage, and
     * lifecycle events are skipped. The agent is auto-evicted after the first
     * turn completes. Designed for lightweight "ping" operations like usage
     * window activation.
     */
    ephemeral: z.boolean().optional(),
  })
  .merge(AdapterRuntimeOptionsSchema);

/**
 * Start a new agent with full lifecycle control.
 *
 * Subject: `adapter.startAgent`
 * Type: Request (RPC)
 * Purpose: Non-blocking agent creation with full control over session management.
 *          Returns immediately with agent identifiers for further interaction.
 *
 * Request modes:
 * - `create` (default, can be omitted): Create fresh session. Server generates sessionId.
 * - `resume`: Continue existing makaio session from a provider session's last state.
 * - `fork`: Branch from existing provider session into same makaio session.
 *
 * For `fork` mode, `sessionId` and `sourceSessionId` are REQUIRED.
 * For `resume` mode, `sessionId` and `adapterSessionId` are REQUIRED.
 */
export const StartAgentSchema = {
  request: z
    .union([
      // Fork: requires sessionId + sourceSessionId (more specific, tried first)
      StartAgentBaseSchema.extend({
        /** Fork from existing provider session */
        mode: z.literal('fork'),

        /** Makaio session to add this agent to (REQUIRED for fork) */
        sessionId: z.string(),

        /** Makaio session ID to fork from */
        sourceSessionId: z.string(),
      }),

      // Resume: continue from a previous provider session
      StartAgentBaseSchema.extend({
        /** Resume from existing provider session */
        mode: z.literal('resume'),
        /** Makaio session to attach agent to (REQUIRED for resume) */
        sessionId: z.string(),
        /** Previous provider session ID to attempt native resume */
        adapterSessionId: z.string(),
      }),

      // Create: mode optional, sessionId optional (attach to existing or create new)
      StartAgentBaseSchema.extend({
        /** Create a fresh session. Defaults to 'create' when omitted. */
        mode: z.literal('create').optional(),
        /** Makaio session to attach agent to. If omitted, creates new session. */
        sessionId: z.string().optional(),
      }),
    ])
    .superRefine((request, ctx) => {
      const mode: StartAgentMode = request.mode ?? 'create';
      if (request.ephemeral && mode !== 'create') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ephemeral'],
          message: 'ephemeral is only supported for create mode',
        });
      }
      if (request.ephemeral && request.initialMessage === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['initialMessage'],
          message: 'ephemeral startAgent requires initialMessage',
        });
      }
    }),
  response: z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),

      /** Unique agent execution unit ID */
      agentId: z.string(),

      /** Adapter instance that owns this agent */
      adapterId: z.string(),

      /** Adapter's own session ID (from provider SDK) */
      adapterSessionId: z.string(),

      /** Makaio session ID (generated for 'create' mode, echoed for others) */
      sessionId: z.string(),

      /** ID of the initial message being processed. Absent for idle agent creation. */
      messageId: z.string().optional(),
    }),
    z.object({
      success: z.literal(false),

      /** Error message describing the failure */
      message: z.string(),
    }),
  ]),
};

export type StartAgentRequest = z.infer<typeof StartAgentSchema.request>;
export type StartAgentResponse = z.infer<typeof StartAgentSchema.response>;
