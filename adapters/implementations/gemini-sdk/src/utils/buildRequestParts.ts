import type { ToolCallResponseInfo } from '@google/gemini-cli-core';
import { formatContextBlockAsText } from '@makaio/ai-adapters-core';

type GeminiPart = ToolCallResponseInfo['responseParts'][number];

/**
 * Build request parts with optional merged context and non-text media parts.
 * Wraps merged text content in XML tags for consistent context injection.
 * Non-text parts (images, documents) are appended after the text part.
 * @param userMessage - The user's message text
 * @param mergedContent - Optional text content from superseded/merged messages (for immediate mode)
 * @param mergedNonTextParts - Optional non-text parts (images, documents) from superseded/merged messages
 * @returns Array of Part objects ready for Gemini API
 */
export function buildRequestParts(
  userMessage: string,
  mergedContent?: string[],
  mergedNonTextParts?: GeminiPart[],
): GeminiPart[] {
  let finalMessage = userMessage;

  if (mergedContent?.length) {
    finalMessage = `${formatContextBlockAsText('merged_context', mergedContent.join('\n'))}\n\n${finalMessage}`;
  }

  const parts: GeminiPart[] = [{ text: finalMessage }];

  if (mergedNonTextParts?.length) {
    parts.push(...mergedNonTextParts);
  }

  return parts;
}
