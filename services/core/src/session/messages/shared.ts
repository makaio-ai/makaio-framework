import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { SessionEventStorageSubjects } from '../session-events/index.js';
import { MessageStorageSubjects } from './namespace.js';

/**
 * Emit the fire-and-forget `storage:message.stored` event and the session event
 * RPC that links the message to the session_events table.
 *
 * The `stored` event is emitted first as a fire-and-forget so subscribers (e.g.
 * the virtualized chat pagination store) can react immediately after persistence.
 * The session event RPC is then executed; errors are caught and logged so that
 * session event emission failure does not fail message storage.
 * @param bus - The bus instance to emit on
 * @param message - The fully persisted session message
 */
export async function emitMessageSessionEvent(
  bus: Pick<IMakaioBus, 'emit' | 'request'>,
  message: SessionMessage,
): Promise<void> {
  bus.emit(MessageStorageSubjects.stored, { message: structuredClone(message) });

  try {
    await bus.request(SessionEventStorageSubjects.append, {
      event: {
        sessionId: message.sessionId,
        eventId: crypto.randomUUID(),
        timestamp: message.timestamp,
        type: 'message' as const,
        payload: {
          messageId: message.messageId,
          turnId: message.turnId,
          role: message.role,
        },
      },
    });
  } catch (error) {
    console.error('[MessageStorage] Failed to emit session event for message:', error);
  }
}
