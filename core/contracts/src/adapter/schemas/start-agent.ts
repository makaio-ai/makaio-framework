import { z } from 'zod';
import { JsonObjectContractSchema, MessageInputSchema, ResponseSchemaDescriptorSchema } from '../../shared/index.js';
import { AgentRoleSchema } from '../../session/schemas.js';
import { SessionContextSchema } from '../../session/session-context.js';
import { McpRuntimeSessionContextSchema, McpSessionContextSchema } from '../../mcp/schemas.js';
import { AIReasoningLevelSchema } from '../../model/index.js';
import { AdapterRuntimeOptionsSchema } from './runtime-options.js';
import { ProviderContextSchema } from './provider-context.js';
import { ClientProfileNameSchema } from '../../client/profile.js';

type StartAgentMode = 'create' | 'resume' | 'fork';

/**
 * How far a failed start got, as evidence for the caller's cleanup decision.
 *
 * A caller that reserved provider-session ownership before dispatching has to
 * decide between two incompatible cleanups: give the reservation back, or retire
 * it as possibly-live debris. Only the adapter knows which, and a bare error
 * message cannot carry it.
 *
 * Exactly two members, because a start has exactly two knowable outcomes. A
 * thrown start carries no disposition at all and callers must treat it as
 * `'dispatch-uncertain'`: the throw may come from anywhere in provider-context
 * activation, agent creation or the connector start.
 *
 * `adapter.rehydrateAgent` is a second producer of this vocabulary. Its failure
 * response narrows the field to `'not-dispatched'`, because a rehydrate that
 * may have reached the provider always leaves by throwing.
 */
export const AdapterStartDispositionSchema = z.enum([
  /** Refused before anything was sent to the provider. Nothing exists provider-side. */
  'not-dispatched',
  /** The provider may hold a live session; the adapter cannot say it does not. */
  'dispatch-uncertain',
]);

/** {@inheritDoc AdapterStartDispositionSchema} */
export type AdapterStartDisposition = z.infer<typeof AdapterStartDispositionSchema>;

/**
 * Common fields for all startAgent request modes.
 * Extracted to avoid repetition in discriminated union variants.
 */
const StartAgentBaseSchema = z
  .object({
    /** Target adapter instance ID */
    adapterId: z.string(),

    /**
     * Agent identity minted by the caller.
     *
     * Supplied when the caller has already persisted the agent row — which a
     * caller that reserves session ownership before dispatching must do,
     * because a reservation verifies the (agent, session) pair against storage.
     *
     * Its presence also **transfers ownership of the agent row**: the adapter
     * registers, starts and emits lifecycle events for the agent as usual, but
     * performs no whole-record agent write of its own. Otherwise its
     * unconditional `status: 'idle'` write would overwrite the in-flight status
     * the caller persisted before dispatching.
     *
     * Omitted, the adapter mints the identity and owns the row, exactly as it
     * always has.
     */
    agentId: z.string().optional(),

    /** Resolved harness ID for tool policy lookup. */
    harnessId: z.string().optional(),

    /** Client package identifier for client-scoped harness resolution. */
    clientId: z.string().optional(),

    /** Client profile name for session-scoped config isolation. */
    clientProfileName: ClientProfileNameSchema.optional(),

    /** Initial message to send to the agent. Omit for idle agent creation. */
    initialMessage: MessageInputSchema.optional(),

    /**
     * Structured output descriptor for the initial turn.
     * Forwarded to adapters that support model-level structured output.
     */
    responseSchema: ResponseSchemaDescriptorSchema.optional(),

    /** Model to use (adapter-specific, e.g., 'sonnet', 'opus') */
    model: z.string().optional(),

    /** Reasoning effort level to apply for this agent invocation. */
    reasoningEffort: AIReasoningLevelSchema.optional(),

    /**
     * Per-call adapter-specific configuration.
     * JSON-safe opaque bag forwarded to the adapter config factory merge seam.
     */
    adapterConfig: JsonObjectContractSchema.optional(),

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
    mcpSessionContext: z.union([McpSessionContextSchema, McpRuntimeSessionContextSchema]).optional(),

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

        /**
         * Provider-native source session ID to fork from.
         * Caller-supplied input evaluated by the orchestrator; when feasible, reflected
         * as {@link SessionContext.nativeFork} for the adapter to act on.
         */
        sourceAdapterSessionId: z.string(),

        /**
         * Optional provider-native fork point message ID.
         * Caller-supplied input evaluated by the orchestrator; when feasible, reflected
         * as {@link SessionContext.nativeFork} for the adapter to act on.
         * Only adapters that support checkpoint forking may use this.
         */
        forkPointMessageId: z.string().optional(),

        /**
         * Optional child working directory override when supported by the adapter.
         * Caller-supplied input evaluated by the orchestrator; when feasible, reflected
         * as {@link SessionContext.nativeFork} for the adapter to act on.
         */
        targetWorkingDirectory: z.string().optional(),
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

      /** Adapter's own session ID (from provider SDK). May be undefined for idle fork starts. */
      adapterSessionId: z.string().optional(),

      /** Makaio session ID (generated for 'create' mode, echoed for others) */
      sessionId: z.string(),

      /** ID of the initial message being processed. Absent for idle agent creation. */
      messageId: z.string().optional(),
    }),
    z.object({
      success: z.literal(false),

      /** Error message describing the failure */
      message: z.string(),

      /** {@inheritDoc AdapterStartDispositionSchema} */
      dispatch: AdapterStartDispositionSchema,
    }),
  ]),
};

export type StartAgentRequest = z.infer<typeof StartAgentSchema.request>;
export type StartAgentResponse = z.infer<typeof StartAgentSchema.response>;
