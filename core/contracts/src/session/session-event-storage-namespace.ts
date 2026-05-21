import { z } from 'zod';
import { createContractStorageNamespace } from '../storage-namespace-definition.js';
import { MakaioSessionEventSchema } from './schemas.js';

/**
 * Session event query options schema.
 */
const SessionEventQueryOptionsSchema = z.object({
  /** Return events after this cursor (cursor-based pagination) */
  after: z.string().optional(),
  /** Max events to return (default: 100) */
  limit: z.number().int().min(1).optional(),
  /** Filter by event types */
  types: z.array(z.string()).optional(),
  /** Include reasoning blocks? (default: true) */
  includeReasoning: z.boolean().optional(),
  /** Sort order: 'asc' (oldest first, default) or 'desc' (newest first) */
  order: z.enum(['asc', 'desc']).optional(),
});

/**
 * Session event page schema.
 */
const SessionEventPageSchema = z.object({
  /** Events matching the query */
  events: z.array(MakaioSessionEventSchema),
  /** Cursor for next page (null if no more) */
  nextCursor: z.string().nullable(),
  /** Total count (if efficiently available) */
  totalCount: z.number().optional(),
});

/**
 * Session event storage namespace.
 *
 * Provides bus subjects for session event storage operations.
 * Registered under `storage:sessionEvent` on the Makaio bus.
 *
 * Events are immutable and append-only.
 * @example
 * ```typescript
 * import { SessionEventStorageSubjects } from '@makaio/contracts';
 *
 * const { events } = await bus.request(SessionEventStorageSubjects.getEvents, {
 *   sessionId: '123',
 *   options: { types: ['question-extractor.result'], limit: 50 },
 * });
 * ```
 */
export const SessionEventStorageNamespace = createContractStorageNamespace('sessionEvent', {
  schemas: {
    /**
     * Append an event to storage.
     *
     * Subject: `storage:sessionEvent.append`
     * Type: Request (RPC)
     *
     * Events are immutable — no update method exists.
     */
    append: {
      request: z.object({
        event: MakaioSessionEventSchema,
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Get events for a session with cursor-based pagination.
     *
     * Subject: `storage:sessionEvent.getEvents`
     * Type: Request (RPC)
     */
    getEvents: {
      request: z.object({
        sessionId: z.string(),
        options: SessionEventQueryOptionsSchema.optional(),
      }),
      response: SessionEventPageSchema,
    },

    /**
     * Get events by ID for a session.
     *
     * Subject: `storage:sessionEvent.getByIds`
     * Type: Request (RPC)
     */
    getByIds: {
      request: z.object({
        sessionId: z.string(),
        eventIds: z.array(z.string()),
      }),
      response: z.object({
        events: z.array(MakaioSessionEventSchema),
      }),
    },

    /**
     * Delete all events for a session.
     *
     * Subject: `storage:sessionEvent.deleteBySession`
     * Type: Request (RPC)
     */
    deleteBySession: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
        deletedCount: z.number().optional(),
      }),
    },

    /**
     * Get events for multiple sessions, grouped by session ID.
     *
     * Subject: `storage:sessionEvent.getEventsBySessions`
     * Type: Request (RPC)
     */
    getEventsBySessions: {
      request: z.object({
        /** Session IDs to query events for */
        sessionIds: z.array(z.string()),
        /** Event types to filter */
        types: z.array(z.string()),
        /** Max events per session (default: 50) */
        limitPerSession: z.number().int().min(1).optional(),
      }),
      response: z.object({
        /** Events grouped by session ID */
        eventsBySession: z.record(z.string(), z.array(MakaioSessionEventSchema)),
      }),
    },
  },
});

/**
 * Typed subjects for session event storage bus operations.
 */
export const SessionEventStorageSubjects = SessionEventStorageNamespace.subjects;
