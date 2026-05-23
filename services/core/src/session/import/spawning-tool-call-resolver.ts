/**
 * Spawning tool call resolver for out-of-order session imports.
 *
 * When a parent session import completes (session.import.completed),
 * this handler finds subagent children that are missing their `spawningToolCallId`
 * and backfills it by scanning the parent's messages for Agent/spawn_subagent
 * tool_call blocks.
 *
 * Matching strategy:
 * 1. Check if any `tool_output` block's content references the child adapter session ID.
 * 2. Leave unmatched children unresolved. Legacy sessions then degrade to the
 *    UI's message-level fallback instead of persisting guessed correlations.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import {
  type ChildSessionPattern,
  SESSION_ID_DELIMITER,
  buildUnambiguousAdapterSessionIdMap,
  buildToolOutputIndex,
  collectAgentToolCalls,
  escapeRegExp,
  fetchAllMessages,
} from './tool-call-scan-utils.js';

/**
 * Precompile reusable standalone-token matchers for child session IDs.
 * @param childSessionIds - Child adapter session IDs to scan for
 * @returns Child adapter session IDs paired with regex matchers
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
 * Resolve unmatched subagent children to their adapter session IDs.
 * @param bus - Bus instance for storage requests
 * @param source - Import source that owns the parent completion event
 * @param children - Direct child sessions from `getChildren`
 * @returns Map from adapter session ID to Makaio session ID
 */
async function buildSubagentAdapterToSessionIdMap(
  bus: IMakaioBus,
  source: string,
  children: Array<{ sessionId: string; branchKind?: string | null; spawningToolCallId?: string }>,
): Promise<Map<string, string>> {
  const subagentChildren = await Promise.all(
    children
      .filter((child) => child.branchKind === 'subagent' && child.spawningToolCallId === undefined)
      .map(async (child) => {
        const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: child.sessionId });
        const sessionSource = session?.source ?? session?.adapterName;
        return session?.adapterSessionId && sessionSource === source
          ? { sessionId: child.sessionId, adapterSessionId: session.adapterSessionId }
          : null;
      }),
  );

  return buildUnambiguousAdapterSessionIdMap(subagentChildren);
}

/**
 * Register handler to backfill `spawningToolCallId` for imported subagent sessions.
 *
 * When `session.import.completed` is emitted:
 * 1. Fetch children of the newly imported parent session.
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
  return bus.on(SessionSubjects.import.completed, async (ctx) => {
    try {
      const { sessionId: parentSessionId, source } = ctx.payload;

      // Get direct children and filter to unmatched subagents.
      const { children } = await bus.request(SessionStorageSubjects.getChildren, { sessionId: parentSessionId });

      const childAdapterToSessionId = await buildSubagentAdapterToSessionIdMap(bus, source, children);
      const unmatchedChildIds = new Set(childAdapterToSessionId.keys());

      if (unmatchedChildIds.size === 0) return;

      // Fetch all parent messages to scan for tool calls.
      const messages = await fetchAllMessages(bus, parentSessionId);
      const agentToolCalls = collectAgentToolCalls(messages);

      if (agentToolCalls.length === 0) return;

      const toolOutputIndex = buildToolOutputIndex(messages, compileChildSessionPatterns(unmatchedChildIds));
      const childCounts = new Map<string, number>();

      for (const toolCall of agentToolCalls) {
        const childAdapterSessionId = toolOutputIndex.get(toolCall.toolCallId);
        if (childAdapterSessionId !== undefined) {
          childCounts.set(childAdapterSessionId, (childCounts.get(childAdapterSessionId) ?? 0) + 1);
        }
      }

      const assignments = new Map<string, string>(); // childSessionId → toolCallId

      for (const toolCall of agentToolCalls) {
        const childAdapterSessionId = toolOutputIndex.get(toolCall.toolCallId);
        const childSessionId =
          childAdapterSessionId !== undefined ? childAdapterToSessionId.get(childAdapterSessionId) : undefined;
        if (
          childSessionId !== undefined &&
          childAdapterSessionId !== undefined &&
          childCounts.get(childAdapterSessionId) === 1
        ) {
          assignments.set(childSessionId, toolCall.toolCallId);
        }
      }

      const updates = [...assignments].map(async ([childSessionId, toolCallId]) => {
        try {
          const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: childSessionId });
          if (session?.spawningToolCallId !== undefined) {
            return;
          }

          // storage:session.update treats non-null spawningToolCallId as
          // write-once provenance, so a concurrent assignment that lands after
          // this snapshot still wins atomically at the storage boundary.
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
      console.error('Failed to backfill spawningToolCallId for imported session', {
        payload: ctx.payload,
        error,
      });
    }
  });
}
