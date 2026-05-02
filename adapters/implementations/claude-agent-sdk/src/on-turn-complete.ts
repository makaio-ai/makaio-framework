import type { MessageHandle, MessageResult } from '@makaio/ai-adapters-core';
import type { OnTurnCompleteCallback } from './types/index.js';

interface NotifyOnTurnCompleteHookArgs {
  onTurnComplete?: OnTurnCompleteCallback;
  handle: MessageHandle;
  result: MessageResult;
  sessionId?: string;
}

/**
 * Run the post-completion hook without delaying handle completion.
 * @param args - Hook callback plus correlation context
 */
export function notifyOnTurnCompleteHook(args: NotifyOnTurnCompleteHookArgs): void {
  const { onTurnComplete, handle, result, sessionId } = args;
  void Promise.resolve()
    .then(() => onTurnComplete?.(handle, result))
    .catch((error: unknown) => {
      console.error('Session: onTurnComplete hook failed:', { sessionId, messageId: handle.messageId, error });
    });
}
