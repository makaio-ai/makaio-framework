import type { Message, SessionMessage } from '@makaio/contracts';

/**
 * Convert SessionMessage to Message for sessionContext.
 *
 * Since SessionMessageBlock and MessageBlock are unified, blocks pass through
 * directly — no per-type conversion needed.
 * @param msg - Session message from storage
 * @returns Message suitable for sessionContext.messageHistory
 */
export function convertSessionMessage(msg: SessionMessage): Message {
  return {
    role: msg.role,
    blocks: msg.blocks,
  };
}
