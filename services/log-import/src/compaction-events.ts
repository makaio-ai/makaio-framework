import type { IMakaioBus } from '@makaio/bus-core';
import { SessionEventStorageSubjects } from '@makaio/services-core/session';

/**
 * Payload needed to persist a deterministic `session.compacted` event.
 */
export interface SessionCompactedEventInput {
  sessionId: string;
  eventId: string;
  timestamp: number;
  trigger: 'manual' | 'auto';
  preTokens: number | null;
  summary: string | null;
  compressChildSessionId: string;
}

/**
 * Persist a deterministic `session.compacted` event with race-safe idempotency.
 *
 * This helper owns the existence check for the common case. If a concurrent
 * importer wins the race between that check and the append, we re-check by
 * `eventId` and treat the duplicate as success.
 * @param bus - Bus instance for event storage requests
 * @param event - Fully materialized compaction event payload
 */
export async function appendSessionCompactedEvent(bus: IMakaioBus, event: SessionCompactedEventInput): Promise<void> {
  const { events: existingEvents } = await bus.request(SessionEventStorageSubjects.getByIds, {
    sessionId: event.sessionId,
    eventIds: [event.eventId],
  });
  if (existingEvents.length > 0) return;

  try {
    await bus.request(SessionEventStorageSubjects.append, {
      event: {
        sessionId: event.sessionId,
        eventId: event.eventId,
        timestamp: event.timestamp,
        type: 'session.compacted',
        payload: {
          trigger: event.trigger,
          preTokens: event.preTokens,
          summary: event.summary,
          compressChildSessionId: event.compressChildSessionId,
        },
      },
    });
  } catch (error) {
    const { events: persistedEvents } = await bus.request(SessionEventStorageSubjects.getByIds, {
      sessionId: event.sessionId,
      eventIds: [event.eventId],
    });
    if (persistedEvents.length > 0) return;
    throw error;
  }
}
