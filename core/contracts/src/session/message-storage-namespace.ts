import { z } from 'zod';
import { createContractStorageNamespace } from '../storage-namespace-definition.js';
import { SessionMessageSchema, SessionMessageBlockSchema, SessionMessageOriginSchema } from './schemas/message.js';

/**
 * Opaque keyset cursor for deterministic message pagination.
 *
 * Timestamp alone is not sufficient because multiple messages can share the
 * same millisecond. The messageId tie-breaker makes pagination stable.
 */
export const MessagePageCursorSchema = z.object({
  timestamp: z.number(),
  messageId: z.string(),
});

/**
 * Deterministic message-pagination cursor.
 */
export type MessagePageCursor = z.infer<typeof MessagePageCursorSchema>;

/**
 * Message storage namespace.
 *
 * Provides bus subjects for message storage operations.
 * Registered under `storage:message` on the Makaio bus.
 *
 * Storage backends register handlers; consumers communicate through
 * subjects only, never importing directly from storage implementations.
 * @example
 * ```typescript
 * import { MessageStorageSubjects } from '@makaio/contracts';
 *
 * const { message } = await bus.request(MessageStorageSubjects.get, { messageId: '123' });
 * const { results } = await bus.request(MessageStorageSubjects.ftsSearch, { query: 'auth' });
 * ```
 */
export const MessageStorageNamespace = createContractStorageNamespace('message', {
  schemas: {
    /**
     * Append a message to a turn.
     *
     * Subject: `storage:message.append`
     * Type: Request (RPC)
     */
    append: {
      request: z.object({
        message: SessionMessageSchema.omit({ messageId: true }).extend({
          messageId: z.string().optional(),
        }),
        /** Whether to emit a session event for this message (default: true) */
        emitEvent: z.boolean().optional(),
      }),
      response: z.object({
        message: SessionMessageSchema,
      }),
    },

    /**
     * Get messages for a session.
     *
     * Subject: `storage:message.getBySession`
     * Type: Request (RPC)
     */
    getBySession: {
      request: z.object({
        sessionId: z.string(),
        limit: z.number().int().min(1).optional(),
        after: MessagePageCursorSchema.optional(),
        /** Include the `after` cursor item itself in the first page. Defaults to false. */
        includeAfter: z.boolean().optional(),
        /** Sort order by timestamp. Defaults to 'asc' (oldest first). */
        order: z.enum(['asc', 'desc']).optional(),
      }),
      response: z.object({
        messages: z.array(SessionMessageSchema),
        nextCursor: MessagePageCursorSchema.nullable(),
      }),
    },

    /**
     * Get messages for a turn.
     *
     * Subject: `storage:message.getByTurn`
     * Type: Request (RPC)
     */
    getByTurn: {
      request: z.object({
        turnId: z.string(),
      }),
      response: z.object({
        messages: z.array(SessionMessageSchema),
      }),
    },

    /**
     * Get a single message by ID.
     *
     * Subject: `storage:message.get`
     * Type: Request (RPC)
     */
    get: {
      request: z.object({
        messageId: z.string(),
      }),
      response: z.object({
        message: SessionMessageSchema.nullable(),
      }),
    },

    /**
     * Get a message by adapter message ID.
     *
     * Subject: `storage:message.getByAdapterMessageId`
     * Type: Request (RPC)
     */
    getByAdapterMessageId: {
      request: z.object({
        adapterMessageId: z.string(),
      }),
      response: z.object({
        message: SessionMessageSchema.nullable(),
      }),
    },

    /**
     * Full-text search over messages, ordered by relevance
     * (FTS5/bm25 on SQLite; tsvector/ts_rank on Postgres).
     *
     * Subject: `storage:message.search`
     * Type: Request (RPC)
     */
    search: {
      request: z.object({
        query: z.string(),
        sessionId: z.string().optional(),
        limit: z.number().int().min(1).optional(),
      }),
      response: z.object({
        messages: z.array(SessionMessageSchema),
        total: z.number(),
      }),
    },

    /**
     * Full-text search over messages with relevance scores and highlighted
     * excerpts (FTS5/bm25 on SQLite; tsvector/ts_rank with ts_headline on
     * Postgres).
     *
     * Subject: `storage:message.ftsSearch`
     * Type: Request (RPC)
     *
     * Unlike `search`, this subject returns scored results with highlighted
     * excerpts — suitable for ranking and display in search UIs.
     */
    ftsSearch: {
      request: z.object({
        /**
         * Search query. Query semantics are dialect-specific: on SQLite each
         * token is sanitized into a quoted FTS5 term with AND semantics; on
         * Postgres the query is parsed by `websearch_to_tsquery` (web-search
         * syntax: quoted phrases, OR, and `-` negation).
         */
        query: z.string(),
        /** Restrict results to a single session */
        sessionId: z.string().optional(),
        /** Maximum number of results to return (default: 20) */
        limit: z.number().int().min(1).optional().default(20),
      }),
      response: z.object({
        results: z.array(
          z.object({
            /** Makaio message ID */
            messageId: z.string(),
            /** Session the message belongs to */
            sessionId: z.string(),
            /**
             * Relevance score (higher = more relevant). The scale is
             * dialect-specific (negated bm25 on SQLite, ts_rank on Postgres);
             * scores are positive on both dialects but never comparable
             * across dialects.
             */
            score: z.number(),
            /** Snippet with matched terms highlighted using `<mark>` tags */
            excerpt: z.string(),
          }),
        ),
        /** Total number of matching messages (without the limit applied) */
        total: z.number(),
      }),
    },

    /**
     * Upsert a message by adapterMessageId (for imports).
     *
     * Subject: `storage:message.upsertByAdapterMessageId`
     * Type: Request (RPC)
     */
    upsertByAdapterMessageId: {
      request: z.object({
        /** Session this message belongs to */
        sessionId: z.string(),
        /** Turn ID (null for imports - no turn tracking) */
        turnId: z.string().nullable(),
        /** Adapter's message ID for deduplication (Claude Code uuid) */
        adapterMessageId: z.string(),
        /** Message role */
        role: z.enum(['user', 'assistant']),
        /** Plain text content for FTS indexing */
        contentText: z.string(),
        /** Structured content blocks */
        blocks: z.array(SessionMessageBlockSchema),
        /** Agent ID (for assistant messages) */
        agentId: z.string().optional(),
        /** Adapter's session ID */
        adapterSessionId: z.string().optional(),
        /** Message timestamp (Unix ms) */
        timestamp: z.number(),
        /** Origin of the message (e.g. voice/text) */
        origin: SessionMessageOriginSchema.optional(),
      }),
      response: z.object({
        /** Makaio's internal message ID */
        messageId: z.string(),
        /** True if a new message was created, false if already existed */
        created: z.boolean(),
      }),
    },

    /**
     * Emitted after a message is successfully persisted.
     *
     * Subject: `storage:message.stored`
     * Type: Event (fire-and-forget via bus.emit)
     */
    stored: z.object({
      message: SessionMessageSchema,
    }),
  },
});

/**
 * Typed subjects for message storage bus operations.
 */
export const MessageStorageSubjects = MessageStorageNamespace.subjects;
