import { z } from 'zod';
import { MessageBlockSchema, type MessageBlock } from '../../shared/index.js';

/**
 * Session message block types for structured content within stored messages.
 *
 * Unified with MessageBlock — all block types (text, image, document, attachment,
 * reasoning, tool_call, tool_output) are first-class citizens in both storage
 * and SDK contexts.
 */
export const SessionMessageBlockSchema = MessageBlockSchema;
export type SessionMessageBlock = MessageBlock;

/**
 * Session message role in a conversation.
 */
export const SessionMessageRoleSchema = z.enum(['user', 'assistant']);
export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;
export const SessionMessageOriginSchema = z.enum(['voice', 'text', 'compact']);
export type SessionMessageOrigin = z.infer<typeof SessionMessageOriginSchema>;

/**
 * A stored message in a session conversation.
 *
 * Distinct from `shared/Message` which is the SDK message format for runtime.
 * SessionMessage includes storage metadata (messageId, turnId, timestamp, etc.).
 *
 * Messages are first-class entities stored in the `messages` table.
 *
 * Design principles:
 * - Single source of truth for conversation content
 * - Blocks preserve full response fidelity (reasoning, tools)
 * - contentText extracted for full-text search
 * - Events remain for lifecycle/audit only
 */
export const SessionMessageSchema = z.object({
  /** Unique message identifier */
  messageId: z.string(),
  /** Turn this message belongs to. NULL for native imports (no turn tracking). */
  turnId: z.string().nullable(),
  /** Session this message belongs to */
  sessionId: z.string(),
  /** Message role: 'user' or 'assistant' */
  role: SessionMessageRoleSchema,
  /** Plain text content for full-text search indexing */
  contentText: z.string(),
  /** Structured blocks (text, reasoning, tool_call, tool_output) */
  blocks: z.array(SessionMessageBlockSchema),
  /** Agent ID (required for assistant, null for user) */
  agentId: z.string().optional(),
  /** Provider's session ID for context continuity */
  adapterSessionId: z.string().optional(),
  /** Adapter's stable message identifier for fork detection */
  adapterMessageId: z.string().optional(),
  /** Message timestamp (Unix ms) */
  timestamp: z.number(),
  /** If this is an edit, references the original message */
  editOf: z.string().optional(),
  /** Origin of the message (e.g. 'voice', 'text'). NULL for messages predating this field. */
  origin: SessionMessageOriginSchema.optional(),
});

export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/**
 * Turn status in the conversation lifecycle.
 */
export const TurnStatusSchema = z.enum(['active', 'completed', 'error']);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

/**
 * Usage metrics for a single agent or aggregated total.
 */
export const UsageMetricsSchema = z.object({
  /** Input tokens consumed */
  inputTokens: z.number(),
  /** Input tokens served from a provider cache. */
  cachedInputTokens: z.number().optional(),
  /** Output tokens generated */
  outputTokens: z.number(),
  /** Computed cost in USD (optional, requires pricing data) */
  cost: z.number().optional(),
});

export type UsageMetrics = z.infer<typeof UsageMetricsSchema>;

/**
 * Aggregated usage for a turn, with optional per-agent breakdown.
 */
export const TurnUsageSchema = z.object({
  /** Total aggregated usage across all agents */
  total: UsageMetricsSchema,
  /** Optional per-agent breakdown (for multi-agent turns) */
  byAgent: z.record(z.string(), UsageMetricsSchema).optional(),
});

export type TurnUsage = z.infer<typeof TurnUsageSchema>;

/**
 * Identifies the origin of a turn for loop prevention and audit.
 *
 * Used by extensions (e.g., Routine) to distinguish user-initiated turns from
 * extension-initiated turns, preventing recursive execution loops.
 */
export const TurnInitiatorSchema = z.object({
  /** Origin category */
  source: z.enum(['user', 'extension', 'system']),
  /**
   * Identifier for the specific origin.
   *
   * Examples: `'routine:validation'`, `'loop'`, `'subagent:xyz'`.
   */
  sourceId: z.string().optional(),
});

/** Parsed type for {@link TurnInitiatorSchema}. */
export type TurnInitiator = z.infer<typeof TurnInitiatorSchema>;

/**
 * A turn in a session conversation.
 *
 * A turn represents a user message and all agent responses to it.
 * Extracted from events to provide explicit turn boundaries.
 */
export const TurnSchema = z.object({
  /** Unique turn identifier */
  turnId: z.string(),
  /** Session this turn belongs to */
  sessionId: z.string(),
  /** Monotonic per-session ordinal (1-based), assigned by turn storage at creation. */
  turnNumber: z.number().int().min(1),
  /** Turn start timestamp (Unix ms) */
  startedAt: z.number(),
  /** Turn completion timestamp (Unix ms) */
  completedAt: z.number().optional(),
  /** Turn status */
  status: TurnStatusSchema,
  /** Error message if status is 'error' */
  error: z.string().optional(),
  /** Aggregated usage/cost for this turn. Populated on turn completion. */
  usage: TurnUsageSchema.optional(),
  /** Origin of the turn, when known. */
  initiator: TurnInitiatorSchema.optional(),
});

export type Turn = z.infer<typeof TurnSchema>;

/**
 * Message routing status for multi-agent delivery tracking.
 */
export const MessageRoutingStatusSchema = z.enum(['sent', 'acknowledged', 'completed']);
export type MessageRoutingStatus = z.infer<typeof MessageRoutingStatusSchema>;

/**
 * Tracks delivery status of a message to agents in multi-agent sessions.
 */
export const MessageRoutingSchema = z.object({
  /** Message being routed */
  messageId: z.string(),
  /** Target agent */
  agentId: z.string(),
  /** Current routing status */
  status: MessageRoutingStatusSchema,
  /** Status change timestamp (Unix ms) */
  timestamp: z.number(),
  /** Error message if routing failed */
  error: z.string().optional(),
});

export type MessageRouting = z.infer<typeof MessageRoutingSchema>;
