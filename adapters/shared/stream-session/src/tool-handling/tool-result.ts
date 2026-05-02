/**
 * Shared tool result types and content bounding utility.
 *
 * These types and functions are identical across all stream-based adapter
 * implementations and are extracted here to avoid duplication.
 */

/**
 * Tool-specific fields extracted from a normalized tool call.
 *
 * Identity context (agentId, adapterId, etc.) is intentionally excluded —
 * the connector injects those when forwarding to the global bus.
 */
export interface ToolCallPayload {
  /** Name of the tool to call */
  toolName: string;
  /** Parsed arguments for the tool */
  args: Record<string, unknown>;
  /** Unique identifier for this tool call */
  toolCallId: string;
}

export type { ToolExecutionContextOverrides } from '@makaio/contracts';

/**
 * Execution constraints forwarded to ToolRegistry.
 *
 * Keep this as an explicit interface (instead of a generic record) so
 * adapter/session code can safely access known constraint keys and extend
 * the contract over time without call-site casts.
 */
export interface ToolExecutionConstraints {
  /** Extension seam for future constraint keys. */
  [key: string]: unknown;
  /** Optional path allow-list for filesystem tools. */
  allowedDirectories?: string[];
}

export const MAX_TOOL_RESULT_CONTENT_CHARS = 8_000;

/**
 * Bound tool result content before injecting it back into model context.
 *
 * Tool outputs (filesystem, grep, etc.) can be very large and cause
 * context-window overflows in recursive tool-call turns. Keep full payload
 * on emitted events, but cap what is sent back to the model.
 * @param content - Serialized tool result payload
 * @returns Content truncated to context-safe size
 */
export function boundToolResultContent(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CONTENT_CHARS) {
    return content;
  }

  let truncatedLength = MAX_TOOL_RESULT_CONTENT_CHARS;
  let suffix = '';

  // The suffix embeds omitted-char count, so its own length can change once
  // we know how much head content remains. Iterate to a stable split.
  // This reaches a fixed point quickly because only suffix digit-count changes.
  while (true) {
    const omittedChars = content.length - truncatedLength;
    const candidateSuffix = `\n...[truncated ${omittedChars} chars]`;
    const candidateTruncatedLength = MAX_TOOL_RESULT_CONTENT_CHARS - candidateSuffix.length;

    if (candidateTruncatedLength < 0) {
      return candidateSuffix.slice(0, MAX_TOOL_RESULT_CONTENT_CHARS);
    }

    if (candidateTruncatedLength === truncatedLength && candidateSuffix === suffix) {
      break;
    }

    truncatedLength = candidateTruncatedLength;
    suffix = candidateSuffix;
  }

  return `${content.slice(0, truncatedLength)}${suffix}`;
}
