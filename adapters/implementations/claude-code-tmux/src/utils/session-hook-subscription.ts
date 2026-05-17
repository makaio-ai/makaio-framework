import type { TmuxSession } from '../session.js';
import type { TmuxConnectorSession } from '../connector-session.js';

/**
 * Subscribe a tmux session's raw Claude hooks to the connector turn session.
 * @param tmuxSession - Active tmux session wrapper.
 * @param getConnectorSession - Returns the turn session once initialization completes.
 * @returns Unsubscribe function for the hook listener.
 */
export function subscribeConnectorHooks(
  tmuxSession: TmuxSession,
  getConnectorSession: () => TmuxConnectorSession | undefined,
): () => void {
  return tmuxSession.subscribeToHooks({
    onSessionStart: () => {
      // Session ID was set upfront via --session-id; this confirms Claude Code is live.
    },
    onUserPromptSubmit: async () => {
      await getConnectorSession()?.handleUserPromptSubmit();
    },
    onPreToolUse: async (_sessionId, toolName, toolUseId, toolInput) => {
      await getConnectorSession()?.handlePreToolUse(toolName, toolUseId, toolInput);
    },
    onPostToolUse: async (_sessionId, toolName, toolUseId, toolResult, isError) => {
      await getConnectorSession()?.handlePostToolUse(toolName, toolUseId, toolResult, isError);
    },
    onStop: async (_sessionId, lastAssistantMessage) => {
      await getConnectorSession()?.handleTurnFinished(lastAssistantMessage);
    },
  });
}
