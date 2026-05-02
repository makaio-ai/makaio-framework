import type { GeminiChat } from '@google/gemini-cli-core';
// IMPORTANT: Use shared Message type (has .blocks), NOT agent/schemas/message.ts (has .content)
import type { Message, MessageBlock } from '@makaio/contracts/shared';
import { isTextLikeMimeType, normalizeMimeType } from '@makaio/ai-adapters-core';

type GeminiHistory = Parameters<GeminiChat['setHistory']>[0];
type GeminiContent = GeminiHistory[number];
/** Derived Part type from GeminiChat's own type chain to avoid duplicate-dep version conflicts. */
type GeminiPart = NonNullable<GeminiContent['parts']>[number];

/** Accumulated parts split by their destination category. */
interface BlockParts {
  modelParts: GeminiPart[];
  functionResponseParts: GeminiPart[];
  orphanToolOutputs: GeminiPart[];
}

/** Media block types (image/document) that carry a ContentSource. */
type MediaBlock = Extract<MessageBlock, { type: 'image' | 'document' }>;

/** Attachment block type with fileName, filePath and ContentSource. */
type AttachmentBlock = Extract<MessageBlock, { type: 'attachment' }>;

/**
 * Index tool call names from blocks into a shared map.
 * @param blocks - Message blocks to scan
 * @param toolNameByCallId - Mutable index shared across history conversion
 */
function indexToolCallNames(blocks: MessageBlock[], toolNameByCallId: Map<string, string>): void {
  for (const block of blocks) {
    if (block.type === 'tool_call') {
      toolNameByCallId.set(block.toolCallId, block.name);
    }
  }
}

/**
 * Convert an image or document block source to a Gemini Part.
 * @param block - Image or document block
 * @returns Gemini Part with inlineData or fileData, or undefined if source type unsupported
 */
function mediaBlockToPart(block: MediaBlock): GeminiPart | undefined {
  if (block.source.type === 'base64') {
    return { inlineData: { data: block.source.data, mimeType: normalizeMimeType(block.source.mimeType) } };
  }
  if (block.source.type === 'url') {
    return { fileData: { fileUri: block.source.url, mimeType: normalizeMimeType(block.source.mimeType) } };
  }
}

/**
 * Convert an attachment block to a Gemini Part.
 * Binary image/PDF attachments become inlineData; text attachments are base64-decoded to text.
 * Non-text binary attachments (e.g., application/octet-stream) are sent as inlineData
 * so Gemini can handle them natively rather than corrupting them via UTF-8 decoding.
 * @param block - Attachment block
 * @returns Gemini Part with inlineData or text, or undefined if source is not base64
 */
function attachmentBlockToPart(block: AttachmentBlock): GeminiPart | undefined {
  if (block.source.type !== 'base64') return undefined;
  const normalizedMimeType = normalizeMimeType(block.source.mimeType);
  if (normalizedMimeType.startsWith('image/') || normalizedMimeType === 'application/pdf') {
    return { inlineData: { data: block.source.data, mimeType: normalizedMimeType } };
  }
  if (isTextLikeMimeType(normalizedMimeType)) {
    // Text attachments: decode base64 and include as text content
    // Defensive decoding: wrap in try/catch to handle invalid base64
    try {
      return { text: Buffer.from(block.source.data, 'base64').toString('utf-8') };
    } catch (error) {
      console.warn('[Gemini SDK] Invalid base64 attachment payload in history conversion', {
        fileName: block.fileName,
        mimeType: normalizedMimeType,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return empty text part on invalid base64
      return { text: '' };
    }
  }
  // Non-text binary: return as inlineData so Gemini can handle it natively
  return { inlineData: { data: block.source.data, mimeType: normalizedMimeType } };
}

/**
 * Merge consecutive Content entries with the same role into a single entry.
 *
 * Gemini API requires strictly alternating user/model turns. Multiple source
 * messages can map to the same role (e.g. consecutive user messages, or a user
 * text message followed by a functionResponse which is also user-role).
 * This pass combines their parts arrays to satisfy the alternation constraint.
 * @param contents - Unmerged Content array (may have consecutive same-role entries)
 * @returns Content array with strictly alternating roles
 */
function mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length === 0) return contents;

  const merged: GeminiContent[] = [contents[0]];
  for (let i = 1; i < contents.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = contents[i];
    if (curr.role === prev.role) {
      prev.parts = [...(prev.parts ?? []), ...(curr.parts ?? [])];
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/**
 * Convert a single message block to Gemini parts, appending into the provided accumulator.
 * @param block - The message block to convert
 * @param msgRole - Role of the containing message (for defensive tool_call handling)
 * @param toolNameByCallId - Index of tool call IDs to names (for tool_output resolution)
 * @param acc - Mutable accumulator to push parts into
 */
function convertBlockToParts(
  block: MessageBlock,
  msgRole: Message['role'],
  toolNameByCallId: Map<string, string>,
  acc: BlockParts,
): void {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      acc.modelParts.push({ text: block.content });
      break;
    case 'tool_call':
      if (msgRole !== 'assistant') {
        // Defensive handling for imported/legacy/future history that may include
        // tool calls on non-assistant roles. Preserve intent as text, do not crash.
        acc.modelParts.push({
          text: `[Tool Call${block.toolCallId ? ` ${block.toolCallId}` : ''} from ${msgRole ?? 'unknown'}: ${block.name}]`,
        });
      } else {
        acc.modelParts.push({ functionCall: { name: block.name, args: block.args } });
      }
      break;
    case 'tool_output': {
      const toolName = toolNameByCallId.get(block.toolCallId);
      if (toolName) {
        acc.functionResponseParts.push({
          functionResponse: {
            id: block.toolCallId,
            name: toolName,
            // Keep replay format aligned with live execution in execute-tool-calls.ts:
            // success uses { output }, failures use { error }.
            response: block.isError ? { error: block.output } : { output: block.output },
          },
        });
      } else {
        acc.orphanToolOutputs.push({
          text: `[Tool Output ${block.toolCallId}${block.isError ? ' (error)' : ''}]\n${block.output}`,
        });
      }
      break;
    }
    case 'image':
    case 'document': {
      const part = mediaBlockToPart(block as MediaBlock);
      if (part) acc.modelParts.push(part);
      break;
    }
    case 'attachment': {
      const part = attachmentBlockToPart(block as AttachmentBlock);
      if (part) acc.modelParts.push(part);
      break;
    }
    default: {
      // Unknown block type - log warning and preserve content defensively
      const unknownBlock = block as MessageBlock & { type: string; id?: string };
      console.warn(`[Gemini SDK] Unknown block type encountered: ${unknownBlock.type}`, {
        blockType: unknownBlock.type,
        blockId: unknownBlock.id,
        msgRole,
      });
      // Preserve as text so content is not silently lost
      acc.modelParts.push({ text: `[Unknown block type: ${unknownBlock.type}]` });
      break;
    }
  }
}

/**
 * Convert curated message history to Gemini Content[] format.
 *
 * Transforms the shared Message format (with blocks) into Gemini's expected format:
 * - Text/reasoning blocks become text parts
 * - tool_call blocks become functionCall parts on model messages
 * - tool_output blocks become functionResponse parts on separate user messages
 * - image/document base64 blocks become inlineData parts; URL blocks become fileData parts
 * - attachment blocks with image/* or application/pdf mimeType become inlineData parts;
 *   text-like attachments are base64-decoded and included as text parts;
 *   other binary attachments are sent as inlineData
 * - Consecutive same-role entries are merged to satisfy Gemini's alternating turn requirement
 *
 * Note: Gemini uses 'model' (not 'assistant') for AI responses.
 * @param history - Curated messages from sessionContext.messageHistory
 * @returns Array of Gemini Content objects for setHistory()
 */
export function convertMessageHistory(history: Message[]): GeminiHistory {
  const result: GeminiContent[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const msg of history) {
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [msg.blocks];
    indexToolCallNames(blocks, toolNameByCallId);

    // Map role: Gemini uses 'model' not 'assistant', 'user' stays as-is.
    // System messages map to 'user' — Gemini has no system role in history.
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    const acc: BlockParts = { modelParts: [], functionResponseParts: [], orphanToolOutputs: [] };
    for (const block of blocks) {
      convertBlockToParts(block, msg.role, toolNameByCallId, acc);
    }

    if (acc.modelParts.length > 0) {
      result.push({ role, parts: acc.modelParts });
    }

    // NOTE: gemini-cli-core setHistory() uses Content[] turn roles ('user' | 'model').
    // Function responses are represented as user-role turns containing functionResponse parts.
    if (acc.functionResponseParts.length > 0) {
      result.push({ role: 'user', parts: acc.functionResponseParts });
    }

    if (acc.orphanToolOutputs.length > 0) {
      result.push({ role: 'user', parts: acc.orphanToolOutputs });
    }
  }

  return mergeConsecutiveRoles(result);
}
