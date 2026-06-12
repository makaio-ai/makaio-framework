import { eq, and, gt, lt, inArray, asc, desc } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionEvent, SessionEventPayload, SessionEventType } from '@makaio/contracts';
import { SessionEventStorageSubjects } from './namespace.js';
import type { SelectSessionEvent } from './schema.js';
import { sessionEventsSchema } from './schema.variants.js';

/**
 * Fields stored as columns that should be stripped from the nested payload.
 */
const PAYLOAD_COLUMN_FIELDS = ['sessionId', 'agentId', 'adapterId', 'messageId', 'turnId'] as const;

/**
 * Resolved `session_events` table. The `.sqlite` face is the canonical static
 * type for both dialects (see `schema.variants.ts`).
 */
type SessionEventsTable = typeof sessionEventsSchema.sqlite.sessionEvents;

/**
 * Dependencies for session event storage handlers.
 */
interface SessionEventHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
  /** Dialect-resolved table, resolved once at registration time. */
  sessionEvents: SessionEventsTable;
}

/**
 * Strip redundant fields from event payload before storage.
 *
 * Removes fields that are already stored as columns to reduce storage size.
 * The full event can be reconstructed via enrichFromRow().
 * @param event - The session event to strip
 * @returns Stripped payload containing only non-redundant data
 */
function stripForStorage(event: MakaioSessionEvent): Record<string, unknown> {
  const innerPayload = event.payload as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(innerPayload)) {
    if (!(PAYLOAD_COLUMN_FIELDS as readonly string[]).includes(key)) {
      stripped[key] = value;
    }
  }

  return stripped;
}

/**
 * Reconstruct full MakaioSessionEvent from database row.
 *
 * Enriches the stripped payload with column values to recreate
 * the original event structure.
 * @param row - Database row with columns and stripped payload
 * @returns Full MakaioSessionEvent matching original structure
 */
function enrichFromRow(row: SelectSessionEvent): MakaioSessionEvent {
  const strippedPayload = JSON.parse(row.payload) as Record<string, unknown>;

  // For type='message' events, messageId is the FK to messages table
  // For other events, originatingMessageId is the triggering message
  const messageIdValue = row.type === 'message' ? row.messageId : row.originatingMessageId;

  // Reconstruct payload with column values.
  // For type='message', turnId is required-but-nullable in the schema, so it
  // must always be present (even as null). For all other event types the field
  // is absent from the schema, so omit it when the column is null.
  const payload: Record<string, unknown> = {
    ...strippedPayload,
    sessionId: row.sessionId,
    ...(row.agentId && { agentId: row.agentId }),
    ...(row.adapterId && { adapterId: row.adapterId }),
    ...(messageIdValue && { messageId: messageIdValue }),
    ...(row.type === 'message' ? { turnId: row.turnId ?? null } : row.turnId && { turnId: row.turnId }),
  };

  return {
    sessionId: row.sessionId,
    eventId: row.eventId,
    timestamp: row.timestamp,
    type: row.type as SessionEventType,
    payload,
  } as MakaioSessionEvent;
}

/**
 * Extract text content from event payload for search/embeddings.
 *
 * NOTE: Session events store lifecycle metadata only. Message content
 * is stored in the `messages` table via MessageStorageSubjects.
 * @param event - The session event to extract content from
 * @returns Extracted text content, or null if event has no searchable text
 */
function extractContentText(event: MakaioSessionEvent): string | null {
  switch (event.type) {
    case 'user_message.sent': {
      const payload = event.payload as SessionEventPayload<'user_message.sent'>;
      const content = payload.content;
      // Handle both string and structured Message format
      if (typeof content === 'string') {
        return content;
      }
      // Extract text from message blocks
      const blocks = Array.isArray(content.blocks) ? content.blocks : [content.blocks];
      return blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.content)
        .join('\n');
    }
    // Structural events - no searchable content
    case 'agent.added':
    case 'user_message.acknowledged':
    case 'user_message.completed':
    case 'turn.started':
    case 'turn.completed':
    // Message link event - content is in messages table, not here
    case 'message':
    // Branch/squash events - no searchable content
    case 'branch.created':
    case 'branch.merged':
    case 'squash':
      return null;
    default: {
      return extractPluginContentText(event.payload as Record<string, unknown>);
    }
  }
}

/**
 * Extract text content for plugin-defined event payloads.
 *
 * Checks for common content fields in order of priority:
 * 1. `contentText` - explicit searchable content field
 * 2. `summary` - fallback for summary-style events
 *
 * Empty strings are treated as absent (falls through to next field).
 * @param payload - Event payload for an extensible event type
 * @returns Text to store in contentText, or null if none is present
 */
function extractPluginContentText(payload: Record<string, unknown>): string | null {
  // Check contentText first - prefer explicit contentText field if non-empty
  const contentText = payload.contentText;
  if (typeof contentText === 'string' && contentText.length > 0) {
    return contentText;
  }

  // Fall back to summary field
  const summary = payload.summary;
  if (typeof summary === 'string' && summary.length > 0) {
    return summary;
  }

  return null;
}

/**
 * Register handler for appending events to storage.
 * @param deps - Dependencies containing bus and database
 * @returns Cleanup function to unsubscribe handler
 */
function registerAppendHandler({ bus, db, sessionEvents }: SessionEventHandlerDeps): () => void {
  return bus.on(SessionEventStorageSubjects.append, async (ctx) => {
    const { event } = ctx.payload;

    // Extract metadata from payload
    const agentId = 'payload' in event && 'agentId' in event.payload ? (event.payload.agentId as string) : null;
    const adapterId = 'payload' in event && 'adapterId' in event.payload ? (event.payload.adapterId as string) : null;
    const turnId = 'payload' in event && 'turnId' in event.payload ? (event.payload.turnId as string) : null;
    const payloadMessageId =
      'payload' in event && 'messageId' in event.payload ? (event.payload.messageId as string) : null;

    // For type='message' events, messageId is the FK to messages table
    // For other events, messageId in payload is the originating/triggering message
    const messageId = event.type === 'message' ? payloadMessageId : null;
    const originatingMessageId = event.type !== 'message' ? payloadMessageId : null;

    // On conflict on eventId (unique), do nothing — idempotent append semantics.
    // This lets merge-handler and compress-handler retry safely.
    const values = {
      sessionId: event.sessionId,
      eventId: event.eventId,
      timestamp: event.timestamp,
      type: event.type,
      agentId,
      adapterId,
      messageId,
      originatingMessageId,
      turnId,
      contentText: extractContentText(event),
      payload: JSON.stringify(stripForStorage(event)),
    };
    await db.insert(sessionEvents).values(values).onConflictDoNothing();

    ctx.setResult({ success: true });
  });
}

/**
 * Register handler for retrieving events with cursor-based pagination.
 * @param deps - Dependencies containing bus and database
 * @returns Cleanup function to unsubscribe handler
 */
function registerGetEventsHandler({ bus, db, sessionEvents }: SessionEventHandlerDeps): () => void {
  return bus.on(SessionEventStorageSubjects.getEvents, async (ctx) => {
    const { sessionId, options } = ctx.payload;

    // Build where conditions
    const conditions = [eq(sessionEvents.sessionId, sessionId)];

    // Determine sort order (default: ascending for oldest-first)
    const sortOrder = options?.order ?? 'asc';

    // Handle cursor-based pagination
    if (options?.after) {
      const cursorId = parseInt(options.after, 10);
      if (!isNaN(cursorId) && cursorId > 0) {
        // For descending order, we want events with id < cursor (older events)
        // For ascending order, we want events with id > cursor (newer events)
        if (sortOrder === 'desc') {
          conditions.push(lt(sessionEvents.id, cursorId));
        } else {
          conditions.push(gt(sessionEvents.id, cursorId));
        }
      }
    }

    // Filter by types
    if (options?.types && options.types.length > 0) {
      conditions.push(inArray(sessionEvents.type, options.types));
    }

    // Apply limit + 1 to check if there's more
    const limit = options?.limit ?? 100;
    const orderByFn = sortOrder === 'desc' ? desc : asc;
    const rows = await db
      .select()
      .from(sessionEvents)
      .where(and(...conditions))
      .orderBy(orderByFn(sessionEvents.id))
      .limit(limit + 1);

    // NOTE: Session events only contain lifecycle metadata, not message content

    // Check if there are more results
    const hasMore = rows.length > limit;
    const eventRows = hasMore ? rows.slice(0, limit) : rows;

    // Map to events
    const events = eventRows.map(enrichFromRow);

    // Calculate next cursor
    const nextCursor = hasMore && eventRows.length > 0 ? eventRows[eventRows.length - 1].id.toString() : null;

    ctx.setResult({
      events,
      nextCursor,
      // Note: totalCount is expensive for large datasets, omitted for now
    });
  });
}

/**
 * Register handler for retrieving events by IDs.
 * @param deps - Dependencies containing bus and database
 * @returns Cleanup function to unsubscribe handler
 */
function registerGetByIdsHandler({ bus, db, sessionEvents }: SessionEventHandlerDeps): () => void {
  return bus.on(SessionEventStorageSubjects.getByIds, async (ctx) => {
    const { sessionId, eventIds } = ctx.payload;
    const rows = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), inArray(sessionEvents.eventId, eventIds)))
      .orderBy(asc(sessionEvents.timestamp));
    const events = rows.map(enrichFromRow);
    ctx.setResult({ events });
  });
}

/**
 * Register handler for deleting events by session.
 * @param deps - Dependencies containing bus and database
 * @returns Cleanup function to unsubscribe handler
 */
function registerDeleteBySessionHandler({ bus, db, sessionEvents }: SessionEventHandlerDeps): () => void {
  return bus.on(SessionEventStorageSubjects.deleteBySession, async (ctx) => {
    const { sessionId } = ctx.payload;

    // Count before delete (for reporting)
    const countResult = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    const deletedCount = countResult.length;

    // Delete all events for this session (CASCADE handles this automatically)
    await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));

    ctx.setResult({ success: true, deletedCount });
  });
}

/**
 * Register handler for retrieving events for multiple sessions.
 * @param deps - Dependencies containing bus and database
 * @returns Cleanup function to unsubscribe handler
 */
function registerGetEventsBySessionsHandler({ bus, db, sessionEvents }: SessionEventHandlerDeps): () => void {
  return bus.on(SessionEventStorageSubjects.getEventsBySessions, async (ctx) => {
    const { sessionIds, types, limitPerSession = 50 } = ctx.payload;

    if (sessionIds.length === 0 || types.length === 0) {
      ctx.setResult({ eventsBySession: {} });
      return;
    }

    const eventsBySession: Record<string, MakaioSessionEvent[]> = {};

    for (const sessionId of sessionIds) {
      const rows = await db
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.sessionId, sessionId), inArray(sessionEvents.type, types)))
        .orderBy(desc(sessionEvents.timestamp))
        .limit(limitPerSession);
      if (rows.length > 0) {
        eventsBySession[sessionId] = rows.map(enrichFromRow);
      }
    }

    ctx.setResult({ eventsBySession });
  });
}

/**
 * Register Drizzle-based session event storage handlers.
 *
 * Persists events via Drizzle ORM with cursor-based pagination and content
 * extraction for future FTS/embedding support.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerDrizzleSessionEventStorage } from '@makaio/services-core/session';
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({ url: 'file:./makaio.db' });
 * const db = drizzle(client);
 * const cleanup = registerDrizzleSessionEventStorage(bus, db);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleSessionEventStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  // Resolve the dialect schema once; every handler shares the same table.
  const { sessionEvents } = resolveSchema(db, sessionEventsSchema);
  const deps: SessionEventHandlerDeps = { bus, db, sessionEvents };
  const cleanups = [
    registerAppendHandler(deps),
    registerGetEventsHandler(deps),
    registerGetByIdsHandler(deps),
    registerDeleteBySessionHandler(deps),
    registerGetEventsBySessionsHandler(deps),
  ];

  return () => cleanups.forEach((fn) => fn());
}
