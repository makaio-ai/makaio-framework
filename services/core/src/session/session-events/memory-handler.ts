import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionEvent } from '@makaio/contracts';
import { SessionEventStorageSubjects } from './namespace.js';

/**
 * Register append handler for in-memory storage.
 *
 * Each appended event is assigned a stable, monotonically-increasing sequence ID
 * via `seqIdByEventId`.
 * @param bus - The bus instance
 * @param eventsBySession - The in-memory event store
 * @param seqIdByEventId - Secondary index mapping eventId to stable sequence ID
 * @param nextSeqId - Returns and increments the next sequence ID to assign
 * @returns Cleanup function to unsubscribe the handler
 */
function registerAppendHandler(
  bus: IMakaioBus,
  eventsBySession: Map<string, Array<MakaioSessionEvent>>,
  seqIdByEventId: Map<string, number>,
  nextSeqId: () => number,
): () => void {
  return bus.on(SessionEventStorageSubjects.append, (ctx) => {
    const { event } = ctx.payload;

    const events = eventsBySession.get(event.sessionId) ?? [];

    // Idempotent guard: silently skip duplicate eventIds, matching the
    // .onConflictDoNothing() semantics of the drizzle handler.
    if (seqIdByEventId.has(event.eventId)) {
      ctx.setResult({ success: true });
      return;
    }

    events.push(event);
    eventsBySession.set(event.sessionId, events);

    // Assign a stable sequence ID at write time so cursors remain valid
    // regardless of future appends or deletes.
    seqIdByEventId.set(event.eventId, nextSeqId());

    ctx.setResult({ success: true });
  });
}

/**
 * Register getEvents handler for in-memory storage.
 *
 * Cursor resolution uses the stable sequence ID assigned at append time
 * (same semantics as the Drizzle handler's auto-increment `id` column):
 * - Ascending:  return events whose seqId is greater than the cursor seqId.
 * - Descending: return events whose seqId is less than the cursor seqId.
 *
 * Because seqIds are assigned once and never reused, a cursor remains valid
 * across concurrent appends and correctly skips over deleted events.
 * @param bus - The bus instance
 * @param eventsBySession - The in-memory event store
 * @param seqIdByEventId - Secondary index mapping eventId to stable sequence ID
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetEventsHandler(
  bus: IMakaioBus,
  eventsBySession: Map<string, Array<MakaioSessionEvent>>,
  seqIdByEventId: Map<string, number>,
): () => void {
  return bus.on(SessionEventStorageSubjects.getEvents, (ctx) => {
    const { sessionId, options } = ctx.payload;
    const allEvents = eventsBySession.get(sessionId) ?? [];

    // Determine sort order (default: ascending for oldest-first)
    const sortOrder = options?.order ?? 'asc';

    // Events are stored in ascending insertion order; reverse for desc.
    const workingEvents = sortOrder === 'desc' ? [...allEvents].reverse() : allEvents;

    // Resolve cursor to a start index using stable seqIds (not array positions).
    // Mirrors the Drizzle handler's gt(id, cursorId) / lt(id, cursorId) semantics.
    let startIndex = 0;
    if (options?.after && /^\d+$/.test(options.after)) {
      const cursorSeqId = Number(options.after);
      // Find the first event in the working order that falls "after" the cursor.
      const idx = workingEvents.findIndex((e) => {
        const seqId = seqIdByEventId.get(e.eventId) ?? -1;
        return sortOrder === 'desc' ? seqId < cursorSeqId : seqId > cursorSeqId;
      });
      if (idx === -1) {
        // No events after the cursor position — pagination is exhausted.
        ctx.setResult({ events: [], nextCursor: null, totalCount: allEvents.length });
        return;
      }
      startIndex = idx;
    }

    // Filter by types if specified
    let filteredEvents = workingEvents.slice(startIndex);
    if (options?.types && options.types.length > 0) {
      const typeSet = new Set(options.types);
      filteredEvents = filteredEvents.filter((e) => typeSet.has(e.type));
    }

    // NOTE: Session events only contain lifecycle metadata, not message content

    // Apply limit
    const limit = options?.limit ?? 100;
    const hasMore = filteredEvents.length > limit;
    const events = filteredEvents.slice(0, limit);

    // Build next cursor using the last returned event's stable seqId.
    let nextCursor: string | null = null;
    if (hasMore && events.length > 0) {
      const lastEvent = events[events.length - 1];
      const seqId = seqIdByEventId.get(lastEvent.eventId);
      if (seqId !== undefined) {
        nextCursor = seqId.toString();
      }
    }

    ctx.setResult({
      events,
      nextCursor,
      totalCount: allEvents.length,
    });
  });
}

/**
 * Register getByIds handler for in-memory storage.
 * @param bus - The bus instance
 * @param eventsBySession - The in-memory event store
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetByIdsHandler(bus: IMakaioBus, eventsBySession: Map<string, Array<MakaioSessionEvent>>): () => void {
  return bus.on(SessionEventStorageSubjects.getByIds, (ctx) => {
    const { sessionId, eventIds } = ctx.payload;
    const events = eventsBySession.get(sessionId) ?? [];
    const idSet = new Set(eventIds);
    const selected = events.filter((event) => idSet.has(event.eventId));
    ctx.setResult({ events: selected });
  });
}

/**
 * Register deleteBySession handler for in-memory storage.
 * @param bus - The bus instance
 * @param eventsBySession - The in-memory event store
 * @param seqIdByEventId - Secondary index mapping eventId to stable sequence ID
 * @returns Cleanup function to unsubscribe the handler
 */
function registerDeleteBySessionHandler(
  bus: IMakaioBus,
  eventsBySession: Map<string, Array<MakaioSessionEvent>>,
  seqIdByEventId: Map<string, number>,
): () => void {
  return bus.on(SessionEventStorageSubjects.deleteBySession, (ctx) => {
    const { sessionId } = ctx.payload;

    const events = eventsBySession.get(sessionId);
    if (events) {
      for (const event of events) {
        seqIdByEventId.delete(event.eventId);
      }
    }
    const deletedCount = events?.length ?? 0;
    eventsBySession.delete(sessionId);
    ctx.setResult({ success: true, deletedCount });
  });
}

/**
 * Register getEventsBySessions handler for in-memory storage.
 * @param bus - The bus instance
 * @param eventsBySession - The in-memory event store
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetEventsBySessionsHandler(
  bus: IMakaioBus,
  eventsBySession: Map<string, Array<MakaioSessionEvent>>,
): () => void {
  return bus.on(SessionEventStorageSubjects.getEventsBySessions, (ctx) => {
    const { sessionIds, types, limitPerSession = 50 } = ctx.payload;

    if (sessionIds.length === 0 || types.length === 0) {
      ctx.setResult({ eventsBySession: {} });
      return;
    }

    const typeSet = new Set(types);
    const result: Record<string, MakaioSessionEvent[]> = {};

    for (const sessionId of sessionIds) {
      const allEvents = eventsBySession.get(sessionId) ?? [];
      const filtered = allEvents
        .filter((e) => typeSet.has(e.type))
        .reverse() // most recent first
        .slice(0, limitPerSession);
      if (filtered.length > 0) {
        result[sessionId] = filtered;
      }
    }

    ctx.setResult({ eventsBySession: result });
  });
}

/**
 * Register in-memory session event storage handlers.
 *
 * Suitable for development, testing, and single-instance deployments.
 * Data is lost when the process exits.
 *
 * Events are stored per-session in insertion order. Cursor-based pagination
 * uses a stable, monotonically-increasing sequence ID (`seqIdByEventId`)
 * assigned at append time — semantically equivalent to the Drizzle handler's
 * auto-increment `id` column. Cursors survive concurrent appends and remain
 * meaningful after deletes: an `after` cursor simply skips all events whose
 * seqId is ≤ the cursor value, regardless of whether the referenced event
 * still exists.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerMemorySessionEventStorage } from '@makaio/services-core/session';
 *
 * const cleanup = registerMemorySessionEventStorage(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerMemorySessionEventStorage(bus: IMakaioBus): () => void {
  // Primary store: events by sessionId
  const eventsBySession = new Map<string, Array<MakaioSessionEvent>>();
  // Secondary index: eventId → stable sequence ID (assigned at append time, never recomputed)
  const seqIdByEventId = new Map<string, number>();
  // Monotonically-increasing counter; starts at 1 so cursor=0 is unambiguously "no cursor"
  let nextSeqIdValue = 1;
  const nextSeqId = (): number => nextSeqIdValue++;

  const unsubs: Array<() => void> = [
    registerAppendHandler(bus, eventsBySession, seqIdByEventId, nextSeqId),
    registerGetEventsHandler(bus, eventsBySession, seqIdByEventId),
    registerGetByIdsHandler(bus, eventsBySession),
    registerDeleteBySessionHandler(bus, eventsBySession, seqIdByEventId),
    registerGetEventsBySessionsHandler(bus, eventsBySession),
  ];

  return () => unsubs.forEach((fn) => fn());
}
