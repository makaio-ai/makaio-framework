import { z } from 'zod';
import type { ToolCallContent, ToolCallLocation, ToolKind, ToolCallStatus } from './_acp-types.js';

/**
 * Tool execution event schemas for Gemini ACP.
 * Represents tool call lifecycle (started, updated/completed).
 * Matches upstream sessionUpdateSchema structure exactly.
 *
 * Note: gemini-cli bundles Zod v3, we use v4. Using z.custom<T>() for type safety
 * without runtime validation (similar to GitHub Copilot adapter pattern).
 */

export type ToolCallEvent = {
  sessionUpdate: 'tool_call';
  kind: ToolKind;
  title: string;
  toolCallId: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
};

export type ToolCallUpdateEvent = {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  kind?: ToolKind | null;
  title?: string | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
};

export const ToolCallEventSchema = z.custom<ToolCallEvent>(() => true);
export const ToolCallUpdateEventSchema = z.custom<ToolCallUpdateEvent>(() => true);
