/**
 * Shared scanning utilities for Agent/spawn_subagent tool call resolution.
 *
 * Package-internal — do not re-export from any index.ts.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects, type MessagePageCursor } from '../messages/namespace.js';

/** Tool names that represent subagent spawn invocations. */
export const AGENT_TOOL_NAMES = new Set(['Agent', 'spawn_subagent']);

/** Regex character class matching any non-identifier character used as a word boundary. */
export const SESSION_ID_DELIMITER = '[^A-Za-z0-9_-]';

/** Maximum number of pagination pages fetched before aborting with an error. */
export const MAX_FETCH_PAGES = 1000;

/** A tool_call block representing an Agent/spawn_subagent invocation. */
export interface AgentToolCall {
  /** Stable tool call ID used to correlate with tool_output and child session. */
  toolCallId: string;
}

/**
 * A child session paired with a precompiled standalone-token matcher.
 *
 * The `id` field holds whichever identifier is meaningful in the calling context
 * (adapter session ID or Makaio session ID). Callers set it when building the
 * pattern list; `buildToolOutputIndex` returns it unchanged as the map value.
 */
export interface ChildSessionPattern {
  /** The session identifier to match and return from the output index. */
  id: string;
  /** Reusable standalone-token matcher for tool output scans. */
  pattern: RegExp;
}

/** Child session resolved to an external adapter session ID. */
export interface ChildAdapterSession {
  /** Makaio session ID for the child row. */
  sessionId: string;
  /** External adapter session ID stored on the child row. */
  adapterSessionId: string;
}

/**
 * Escape special regex characters in a literal string.
 * @param value - Unescaped string
 * @returns Regex-safe string
 */
export function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a tool output references a session ID as a standalone token.
 * @param output - Tool output text to scan
 * @param pattern - Precompiled session ID matcher
 * @returns True when the exact session ID is present with safe delimiters
 */
export function outputReferencesSessionId(output: string, pattern: RegExp): boolean {
  return pattern.test(output);
}

/**
 * Collect all pages of messages for a session via bus requests.
 *
 * Follows `nextCursor` until exhausted. Callers should only invoke this
 * for sessions where message volume is bounded (e.g., imported sessions).
 * @param bus - The bus instance to issue requests on
 * @param sessionId - Session whose messages to fetch
 * @returns Full ordered list of messages (oldest first)
 */
export async function fetchAllMessages(bus: IMakaioBus, sessionId: string): Promise<SessionMessage[]> {
  const collected: SessionMessage[] = [];
  let cursor: MessagePageCursor | undefined;
  let pageCount = 0;

  do {
    const response = await bus.request(MessageStorageSubjects.getBySession, {
      sessionId,
      order: 'asc',
      ...(cursor !== undefined ? { after: cursor } : {}),
    });
    collected.push(...response.messages);
    cursor = response.nextCursor ?? undefined;
    pageCount += 1;
    if (cursor !== undefined && pageCount >= MAX_FETCH_PAGES) {
      throw new Error(`Exceeded ${MAX_FETCH_PAGES} message pages while loading session ${sessionId}`);
    }
  } while (cursor !== undefined);

  return collected;
}

/**
 * Scan messages for Agent/spawn_subagent tool_call blocks.
 *
 * Returns them in encounter order (message order, then block order within message).
 * @param messages - Ordered message list to scan
 * @returns Ordered list of Agent tool calls
 */
export function collectAgentToolCalls(messages: SessionMessage[]): AgentToolCall[] {
  const result: AgentToolCall[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_call' && AGENT_TOOL_NAMES.has(block.name)) {
        result.push({ toolCallId: block.toolCallId });
      }
    }
  }
  return result;
}

/**
 * Build a map from toolCallId → child session id by scanning tool_output blocks.
 *
 * A tool_output block whose `output` string contains a child session ID is
 * considered a direct reference: `toolCallId → childPattern.id`.
 * @param messages - Ordered message list to scan
 * @param childPatterns - Precompiled child session matchers to look for in outputs
 * @returns Map from toolCallId to matched child `id`
 */
export function buildToolOutputIndex(
  messages: SessionMessage[],
  childPatterns: readonly ChildSessionPattern[],
): Map<string, string> {
  const matchesByToolCallId = new Map<string, Set<string>>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_output') {
        for (const childPattern of childPatterns) {
          if (outputReferencesSessionId(block.output, childPattern.pattern)) {
            const existing = matchesByToolCallId.get(block.toolCallId) ?? new Set<string>();
            existing.add(childPattern.id);
            matchesByToolCallId.set(block.toolCallId, existing);
          }
        }
      }
    }
  }

  const index = new Map<string, string>();
  for (const [toolCallId, matchedIds] of matchesByToolCallId) {
    // Only include unambiguous 1:1 mappings; multi-match tool calls are left unresolved.
    if (matchedIds.size === 1) {
      const [id] = matchedIds;
      index.set(toolCallId, id);
    }
  }

  return index;
}

/**
 * Build a child lookup that excludes ambiguous external adapter IDs.
 *
 * Imported sessions are identified by `(source, adapterSessionId)`, but tool
 * output text only gives us the bare adapter session ID. When two candidate
 * children share that bare ID, there is no sound 1:1 correlation to persist.
 * @param children - Child rows paired with adapter session IDs
 * @returns Map from unambiguous adapter session ID to Makaio session ID
 */
export function buildUnambiguousAdapterSessionIdMap(
  children: readonly (ChildAdapterSession | null)[],
): Map<string, string> {
  const adapterToSessionId = new Map<string, string>();
  const ambiguousAdapterSessionIds = new Set<string>();

  for (const child of children) {
    if (child === null || ambiguousAdapterSessionIds.has(child.adapterSessionId)) continue;

    if (adapterToSessionId.has(child.adapterSessionId)) {
      adapterToSessionId.delete(child.adapterSessionId);
      ambiguousAdapterSessionIds.add(child.adapterSessionId);
      continue;
    }

    adapterToSessionId.set(child.adapterSessionId, child.sessionId);
  }

  return adapterToSessionId;
}
