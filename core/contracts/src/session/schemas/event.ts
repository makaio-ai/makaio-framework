import { z } from 'zod';
import { BranchKindSchema } from './primitives.js';
import { OrchestratorSchemas, type TurnInitiator } from './orchestrator.js';

/**
 * Extend a schema with sessionId for session-scoped events.
 * @param schema - The schema to extend
 * @returns Schema extended with sessionId field
 */
export const withSessionId = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.extend({ sessionId: z.string() });

/**
 * Common envelope fields present on every persisted session event.
 *
 * All core and plugin session event schemas compose from this base.
 */
export const SessionEventEnvelopeSchema = z.object({
  /** Session the event belongs to. */
  sessionId: z.string(),
  /** Stable unique identifier for this event row. */
  eventId: z.string(),
  /** Unix epoch milliseconds when the event was recorded. */
  timestamp: z.number(),
});

/**
 * Session event schema for storage and observability.
 *
 * **Architecture:**
 * - Messages are stored in the `messages` table as first-class entities
 * - Session events (this schema) store session-scoped metadata for
 *   multi-agent correlation, keyed by sessionId
 *
 * The correlation link is `agent.added` which maps:
 * `sessionId ↔ agentId ↔ adapterSessionId`
 *
 * Subject: `session.event`
 * Type: Event (fire-and-forget)
 * Use for: Session-level persistence, multi-agent reconstruction
 */
const CoreSessionEventSchema = z.discriminatedUnion('type', [
  // Correlation link: maps sessionId to agentId/adapterSessionId
  SessionEventEnvelopeSchema.extend({
    type: z.literal('agent.added'),
    payload: z.object({
      sessionId: z.string(),
      adapterSessionId: z.string(),
      agentId: z.string(),
      adapterId: z.string(),
      adapterName: z.string(),
      role: z.enum(['lead', 'member']).optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
    }),
  }),
  // User message events (owned by SessionOrchestrator)
  SessionEventEnvelopeSchema.extend({
    type: z.literal('user_message.sent'),
    payload: OrchestratorSchemas['user_message.sent'],
  }),
  SessionEventEnvelopeSchema.extend({
    type: z.literal('user_message.acknowledged'),
    payload: OrchestratorSchemas['user_message.acknowledged'],
  }),
  SessionEventEnvelopeSchema.extend({
    type: z.literal('user_message.completed'),
    payload: OrchestratorSchemas['user_message.completed'],
  }),
  // Turn lifecycle events (owned by SessionOrchestrator)
  SessionEventEnvelopeSchema.extend({
    type: z.literal('turn.started'),
    payload: OrchestratorSchemas['turn.started'],
  }),
  SessionEventEnvelopeSchema.extend({
    type: z.literal('turn.completed'),
    payload: OrchestratorSchemas['turn.completed'],
  }),
  // Message link: connects messages table to session_events for unified history
  SessionEventEnvelopeSchema.extend({
    type: z.literal('message'),
    payload: z.object({
      messageId: z.string(),
      turnId: z.string().nullable(),
      role: z.enum(['user', 'assistant']),
    }),
  }),
  // Branch lifecycle events
  SessionEventEnvelopeSchema.extend({
    type: z.literal('branch.created'),
    payload: z.object({
      /** The session that was created */
      childSessionId: z.string(),
      /** The parent session it branched from */
      parentSessionId: z.string(),
      /** Type of branch */
      kind: BranchKindSchema,
      /** Message ID where the branch diverged (last shared message) */
      forkPointMessageId: z.string().optional(),
    }),
  }),
  SessionEventEnvelopeSchema.extend({
    type: z.literal('branch.merged'),
    payload: z.object({
      /** The branch session that was merged */
      childSessionId: z.string(),
      /** The parent session it merged into */
      parentSessionId: z.string(),
      /** Summary/result injected into parent (JSON string) */
      resultJson: z.string().optional(),
      /** Message ID of the injected summary in parent session */
      resultMessageId: z.string().optional(),
    }),
  }),
  // Compression events
  SessionEventEnvelopeSchema.extend({
    type: z.literal('squash'),
    payload: z.object({
      /** Structured summary JSON that replaces prior context */
      summaryJson: z.string(),
      /** Token count before compression */
      tokensBefore: z.number().optional(),
      /** Token count after compression */
      tokensAfter: z.number().optional(),
      /** Message IDs that were compressed (for audit) */
      compressedMessageIds: z.array(z.string()).optional(),
    }),
  }),
]);

/**
 * Persistable core session event types.
 *
 * Must match CoreSessionEventSchema variants exactly.
 * Add new types here only when corresponding schema variant exists.
 */
const CORE_SESSION_EVENT_TYPES = [
  // Message assembly
  'message',
  // Agent lifecycle
  'agent.added',
  // Turn lifecycle
  'turn.started',
  'turn.completed',
  // User message events
  'user_message.sent',
  'user_message.acknowledged',
  'user_message.completed',
  // Branch lifecycle events
  'branch.created',
  'branch.merged',
  // Compression events
  'squash',
] as const;

export const SESSION_EVENT_TYPES = CORE_SESSION_EVENT_TYPES;

/**
 * Generic plugin event schema for extensible event types.
 *
 * Allows extensions to append custom event types without core schema changes.
 * Core event types remain validated by CoreSessionEventSchema.
 */
const PluginSessionEventSchema = SessionEventEnvelopeSchema.extend({
  type: z
    .string()
    .refine((value) => !CORE_SESSION_EVENT_TYPES.includes(value as (typeof CORE_SESSION_EVENT_TYPES)[number]), {
      message: 'Plugin session event type must not shadow a core event type.',
    }),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Session event schema for storage and observability.
 *
 * Includes:
 * - Core event types (validated, discriminated union)
 * - Plugin event types (extensible, payload as record)
 */
export const MakaioSessionEventSchema = z.union([CoreSessionEventSchema, PluginSessionEventSchema]);

// ============================================================================
// Extensible Type System for Plugins
// ============================================================================

/**
 * Zod schema for session event types.
 *
 * Accepts any string at runtime for plugin flexibility.
 * Type safety is provided via {@link SessionEventTypeMap} and declaration merging.
 */
export const SessionEventTypeSchema = z.string();

/**
 * Map of session event types to their payload schemas.
 *
 * **Plugin Extension Pattern:**
 * Plugins can extend this interface via TypeScript declaration merging to add
 * custom event types:
 * @example
 * ```typescript
 * // In plugin code
 * declare module '@makaio/contracts' {
 *   interface SessionEventTypeMap {
 *     'timeline.summary': {
 *       messageId: string;
 *       role: 'user' | 'assistant';
 *       summary: string;
 *     };
 *   }
 * }
 * ```
 *
 * Core event types are defined here to maintain type safety for the base system.
 * Plugins augment this map without modifying source code.
 */
export interface SessionEventTypeMap {
  /**
   * Message correlation event linking messages table to session events.
   */
  message: {
    messageId: string;
    turnId: string | null;
    role: 'user' | 'assistant';
  };

  /**
   * Agent added to session (correlation link).
   */
  'agent.added': {
    sessionId: string;
    adapterSessionId: string;
    agentId: string;
    adapterId: string;
    adapterName: string;
    role?: 'lead' | 'member';
    model?: string;
    cwd?: string;
  };

  /**
   * Turn started event.
   */
  'turn.started': {
    sessionId: string;
    turnId: string;
    messageId: string;
    agentIds: string[];
    initiator?: TurnInitiator;
  };

  /**
   * Turn completed event.
   */
  'turn.completed': {
    sessionId: string;
    turnId: string;
    success: boolean;
    error?: string;
    initiator?: TurnInitiator;
  };

  /**
   * User message sent to session.
   */
  'user_message.sent': z.infer<(typeof OrchestratorSchemas)['user_message.sent']>;

  /**
   * User message acknowledged by agent.
   */
  'user_message.acknowledged': z.infer<(typeof OrchestratorSchemas)['user_message.acknowledged']>;

  /**
   * User message processing completed.
   */
  'user_message.completed': z.infer<(typeof OrchestratorSchemas)['user_message.completed']>;

  /**
   * Branch created from parent session.
   */
  'branch.created': {
    childSessionId: string;
    parentSessionId: string;
    kind: z.infer<typeof BranchKindSchema>;
    forkPointMessageId?: string;
  };

  /**
   * Branch merged into parent session.
   */
  'branch.merged': {
    childSessionId: string;
    parentSessionId: string;
    resultJson?: string;
    resultMessageId?: string;
  };

  /**
   * Context compression event.
   */
  squash: {
    summaryJson: string;
    tokensBefore?: number;
    tokensAfter?: number;
    compressedMessageIds?: string[];
  };

  /**
   * Emitted on the parent session when a Claude Code compaction boundary is
   * imported. Uses the plugin event path — not a core event type.
   */
  'session.compacted': {
    /** Whether compaction was triggered manually (`/compact`) or automatically. */
    trigger: 'manual' | 'auto';
    /** Approximate token count before compaction. */
    preTokens: number | null;
    /** Summary text from the `isCompactSummary` user message when available. */
    summary: string | null;
    /** Makaio session ID of the compress child (post-compaction session). */
    compressChildSessionId: string;
  };

  /**
   * Plugins may extend this map via declaration merging.
   */
}

/**
 * Union of all session event type keys (core + plugin-defined).
 *
 * Runtime validation uses {@link SessionEventTypeSchema} (accepts any string).
 * Compile-time typing is derived from {@link SessionEventTypeMap} keys.
 */
export type SessionEventType = keyof SessionEventTypeMap;

/**
 * Get the payload type for a specific session event type.
 * @typeParam T - The event type key
 * @example
 * ```typescript
 * type MessagePayload = SessionEventPayload<'message'>;
 * // { messageId: string; turnId: string | null; role: 'user' | 'assistant' }
 * ```
 */
export type SessionEventPayload<T extends SessionEventType> = SessionEventTypeMap[T];
