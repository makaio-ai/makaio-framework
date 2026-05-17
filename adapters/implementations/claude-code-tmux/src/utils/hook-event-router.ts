/**
 * Stateless dispatcher for raw Claude Code hook events.
 *
 * Filters on `session_id` and routes to typed callbacks. Subscribes to raw
 * `client:claude-code.hook.received` events — NOT the normalized
 * `client.session.*` layer, because the normalizer drops fields we need
 * (`last_assistant_message`, `tool_input`, `tool_result`).
 * @packageDocumentation
 */

import type { RawClientHookPayload } from '@makaio/clients-core';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
} from '@makaio/client-claude-code/runtime';

type HookCallbackResult = Promise<void> | void;

/**
 * Typed callback set for hook event dispatch.
 *
 * Each callback receives the strongly-typed fields extracted from the raw
 * hook payload. The `sessionId` parameter is the Claude Code-internal
 * session identifier (not the Makaio adapter session ID).
 */
export interface HookEventCallbacks {
  /** Claude Code session has started. */
  onSessionStart(sessionId: string, model: string): HookCallbackResult;
  /** User submitted a prompt (after send-keys). */
  onUserPromptSubmit(sessionId: string): HookCallbackResult;
  /** Claude is about to use a tool. */
  onPreToolUse(sessionId: string, toolName: string, toolUseId: string, toolInput: unknown): HookCallbackResult;
  /** Claude has finished using a tool. */
  onPostToolUse(sessionId: string, toolName: string, toolUseId: string, toolResult: unknown): HookCallbackResult;
  /** Claude has stopped — turn is complete. */
  onStop(sessionId: string, lastAssistantMessage: string): HookCallbackResult;
}

/**
 * Creates a dispatcher that routes raw hook payloads to typed callbacks.
 *
 * Returns a function suitable for use as a bus subscription handler on
 * `client:claude-code.hook.received`. Events from other session IDs are
 * silently ignored. Unknown event names are silently ignored.
 *
 * The `getExpectedSessionId` getter is called on each event. When it returns
 * a value, all hook events including SessionStart must match that Claude Code
 * session ID; when it returns `undefined`, the router accepts any session.
 * @param getExpectedSessionId - Returns the Claude Code session ID to filter on, or `undefined` to accept all
 * @param callbacks - Typed event handlers
 * @returns Handler function for raw hook payloads
 */
export function createHookEventRouter(
  getExpectedSessionId: () => string | undefined,
  callbacks: HookEventCallbacks,
): (raw: RawClientHookPayload) => Promise<void> {
  return async (raw) => {
    const { eventName, payload } = raw;
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;

    if (eventName === CLAUDE_CODE_HOOK_SESSION_START) {
      const expectedSessionId = getExpectedSessionId();
      if (sessionId && (expectedSessionId === undefined || sessionId === expectedSessionId)) {
        const model = typeof payload['model'] === 'string' ? payload['model'] : '';
        await callbacks.onSessionStart(sessionId, model);
      }
      return;
    }

    const expectedSessionId = getExpectedSessionId();
    if (!sessionId || (expectedSessionId !== undefined && sessionId !== expectedSessionId)) {
      return;
    }

    switch (eventName) {
      case CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT:
        await callbacks.onUserPromptSubmit(sessionId);
        break;

      case CLAUDE_CODE_HOOK_PRE_TOOL_USE:
        await callbacks.onPreToolUse(
          sessionId,
          typeof payload['tool_name'] === 'string' ? payload['tool_name'] : '',
          typeof payload['tool_use_id'] === 'string' ? payload['tool_use_id'] : '',
          payload['tool_input'],
        );
        break;

      case CLAUDE_CODE_HOOK_POST_TOOL_USE:
        await callbacks.onPostToolUse(
          sessionId,
          typeof payload['tool_name'] === 'string' ? payload['tool_name'] : '',
          typeof payload['tool_use_id'] === 'string' ? payload['tool_use_id'] : '',
          payload['tool_result'],
        );
        break;

      case CLAUDE_CODE_HOOK_STOP:
        await callbacks.onStop(
          sessionId,
          typeof payload['last_assistant_message'] === 'string' ? payload['last_assistant_message'] : '',
        );
        break;
    }
  };
}
