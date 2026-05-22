/**
 * Spawning tool call resolver for out-of-order session imports.
 *
 * When a parent session is linked to a Makaio session (adapter.session.linked),
 * this handler finds subagent children that are missing their `spawningToolCallId`
 * and backfills it by scanning the parent's messages for Agent/spawn_subagent
 * tool_call blocks.
 *
 * Matching strategy:
 * 1. Check if any `tool_output` block's content references the child session ID.
 * 2. Leave unmatched children unresolved. Legacy sessions then degrade to the
 *    UI's message-level fallback instead of persisting guessed correlations.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import {
  type ChildSessionPattern,
  SESSION_ID_DELIMITER,
  buildToolOutputIndex,
  collectAgentToolCalls,
  escapeRegExp,
  fetchAllMessages,
} from './tool-call-scan-utils.js';

/**
 * Precompile reusable standalone-token matchers for child session IDs.
 * @param childSessionIds - Child session IDs to scan for
 * @returns Child session IDs paired with regex matchers
 */
function compileChildSessionPatterns(childSessionIds: ReadonlySet<string>): ChildSessionPattern[] {
  return [...childSessionIds].map((sessionId) => {
    const escapedSessionId = escapeRegExp(sessionId);
    return {
      id: sessionId,
      pattern: new RegExp(`(^|${SESSION_ID_DELIMITER})${escapedSessionId}($|${SESSION_ID_DELIMITER})`),
    };
  });
}

/**
 * Register handler to backfill `spawningToolCallId` for imported subagent sessions.
 *
 * When `adapter.session.linked` is emitted:
 * 1. Fetch children of the newly linked parent session.
 * 2. Filter to subagent children with no `spawningToolCallId`.
 * 3. Fetch parent session messages and scan for Agent/spawn_subagent tool_call blocks.
 * 4. Match each unmatched child to a tool_call by tool_output content reference
 *    (session ID in output string). Unmatched children are left as null.
 * 5. Update matched children via `SessionStorageSubjects.update`.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe the handler
 * @example
 * ```typescript
 * import { registerSpawningToolCallResolver } from '@makaio/services-core/session';
 *
 * const cleanup = registerSpawningToolCallResolver(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerSpawningToolCallResolver(bus: IMakaioBus): () => void {
  return bus.on(AdapterSubjects.session.linked, async (ctx) => {
    try {
      const { sessionId: parentSessionId } = ctx.payload;

      // Get direct children and filter to unmatched subagents.
      const { children } = await bus.request(SessionStorageSubjects.getChildren, { sessionId: parentSessionId });

      const unmatchedChildIds = new Set(
        children
          .filter((child) => child.branchKind === 'subagent' && child.spawningToolCallId === undefined)
          .map((child) => child.sessionId),
      );

      if (unmatchedChildIds.size === 0) return;

      // Fetch all parent messages to scan for tool calls.
      const messages = await fetchAllMessages(bus, parentSessionId);
      const agentToolCalls = collectAgentToolCalls(messages);

      if (agentToolCalls.length === 0) return;

      const toolOutputIndex = buildToolOutputIndex(messages, compileChildSessionPatterns(unmatchedChildIds));
      const childCounts = new Map<string, number>();

      for (const toolCall of agentToolCalls) {
        const childSessionId = toolOutputIndex.get(toolCall.toolCallId);
        if (childSessionId !== undefined) {
          childCounts.set(childSessionId, (childCounts.get(childSessionId) ?? 0) + 1);
        }
      }

      const assignments = new Map<string, string>(); // childSessionId → toolCallId

      for (const toolCall of agentToolCalls) {
        const childSessionId = toolOutputIndex.get(toolCall.toolCallId);
        if (childSessionId !== undefined && childCounts.get(childSessionId) === 1) {
          assignments.set(childSessionId, toolCall.toolCallId);
        }
      }

      const updates = [...assignments].map(async ([childSessionId, toolCallId]) => {
        try {
          const { session } = await bus.request(SessionStorageSubjects.get, {
            sessionId: childSessionId,
          });
          if (!session || session.spawningToolCallId !== undefined) {
            return;
          }

          await bus.request(SessionStorageSubjects.update, {
            sessionId: childSessionId,
            spawningToolCallId: toolCallId,
          });
        } catch (error) {
          console.error('Failed to persist spawning tool call correlation', {
            parentSessionId,
            childSessionId,
            toolCallId,
            error,
          });
        }
      });

      await Promise.allSettled(updates);
    } catch (error) {
      console.error('Failed to backfill spawningToolCallId for linked session', {
        payload: ctx.payload,
        error,
      });
    }
  });
}
