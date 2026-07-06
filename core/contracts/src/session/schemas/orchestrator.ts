import { z } from 'zod';
import {
  AdapterSelectionSchema,
  AgentSelectionBaseSchema,
  AgentSelectionSchema,
} from '../../adapter/schemas/agent-resolution.js';
import { ProviderContextSchema } from '../../adapter/schemas/provider-context.js';
import { CanonicalModelSelectionSchema } from '../../canonical-model/selection.js';
import { MessageInputSchema, MessageOutcomeSchema, ResponseSchemaDescriptorSchema } from '../../shared/index.js';
import { localSubject, type SchemaRecord } from '@makaio/core';
import { SessionContextSchema } from '../session-context.js';
import { ForkTransformsSchema } from './lifecycle-events.js';
import { SessionMessageOriginSchema, TurnInitiatorSchema, TurnUsageSchema } from './message.js';
import { SessionRecordMetadataSchema } from './session.js';

// ============================================================================
// Orchestrator Base Schemas
// ============================================================================

export { TurnInitiatorSchema };

/** Parsed type for {@link TurnInitiatorSchema}. */
export type TurnInitiator = z.infer<typeof TurnInitiatorSchema>;

/**
 * How a `session.turn.*` event entered the system.
 *
 * - `'live'` — the turn is ingested as it happens: managed orchestration
 *   (session.sendMessage driving the turn) or a hook-triggered import of the
 *   turn that just finished in an observed client.
 * - `'backfill'` — the turn is replayed from history: watcher discovery of an
 *   existing transcript or an on-demand import of past sessions.
 *
 * This is an **emission property, not a session property**. The same observed
 * session can be live-followed today and backfilled for yesterday, so the
 * marker describes each individual emission and must never be persisted on the
 * turns table. Session classification lives on the session row instead
 * (`source` / `adapterName` / `adapterSessionId`).
 *
 * Orthogonal to {@link TurnInitiatorSchema}, which encodes actor provenance
 * (user | extension | system) of whoever started the turn.
 */
export const TurnIngestionMarkerSchema = z.enum(['live', 'backfill']);

/** Parsed type for {@link TurnIngestionMarkerSchema}. */
export type TurnIngestionMarker = z.infer<typeof TurnIngestionMarkerSchema>;

/**
 * Base fields for turn events.
 */
const BaseTurnEventSchema = z.object({
  /** Makaio session ID */
  sessionId: z.string(),
  /** Turn identifier (UUID) */
  turnId: z.string(),
  /** Monotonic per-session ordinal (1-based). */
  turnNumber: z.number().int().min(1),
});

/**
 * Base fields for user message events.
 */
const BaseUserMessageEventSchema = BaseTurnEventSchema.extend({
  /** User message identifier */
  messageId: z.string(),
});

const TurnCompletedEventSchema = BaseTurnEventSchema.extend({
  /** Whether all agents completed successfully */
  success: z.boolean(),
  /** Error message if any agent failed */
  error: z.string().optional(),
  /** Aggregated token usage captured for the completed turn. */
  usage: TurnUsageSchema.optional(),
  /** Origin of the turn (for loop prevention and audit) */
  initiator: TurnInitiatorSchema.optional(),
  /** How this emission entered the system: live ingestion or historical backfill. */
  ingestionMarker: TurnIngestionMarkerSchema.optional(),
});

const SessionCustomAgentSelectionSchema = AgentSelectionBaseSchema.safeExtend({
  // Host packages can still extend session entrypoints with custom kinds, but
  // framework-reserved kinds must go through their explicit public branches.
  kind: z.string().regex(/^(?!(?:adapter|canonical-model)$).+$/),
});

const SessionAgentSelectionSchema = z.union([
  AdapterSelectionSchema,
  CanonicalModelSelectionSchema,
  SessionCustomAgentSelectionSchema,
]);

const ResolvedAdapterAgentSelectionSchema = AdapterSelectionSchema.extend({
  /** Already resolved provider execution context for local framework-internal startup paths. */
  providerContext: ProviderContextSchema.optional(),
});

const AgentAttachResolvedRequestSchema = z.object({
  /** Target session (required). */
  sessionId: z.string(),
  /** Direct adapter selection plus optional resolved provider context. */
  agent: ResolvedAdapterAgentSelectionSchema,
  /** Initial message to send (optional — can attach without sending). */
  initialMessage: MessageInputSchema.optional(),
  /** Agent role. Default: 'lead' if no agents exist, else 'member'. */
  role: z.enum(['lead', 'member']).optional(),
});

const AgentAttachResolvedResponseSchema = z.object({
  /** Created agent ID */
  agentId: z.string(),
  /** Adapter's own session ID */
  adapterSessionId: z.string(),
  /** Assigned role */
  role: z.enum(['lead', 'member']),
  /** Message ID if initialMessage was provided */
  messageId: z.string().optional(),
  /** Turn ID if initialMessage was provided */
  turnId: z.string().optional(),
});

/**
 * Orchestrator schemas for turn lifecycle and user message routing.
 *
 * These schemas are owned by SessionOrchestrator, not SessionService.
 * SessionService handles lifecycle (CRUD); orchestrator handles routing/turns.
 */
export const OrchestratorSchemas = {
  /**
   * Send a message to a session's agents.
   *
   * Subject: `session.sendMessage`
   * Type: Request (RPC)
   *
   * Single entry point for all user messages. Handles:
   * - Creating session if sessionId does not exist
   * - Auto-attaching agent via adapter.startAgent if session has no agents
   * - Turn lifecycle (creates turn if none active)
   * - Routing to targeted agents
   *
   * Default targets lead agent; use `agentIds: 'all'` for broadcast.
   *
   * `responseSchema.schema` is a JSON Schema document serialized as a
   * JSON-safe `Record<string, JsonValue>` so it can cross bus, storage, and
   * provider adapter boundaries without runtime-only values. Pass structured
   * output constraints as `{ schema, name?, strict? }`; raw JSON Schema
   * documents are intentionally not accepted at this session boundary.
   * @example
   * ```typescript
   * // Start new conversation (client generates sessionId)
   * const { sessionId, messageId, turnId } = await bus.request(SessionSubjects.sendMessage, {
   *   sessionId: crypto.randomUUID(),
   *   agent: { kind: 'adapter', adapterName: 'anthropic-sdk', model: 'sonnet' },
   *   message: 'Hello!',
   * });
   *
   * // Continue conversation (agent already attached)
   * await bus.request(SessionSubjects.sendMessage, {
   *   sessionId,
   *   message: 'Follow-up question',
   * });
   *
   * // Broadcast to all agents
   * await bus.request(SessionSubjects.sendMessage, {
   *   sessionId,
   *   message: 'What do you all think?',
   *   agentIds: 'all',
   * });
   * ```
   */
  sendMessage: {
    request: z.object({
      /** Target session ID. If not found, a new session is created with this ID. */
      sessionId: z.string(),
      /** Message content (string or structured message) */
      message: MessageInputSchema,

      // ── Agent configuration ───────────────────────────────────────────

      /**
       * Agent selection for auto-attaching or reconfiguring the lead agent.
       *
       * Discriminated on `kind` — e.g. `{ kind: 'adapter', adapterName: 'anthropic-sdk' }`
       * or `{ kind: 'persona', personaId: 'p-123' }`. Carries optional runtime
       * overrides (model, cwd, systemPrompt, tools) on the base shape.
       *
       * Mutually exclusive with `agentIds` — you either configure a new/lead
       * agent or target existing agents, not both.
       * @see AgentSelectionSchema
       */
      agent: SessionAgentSelectionSchema.optional(),

      /**
       * Target existing agents: specific IDs or `'all'` for broadcast.
       *
       * Mutually exclusive with `agent` — enforced at runtime in the
       * orchestrator, not at the schema level.
       */
      agentIds: z.union([z.array(z.string()), z.literal('all')]).optional(),

      // ── Turn & delivery ───────────────────────────────────────────────

      /** Delivery mode for agent message queue, only 'enqueue' supported currently. */
      deliveryMode: z.enum(['enqueue']).optional(),
      /**
       * Pre-generated turn ID for correlation.
       * If present, SessionOrchestrator uses this instead of generating a new one.
       */
      turnId: z.string().optional(),

      // ── Context & provenance ──────────────────────────────────────────

      /**
       * Session context with curated messageHistory and decision signals.
       * Agent uses this to decide: native resume vs fresh with history.
       */
      sessionContext: SessionContextSchema.optional(),
      /**
       * Structured output descriptor.
       * Forwarded to agent.sendMessage for adapters that support constrained responses.
       */
      responseSchema: ResponseSchemaDescriptorSchema.optional(),
      /** Source of the request (for audit trail). */
      source: z.enum(['extension', 'user', 'system']).optional(),
      /** Extension ID if source is 'extension' (for audit trail). */
      extensionId: z.string().optional(),
      /**
       * Window ID that initiated the session creation.
       * Preserved as creation provenance for the originating tab.
       */
      originWindowId: z.string().optional(),
      /**
       * Skip connector-swap warning if CWD change was already confirmed by user.
       * Set to true when user explicitly confirmed the CWD change via UI dialog.
       */
      skipConnectorSwapWarning: z.boolean().optional(),
      /** Origin of the message (e.g., 'voice', 'text'). */
      origin: SessionMessageOriginSchema.optional(),
    }),
    response: z.object({
      /** Generated message ID */
      messageId: z.string(),
      /** Turn ID (new or existing) */
      turnId: z.string(),
      /** Session ID (echo of request target) */
      sessionId: z.string(),
    }),
  },

  /**
   * Explicitly attach an agent to a session.
   *
   * Subject: `session.agent.attach`
   * Type: Request (RPC)
   *
   * Unlike auto-attach via sendMessage, this RPC provides explicit control over:
   * - Agent role (lead vs member)
   * - Attaching without sending a message
   *
   * For branching conversations (fork), use `session.fork` to create a new session
   * with copied history, then attach agents to the new session.
   *
   * Use this for multi-agent scenarios or when you need to pre-attach agents
   * before sending messages.
   * @example
   * ```typescript
   * // Attach a second agent as a member
   * const { agentId } = await bus.request(SessionSubjects.agent.attach, {
   *   sessionId: 'session-123',
   *   agent: { kind: 'adapter', adapterName: 'openai-node', model: 'gpt-4o' },
   *   role: 'member',
   * });
   *
   * // Attach with initial message using a persona
   * const { agentId, messageId } = await bus.request(SessionSubjects.agent.attach, {
   *   sessionId: 'session-123',
   *   agent: { kind: 'persona', personaId: 'p-456' },
   *   role: 'lead',
   *   initialMessage: 'Take over as lead',
   * });
   * ```
   */
  'agent.attach': {
    request: z.object({
      /** Target session (required). */
      sessionId: z.string(),

      /**
       * Agent selection specifying which agent to attach.
       *
       * Same discriminated union as `sendMessage.agent` — e.g.
       * `{ kind: 'adapter', adapterName: 'claude-code' }` or
       * `{ kind: 'persona', personaId: 'p-123' }`.
       * @see AgentSelectionSchema
       */
      agent: AgentSelectionSchema,

      /** Initial message to send (optional — can attach without sending). */
      initialMessage: MessageInputSchema.optional(),
      /** Agent role. Default: 'lead' if no agents exist, else 'member'. */
      role: z.enum(['lead', 'member']).optional(),
    }),
    response: z.object({
      /** Created agent ID */
      agentId: z.string(),
      /** Adapter's own session ID */
      adapterSessionId: z.string(),
      /** Assigned role */
      role: z.enum(['lead', 'member']),
      /** Message ID if initialMessage was provided */
      messageId: z.string().optional(),
      /** Turn ID if initialMessage was provided */
      turnId: z.string().optional(),
    }),
  },

  /**
   * Attach an adapter agent with an already resolved provider context.
   *
   * Local-only internal seam for framework runtimes that resolve provider
   * credentials/endpoints before delegating to the session subsystem. Public
   * callers must use `agent.attach`/`sendMessage` with `providerConfigId` so
   * session startup performs provider resolution itself.
   */
  'agent.attachResolved': localSubject({
    request: AgentAttachResolvedRequestSchema,
    response: AgentAttachResolvedResponseSchema,
  }),

  /**
   * Turn started.
   *
   * Subject: `session.turn.started`
   * Type: Event (fire-and-forget)
   * Emitted when: First user message of a turn is received
   */
  'turn.started': BaseTurnEventSchema.extend({
    /** First message that initiated this turn */
    messageId: z.string(),
    /** Agents targeted for this turn */
    agentIds: z.array(z.string()),
    /** Origin of the turn (for loop prevention and audit) */
    initiator: TurnInitiatorSchema.optional(),
    /** How this emission entered the system: live ingestion or historical backfill. */
    ingestionMarker: TurnIngestionMarkerSchema.optional(),
  }),

  /**
   * Turn completed.
   *
   * Subject: `session.turn.completed`
   * Type: Event (fire-and-forget)
   * Emitted when: All targeted agents have completed processing
   *
   * Semantics:
   * - success=true: all agents completed with outcome='completed'
   * - success=false: any agent had outcome='error'
   * - cancelled/superseded/merged outcomes are neutral (not errors)
   * - usage is present when agents emitted token usage before the turn
   *   completed; absence means unknown usage, not zero usage
   */
  'turn.completed': TurnCompletedEventSchema,

  /**
   * Await completion of a specific session turn.
   *
   * Subject: `session.turn.await`
   * Type: Request (RPC)
   *
   * Resolves with the matching `session.turn.completed` payload. The
   * completion payload is the canonical live read path for turn usage keyed by
   * `sessionId` and `turnId`; `usage` is omitted when the adapter did not
   * report token counts. The timeout is required so callers cannot accidentally
   * create an unbounded wait.
   */
  'turn.await': {
    request: z.object({
      /** Session whose turn should complete */
      sessionId: z.string(),
      /** Turn identifier to wait for */
      turnId: z.string(),
      /** Maximum wait duration in milliseconds */
      timeoutMs: z.number().int().positive(),
    }),
    response: z.object({
      /** Matched turn completion payload */
      completion: TurnCompletedEventSchema,
    }),
  },

  /**
   * User message sent to session.
   *
   * Subject: `session.user_message.sent`
   * Type: Event (fire-and-forget)
   * Emitted when: User sends a message (before routing to agents)
   */
  'user_message.sent': BaseUserMessageEventSchema.extend({
    /** Message content */
    content: MessageInputSchema,
    /** Targeted agent IDs */
    agentIds: z.array(z.string()),
    /** Request source provenance from session.sendMessage payload */
    source: z.enum(['extension', 'user', 'system']).optional(),
    /** Message origin (for example, voice input pipeline) */
    origin: SessionMessageOriginSchema.optional(),
  }),

  /**
   * User message acknowledged by agent.
   *
   * Subject: `session.user_message.acknowledged`
   * Type: Event (fire-and-forget)
   * Emitted when: An agent receives and begins processing the message
   */
  'user_message.acknowledged': BaseUserMessageEventSchema.extend({
    /** Agent that acknowledged */
    agentId: z.string(),
  }),

  /**
   * User message processing completed by agent.
   *
   * Subject: `session.user_message.completed`
   * Type: Event (fire-and-forget)
   * Emitted when: An agent finishes processing the message
   */
  'user_message.completed': BaseUserMessageEventSchema.extend({
    /** Agent that completed processing */
    agentId: z.string(),
    /** Processing outcome */
    outcome: MessageOutcomeSchema,
    /** Present when outcome='superseded': the messageId that replaced this one */
    supersededBy: z.string().optional(),
    /** Present when outcome='merged': the messageId this was folded into */
    mergedInto: z.string().optional(),
    /** Error message when outcome='error' */
    error: z.string().optional(),
  }),

  /**
   * Fork a session to create a branch point in conversation history.
   *
   * Subject: `session.fork`
   * Type: Request (RPC)
   *
   * Creates a new session that references the parent via parentSessionId
   * and forkPointMessageId. NO message copying occurs - full conversation
   * is assembled via getFullConversation() which traverses the parent chain.
   *
   * The forked session starts with no agents - use agent.attach to add agents.
   * @example
   * ```typescript
   * // Fork entire session history
   * const { sessionId } = await bus.request(SessionSubjects.fork, {
   *   sourceSessionId: 'session-123',
   * });
   *
   * // Fork from a specific message (branch point)
   * const { sessionId } = await bus.request(SessionSubjects.fork, {
   *   sourceSessionId: 'session-123',
   *   fromMessageId: 'msg-abc',
   *   name: 'Alternative approach',
   * });
   * ```
   */
  fork: {
    request: z.object({
      /** Source session to fork from */
      sourceSessionId: z.string(),
      /** Message ID to fork from (last message to include in fork) */
      fromMessageId: z.string().optional(),
      /** Optional name for the forked session */
      name: z.string().optional(),
      /** Branch kind (default: 'fork'). Use 'branch' for in-view branches, 'aside' for ephemeral Q&A. */
      branchKind: z.enum(['fork', 'branch', 'aside']).optional(),
      /** Fork transforms for context projection */
      transforms: ForkTransformsSchema.optional(),
      /** Target working directory for the forked session */
      targetWorkingDirectory: z.string().optional(),
      /** Opaque consumer-owned JSON metadata to preserve on the forked session. */
      metadata: SessionRecordMetadataSchema.optional(),
      /**
       * Pre-generated session ID to assign to the forked session.
       *
       * Host interceptors (e.g., the fork scope interceptor) may inject a
       * pre-generated UUID here so they can write junction table rows before the
       * framework session record is created, achieving a zero-timing-gap guarantee.
       * When omitted, the fork handler passes no `sessionId` to `session.create`
       * and the create handler generates a new UUID.
       */
      existingSessionId: z.string().optional(),
    }),
    response: z.object({
      /** New session ID */
      sessionId: z.string(),
    }),
  },
} satisfies SchemaRecord;

// ── Type Exports ─────────────────────────────────────────────────────────────

export type SendMessageRequest = z.infer<typeof OrchestratorSchemas.sendMessage.request>;
export type SendMessageResponse = z.infer<typeof OrchestratorSchemas.sendMessage.response>;
export type AgentAttachRequest = z.infer<(typeof OrchestratorSchemas)['agent.attach']['request']>;
export type AgentAttachResponse = z.infer<(typeof OrchestratorSchemas)['agent.attach']['response']>;
export type AgentAttachResolvedRequest = z.infer<typeof AgentAttachResolvedRequestSchema>;
export type AgentAttachResolvedResponse = z.infer<typeof AgentAttachResolvedResponseSchema>;
export type TurnStarted = z.infer<(typeof OrchestratorSchemas)['turn.started']>;
export type TurnCompleted = z.infer<(typeof OrchestratorSchemas)['turn.completed']>;
export type TurnAwaitRequest = z.infer<(typeof OrchestratorSchemas)['turn.await']['request']>;
export type TurnAwaitResponse = z.infer<(typeof OrchestratorSchemas)['turn.await']['response']>;
export type UserMessageSent = z.infer<(typeof OrchestratorSchemas)['user_message.sent']>;
export type UserMessageAcknowledged = z.infer<(typeof OrchestratorSchemas)['user_message.acknowledged']>;
export type UserMessageCompleted = z.infer<(typeof OrchestratorSchemas)['user_message.completed']>;
export type SessionForkRequest = z.infer<(typeof OrchestratorSchemas)['fork']['request']>;
export type SessionForkResponse = z.infer<(typeof OrchestratorSchemas)['fork']['response']>;
