/**
 * Compress lineage resolver for post-compaction subagent re-parenting.
 *
 * When a compress child session import completes (session.import.completed with
 * branchKind === 'compress'), Claude Code's post-compaction subagents have
 * already been parented to the parent Makaio session by the parent-resolver.
 * However, their spawning Agent tool_call lives in the compress child's
 * messages — not in the parent's messages — because it was issued after
 * compaction.
 *
 * This resolver corrects the lineage by:
 * 1. Finding all subagent children of the PARENT Makaio session.
 * 2. Scanning the compress child's messages for Agent/spawn_subagent tool_calls.
 * 3. Matching subagents to tool_calls via tool_output content reference.
 * 4. Re-parenting matched subagents from parent → compress child and
 *    backfilling spawningToolCallId in the same pass.
 *
 * Must be registered BEFORE registerSpawningToolCallResolver so it runs
 * first on `session.import.completed` (bus handlers fire in registration order).
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
 * Precompile reusable standalone-token matchers for child adapter session IDs.
 * @param childAdapterSessionIds - Child adapter session IDs to scan for
 * @returns Child adapter session IDs paired with regex matchers
 */
function compileChildSessionPatterns(childAdapterSessionIds: ReadonlySet<string>): ChildSessionPattern[] {
  return [...childAdapterSessionIds].map((adapterSessionId) => {
    // Safe: escapeRegExp neutralizes regex metacharacters and the delimiter is a flat character class.
    const escapedSessionId = escapeRegExp(adapterSessionId);
    return {
      id: adapterSessionId,
      pattern: new RegExp(`(^|${SESSION_ID_DELIMITER})${escapedSessionId}($|${SESSION_ID_DELIMITER})`),
    };
  });
}

/**
 * Attempt to re-parent a subagent to a compress child of the given parent session.
 *
 * Scans all compress children of `parentMakaioSessionId` for an Agent tool_call
 * whose tool_output references `subagentSessionId`. When a unique match is found,
 * the subagent is re-parented from the parent to the compress child and its
 * `spawningToolCallId` is backfilled.
 * @param bus - The bus instance for storage requests
 * @param subagentSessionId - Makaio session ID of the newly linked subagent
 * @param parentMakaioSessionId - Makaio session ID of the parent session
 */
async function tryReparentSubagentToCompressChild(
  bus: IMakaioBus,
  subagentSessionId: string,
  parentMakaioSessionId: string,
): Promise<void> {
  // Find all compress children of the parent session
  const { children: parentChildren } = await bus.request(SessionStorageSubjects.getChildren, {
    sessionId: parentMakaioSessionId,
  });

  const compressChildren = parentChildren.filter((child) => child.branchKind === 'compress');
  if (compressChildren.length === 0) return;

  const { session: subagentSession } = await bus.request(SessionStorageSubjects.get, { sessionId: subagentSessionId });
  const subagentAdapterSessionId = subagentSession?.adapterSessionId;
  if (!subagentAdapterSessionId) return;

  const subagentPattern = compileChildSessionPatterns(new Set([subagentAdapterSessionId]));

  const matchResults = await Promise.all(
    compressChildren.map(async (compressChild): Promise<{ parentSessionId: string; toolCallId: string } | null> => {
      const messages = await fetchAllMessages(bus, compressChild.sessionId);
      const agentToolCalls = collectAgentToolCalls(messages);
      if (agentToolCalls.length === 0) return null;

      const toolOutputIndex = buildToolOutputIndex(messages, subagentPattern);
      if (toolOutputIndex.size === 0) return null;

      // Enforce 1:1 assignment: exactly one tool call must reference this subagent.
      // buildToolOutputIndex already deduplicates by toolCallId, so the entries
      // here are distinct tool call → subagent mappings. We additionally reject
      // any case where multiple tool calls all map to the same subagent.
      const matchingEntries = [...toolOutputIndex.entries()].filter(([, sid]) => sid === subagentAdapterSessionId);

      if (matchingEntries.length !== 1) return null;

      const [toolCallId] = matchingEntries[0];

      // Verify this tool call is an actual Agent invocation
      const isAgentCall = agentToolCalls.some((tc) => tc.toolCallId === toolCallId);
      if (!isAgentCall) return null;

      return { parentSessionId: compressChild.sessionId, toolCallId };
    }),
  );

  const matches = matchResults.filter(
    (result): result is { parentSessionId: string; toolCallId: string } => result !== null,
  );

  if (matches.length !== 1) return;

  await bus.request(SessionStorageSubjects.update, {
    sessionId: subagentSessionId,
    parentSessionId: matches[0].parentSessionId,
    spawningToolCallId: matches[0].toolCallId,
  });
}

/**
 * Re-parent existing subagent children from a parent session to a newly linked compress child.
 * @param bus - The bus instance for storage requests
 * @param compressChild - The compress child session (already fetched by caller)
 * @param importSource - Source identity from the import completion event
 */
async function tryReparentParentSubagentsToCompressChild(
  bus: IMakaioBus,
  compressChild: { sessionId: string; parentExternalSessionId?: string; source?: string },
  importSource?: string,
): Promise<void> {
  const parentExternalSessionId = compressChild.parentExternalSessionId;
  const source = compressChild.source ?? importSource;
  if (!parentExternalSessionId || !source) return;

  const compressChildSessionId = compressChild.sessionId;

  const { session: parentSession } = await bus.request(SessionStorageSubjects.getByAdapterSessionId, {
    adapterSessionId: parentExternalSessionId,
    source,
  });
  const parentMakaioSessionId = parentSession?.sessionId;
  if (!parentMakaioSessionId) return;

  const { children } = await bus.request(SessionStorageSubjects.getChildren, {
    sessionId: parentMakaioSessionId,
  });

  const subagentAdapterToSessionId = await buildSubagentAdapterToSessionIdMap(bus, children);
  if (subagentAdapterToSessionId.size === 0) return;

  const messages = await fetchAllMessages(bus, compressChildSessionId);
  const agentToolCalls = collectAgentToolCalls(messages);
  if (agentToolCalls.length === 0) return;

  const toolOutputIndex = buildToolOutputIndex(
    messages,
    compileChildSessionPatterns(new Set(subagentAdapterToSessionId.keys())),
  );
  const childCounts = new Map<string, number>();

  for (const toolCall of agentToolCalls) {
    const childAdapterSessionId = toolOutputIndex.get(toolCall.toolCallId);
    if (childAdapterSessionId !== undefined) {
      childCounts.set(childAdapterSessionId, (childCounts.get(childAdapterSessionId) ?? 0) + 1);
    }
  }

  const assignments = new Map<string, string>();
  for (const toolCall of agentToolCalls) {
    const childAdapterSessionId = toolOutputIndex.get(toolCall.toolCallId);
    const childSessionId =
      childAdapterSessionId !== undefined ? subagentAdapterToSessionId.get(childAdapterSessionId) : undefined;
    if (
      childSessionId !== undefined &&
      childAdapterSessionId !== undefined &&
      childCounts.get(childAdapterSessionId) === 1
    ) {
      assignments.set(childSessionId, toolCall.toolCallId);
    }
  }
  if (assignments.size === 0) return;

  const updates = [...assignments].map(async ([childSessionId, toolCallId]) => {
    try {
      await bus.request(SessionStorageSubjects.update, {
        sessionId: childSessionId,
        parentSessionId: compressChildSessionId,
        spawningToolCallId: toolCallId,
      });
    } catch (error) {
      console.error('[CompressLineageResolver] Failed to re-parent subagent', {
        compressChildSessionId,
        parentMakaioSessionId,
        childSessionId,
        toolCallId,
        error,
      });
    }
  });

  await Promise.allSettled(updates);
}

/**
 * Resolve adapter session IDs for existing subagent children.
 * @param bus - The bus instance for storage requests
 * @param children - Child sessions of the parent Makaio session
 * @returns Map from subagent adapterSessionId to Makaio sessionId
 */
async function buildSubagentAdapterToSessionIdMap(
  bus: IMakaioBus,
  children: Array<{ sessionId: string; branchKind?: string | null }>,
): Promise<Map<string, string>> {
  const subagentChildren = await Promise.all(
    children
      .filter((child) => child.branchKind === 'subagent')
      .map(async (child) => {
        const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: child.sessionId });
        return session?.adapterSessionId
          ? { sessionId: child.sessionId, adapterSessionId: session.adapterSessionId }
          : null;
      }),
  );

  return buildUnambiguousAdapterSessionIdMap(subagentChildren);
}

/**
 * Re-parents post-compaction subagents from the parent session to the compress child.
 *
 * Handles two scenarios triggered by `session.import.completed`:
 *
 * **Path A — compress child imported first (batch import)**:
 * When a compress child import completes, subagents spawned after compaction are
 * already parented to the parent Makaio session (by the parent-resolver).
 * This path scans the compress child's messages and re-parents matching subagents.
 *
 * **Path B — subagent imported after compress child (incremental / separate files)**:
 * When a subagent import completes and its parent has compress children, the compress
 * children and their messages already exist. This path scans those compress
 * children for the subagent's spawning tool_call and re-parents when found.
 *
 * Must be registered BEFORE registerSpawningToolCallResolver so it runs
 * first on `session.import.completed` (bus handlers fire in registration order).
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe the handler
 * @example
 * ```typescript
 * import { registerCompressLineageResolver } from '@makaio/services-core/session';
 *
 * const cleanup = registerCompressLineageResolver(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerCompressLineageResolver(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.import.completed, async (ctx) => {
    try {
      const { sessionId: linkedSessionId, source } = ctx.payload;

      const { session: linkedMakaioSession } = await bus.request(SessionStorageSubjects.get, {
        sessionId: linkedSessionId,
      });
      if (!linkedMakaioSession) return;

      // --- Path B: subagent linked → check compress children of its parent ---
      if (linkedMakaioSession.branchKind === 'subagent' && linkedMakaioSession.parentSessionId !== undefined) {
        await tryReparentSubagentToCompressChild(bus, linkedSessionId, linkedMakaioSession.parentSessionId);
        return;
      }

      // --- Path A: compress child linked → re-parent existing subagents of parent ---
      if (linkedMakaioSession.branchKind !== 'compress') return;
      await tryReparentParentSubagentsToCompressChild(bus, linkedMakaioSession, source);
    } catch (error) {
      console.error('[CompressLineageResolver] Failed to resolve compress lineage', {
        payload: ctx.payload,
        error,
      });
    }
  });
}
