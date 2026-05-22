import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import type { BuildContextOptions, ContextAssemblyResult } from './types.js';

/**
 * Maximum events to fetch per request.
 */
const MAX_EVENTS_PER_SESSION = 10000;

/**
 * Build context for a single session by walking session_events.
 *
 * Respects squash boundaries: if a squash event is encountered,
 * messages before it are replaced with the summary.
 * Paginates through all events until no more cursors or message limit is reached.
 * @param bus - Bus instance for RPC calls
 * @param options - Build context options
 * @returns Assembled context result
 */
export async function buildSessionContext(
  bus: IMakaioBus,
  options: BuildContextOptions,
): Promise<ContextAssemblyResult> {
  const { sessionId, limit } = options;
  const messages: SessionMessage[] = [];
  let hasSquashBoundary = false;
  let truncated = false;

  // Paginate through all events for this session
  let cursor: string | undefined;
  do {
    const { events, nextCursor } = await bus.request(SessionEventStorageSubjects.getEvents, {
      sessionId,
      options: { limit: MAX_EVENTS_PER_SESSION, ...(cursor && { after: cursor }) },
    });

    // Process events in order
    for (const event of events) {
      if (event.type === 'squash') {
        // Squash boundary: clear messages and inject summary
        hasSquashBoundary = true;
        messages.length = 0;

        const payload = event.payload as { summaryJson: string };
        const summaryMessage: SessionMessage = {
          messageId: `squash-${event.eventId}`,
          sessionId,
          turnId: null,
          role: 'assistant',
          contentText: payload.summaryJson,
          blocks: [{ type: 'text', content: payload.summaryJson }],
          timestamp: event.timestamp,
        };
        messages.push(summaryMessage);
      } else if (event.type === 'message') {
        // Fetch the actual message content
        const payload = event.payload as { messageId: string };
        const { message } = await bus.request(MessageStorageSubjects.get, {
          messageId: payload.messageId,
        });

        if (message) {
          messages.push(message);
        }
      }
      // Skip other event types (turn.started, turn.completed, branch.*, etc.)

      // Check limit
      if (limit && messages.length >= limit) {
        truncated = true;
        break;
      }
    }

    // If we hit the message limit, stop pagination
    if (limit && messages.length >= limit) {
      break;
    }

    cursor = nextCursor ?? undefined;
  } while (cursor);

  return {
    messages,
    hasSquashBoundary,
    sessionChain: [sessionId],
    truncated,
    incomplete: false, // Single session, no parent chain to break
  };
}
