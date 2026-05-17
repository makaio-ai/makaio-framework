import { MakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects, CLAUDE_CODE_HOOK_SESSION_START } from '@makaio/client-claude-code/runtime';
import type { RawClientHookPayload } from '@makaio/clients-core';

/**
 * Subscribe before spawning so an immediate SessionStart hook cannot be lost
 * in the gap between process creation and full `TmuxSession` subscription.
 * @param expectedSessionId - Claude Code session ID passed to the spawned process.
 * @param onStart - Callback invoked with the observed Claude session ID.
 * @returns Unsubscribe function for the early listener.
 */
export function subscribeToEarlySessionStart(
  expectedSessionId: string,
  onStart: (sessionId: string) => void,
): () => void {
  return MakaioBus.on(
    ClaudeCodeClientSubjects.hook.received,
    async (ctx: { payload: RawClientHookPayload }) => {
      const { eventName, payload } = ctx.payload;
      const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;
      if (eventName === CLAUDE_CODE_HOOK_SESSION_START && sessionId === expectedSessionId) {
        onStart(sessionId);
      }
    },
    { filter: { 'payload.session_id': expectedSessionId } },
  );
}
