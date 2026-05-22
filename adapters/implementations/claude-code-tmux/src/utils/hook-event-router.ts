/**
 * Stateless dispatcher for raw Claude Code hook events.
 *
 * Filters on `session_id` and routes to typed callbacks. Subscribes to raw
 * `client:claude-code.hook.received` events — NOT the normalized
 * `client.session.*` layer, because the normalizer drops fields we need
 * (`last_assistant_message`, `tool_input`, `tool_result`).
 * @packageDocumentation
 */

import type { RawClientHookPayload } from '@makaio/subsystem-client';
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
  onPostToolUse(
    sessionId: string,
    toolName: string,
    toolUseId: string,
    toolResult: unknown,
    isError: boolean | undefined,
  ): HookCallbackResult;
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
          pickString(payload, 'tool_name'),
          pickString(payload, 'tool_use_id'),
          payload['tool_input'],
        );
        break;

      case CLAUDE_CODE_HOOK_POST_TOOL_USE: {
        await callbacks.onPostToolUse(
          sessionId,
          pickString(payload, 'tool_name'),
          pickString(payload, 'tool_use_id'),
          pickPostToolUseResult(payload),
          resolvePostToolUseIsError(payload),
        );
        break;
      }

      case CLAUDE_CODE_HOOK_STOP:
        await callbacks.onStop(
          sessionId,
          typeof payload['last_assistant_message'] === 'string' ? payload['last_assistant_message'] : '',
        );
        break;
    }
  };
}

/**
 * Pick a string field from a raw hook payload.
 * @param payload - Raw Claude Code hook payload.
 * @param key - Payload field name.
 * @returns The string value, or an empty string when absent.
 */
function pickString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Pick the result payload for a PostToolUse hook.
 * @param payload - Raw Claude Code hook payload.
 * @returns The explicit `tool_result` value, including `null`, or `tool_error`
 *   when Claude Code omitted `tool_result`.
 */
function pickPostToolUseResult(payload: Record<string, unknown>): unknown {
  return Object.hasOwn(payload, 'tool_result') ? payload['tool_result'] : payload['tool_error'];
}

/**
 * Resolve PostToolUse failure status from Claude Code hook fields.
 * @param payload - Raw PostToolUse hook payload.
 * @returns Failure status when Claude Code provided enough evidence.
 */
function resolvePostToolUseIsError(payload: Record<string, unknown>): boolean | undefined {
  const exitCode = payload['exit_code'];
  if (typeof exitCode === 'number') {
    return exitCode !== 0;
  }
  return payload['tool_error'] === undefined ? undefined : true;
}
