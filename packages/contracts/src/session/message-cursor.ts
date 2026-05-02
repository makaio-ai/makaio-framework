import type { SessionMessage } from './schemas/message.js';
import type { MessagePageCursor } from './message-storage-namespace.js';

/**
 * Compare two message cursors in ascending storage order.
 * @param left - First cursor
 * @param right - Second cursor
 * @returns Negative when left sorts first, positive when right sorts first
 */
export function compareMessageCursorAsc(left: MessagePageCursor, right: MessagePageCursor): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left.messageId.localeCompare(right.messageId);
}

/**
 * Compare two message cursors in descending storage order.
 * @param left - First cursor
 * @param right - Second cursor
 * @returns Negative when left sorts first, positive when right sorts first
 */
export function compareMessageCursorDesc(left: MessagePageCursor, right: MessagePageCursor): number {
  return compareMessageCursorAsc(right, left);
}

/**
 * Convert a persisted message into its pagination cursor.
 * @param message - Message row/entity
 * @returns Deterministic cursor for the message
 */
export function messageToCursor(message: Pick<SessionMessage, 'timestamp' | 'messageId'>): MessagePageCursor {
  return {
    timestamp: message.timestamp,
    messageId: message.messageId,
  };
}

/**
 * Encode a cursor into a stable string key for local Sets and Maps.
 * @param cursor - Cursor to encode
 * @returns Stable key suitable for local comparisons
 */
export function messageCursorKey(cursor: MessagePageCursor): string {
  return `${cursor.timestamp}:${cursor.messageId}`;
}
