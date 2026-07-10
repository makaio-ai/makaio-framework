/**
 * Message normalization helpers for OpenCode log import.
 *
 * Converts OpenCode message parts into normalized Makaio events and
 * storage-ready message payloads.
 * @packageDocumentation
 */

import { AgentSubjects } from '@makaio/contracts';
import type { SessionMessageBlock } from '@makaio/contracts';
import type { NormalizedEvent, ImportMetadata, StorageMessagePayload } from '@makaio/ai-adapters-core';

import type { OpenCodeMessage, OpenCodePart, OpenCodeStepFinishPart } from './types.js';

/**
 * Shared context for event normalization helpers.
 * Groups the repeated adapter/session/import fields passed to every helper.
 */
interface NormalizerContext {
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  timestamp: string;
  importMetadata: ImportMetadata;
}

/**
 * Extract concatenated text content from text parts.
 * @param parts - OpenCode message parts
 * @returns Joined text content used for message payloads/events
 */
export function extractTextContent(parts: OpenCodePart[]): string {
  const textParts = parts.filter((p): p is Extract<OpenCodePart, { type: 'text' }> => p.type === 'text');
  return textParts.map((p) => p.text).join('\n');
}

/**
 * Create a user message event from OpenCode message and parts.
 * @param message - OpenCode message metadata
 * @param parts - Message parts
 * @param ctx - Shared normalization context (adapter, session, timestamp, import metadata)
 * @returns Normalized user message event
 */
export function createUserMessageEvent(
  message: OpenCodeMessage,
  parts: OpenCodePart[],
  ctx: NormalizerContext,
): NormalizedEvent {
  const { adapterId, adapterName, adapterSessionId, timestamp, importMetadata } = ctx;
  const text = extractTextContent(parts);

  return {
    subject: AgentSubjects.user_message.sent,
    payload: {
      adapterId,
      adapterName,
      agentId: message.agent ?? 'main',
      adapterSessionId,
      messageId: message.id,
      content: {
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: text }],
      },
      timestamp,
      _import: importMetadata,
    },
  };
}

/**
 * Create assistant message events from OpenCode message and parts.
 * @param message - OpenCode message metadata
 * @param parts - Message parts
 * @param ctx - Shared normalization context (adapter, session, timestamp, import metadata)
 * @param turnId - Current turn ID from TurnTracker for propagation to tool events
 * @returns Array of normalized events (text, reasoning, tool use, tool result, usage)
 */
export function createAssistantMessageEvents(
  message: OpenCodeMessage,
  parts: OpenCodePart[],
  ctx: NormalizerContext,
  turnId?: string,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  // Extract model from message - handle both nested (user) and top-level (assistant) formats
  const model = getModelString(message);

  for (const part of parts) {
    if (part.type === 'text') {
      events.push(createTextMessageEvent(message, part, ctx));
    } else if (part.type === 'reasoning') {
      events.push(createReasoningEvent(message, part, ctx));
    } else if (part.type === 'tool') {
      events.push(...createToolEvents(message, part, ctx, turnId));
    } else if (part.type === 'step-finish' && hasTokens(part)) {
      events.push(createUsageEvent(message, part, model, ctx));
    }
  }

  return events;
}

/**
 * Extract model string from message, handling both user and assistant formats.
 * @param message - OpenCode message
 * @returns Model string in "provider/model" format, or null
 */
function getModelString(message: OpenCodeMessage): string | null {
  // User messages have nested model object
  if ('model' in message && message.model) {
    return `${message.model.providerID}/${message.model.modelID}`;
  }
  // Assistant messages have top-level providerID/modelID
  if ('providerID' in message && 'modelID' in message && message.providerID && message.modelID) {
    return `${message.providerID}/${message.modelID}`;
  }
  return null;
}

/**
 * Check if a step-finish part has token data (top-level or in nested metrics).
 * @param part - Step finish part
 * @returns True if tokens are available
 */
function hasTokens(part: OpenCodeStepFinishPart): boolean {
  return !!part.tokens || !!part.metrics?.tokens;
}

/**
 * Create a text message event.
 * @param message - OpenCode message metadata
 * @param part - Text part
 * @param ctx - Shared normalization context
 * @returns Normalized text message event
 */
function createTextMessageEvent(
  message: OpenCodeMessage,
  part: Extract<OpenCodePart, { type: 'text' }>,
  ctx: NormalizerContext,
): NormalizedEvent {
  const { adapterId, adapterName, adapterSessionId, timestamp, importMetadata } = ctx;
  return {
    subject: AgentSubjects.message,
    payload: {
      adapterId,
      adapterName,
      agentId: message.agent ?? 'main',
      adapterSessionId,
      messageId: message.id,
      content: part.text,
      timestamp,
      _import: importMetadata,
    },
  };
}

/**
 * Create a reasoning event (for models that expose thinking/reasoning).
 * @param message - OpenCode message metadata
 * @param part - Reasoning part
 * @param ctx - Shared normalization context
 * @returns Normalized reasoning event
 */
function createReasoningEvent(
  message: OpenCodeMessage,
  part: Extract<OpenCodePart, { type: 'reasoning' }>,
  ctx: NormalizerContext,
): NormalizedEvent {
  const { adapterId, adapterName, adapterSessionId, timestamp, importMetadata } = ctx;
  return {
    subject: AgentSubjects.reasoning,
    payload: {
      adapterId,
      adapterName,
      agentId: message.agent ?? 'main',
      adapterSessionId,
      messageId: message.id,
      content: part.text,
      timestamp,
      _import: importMetadata,
    },
  };
}

/**
 * Create tool use and completion events.
 * @param message - OpenCode message metadata
 * @param part - Tool part
 * @param ctx - Shared normalization context
 * @param turnId - Current turn ID from TurnTracker
 * @returns Array of tool events (use and optionally completed)
 */
function createToolEvents(
  message: OpenCodeMessage,
  part: Extract<OpenCodePart, { type: 'tool' }>,
  ctx: NormalizerContext,
  turnId?: string,
): NormalizedEvent[] {
  const { adapterId, adapterName, adapterSessionId, timestamp, importMetadata } = ctx;
  const events: NormalizedEvent[] = [
    {
      subject: AgentSubjects.tool.use,
      payload: {
        adapterId,
        adapterName,
        agentId: message.agent ?? 'main',
        adapterSessionId,
        messageId: message.id,
        toolName: part.tool,
        toolCallId: part.callID,
        input: part.state.input,
        timestamp,
        _import: importMetadata,
        turnId,
      },
    },
  ];

  if (part.state.status === 'completed' || part.state.status === 'error') {
    events.push({
      subject: AgentSubjects.tool.completed,
      payload: {
        adapterId,
        adapterName,
        agentId: message.agent ?? 'main',
        adapterSessionId,
        messageId: message.id,
        turnId,
        toolCallId: part.callID,
        output: part.state.output ?? null,
        error: part.state.status === 'error' ? 'Tool execution failed' : undefined,
        timestamp,
        _import: importMetadata,
      },
    });
  }

  return events;
}

/**
 * Create a usage event from step metrics.
 * Handles both top-level tokens (current format) and nested metrics.tokens (older log format).
 *
 * Each step-finish part corresponds to exactly one LLM request in OpenCode,
 * so the event carries `granularity: 'provider-call'`. When a cost value is
 * present it originates from OpenCode's own log (not the provider), so it is
 * marked `costProvenance: 'client-reported'`; without a cost value neither
 * field is emitted.
 *
 * Cache and reasoning token counts are optional in OpenCode logs; missing
 * values default to 0, matching the live token-counting adapters
 * (anthropic-sdk, openai-node, cursor-sdk). Cost accounting follows the same
 * convention: `costUnits` equals `totalTokens` with `costUnitType: 'tokens'`.
 * @param message - OpenCode message metadata
 * @param part - Step finish part with metrics
 * @param model - Model string
 * @param ctx - Shared normalization context
 * @returns Normalized usage event
 */
function createUsageEvent(
  message: OpenCodeMessage,
  part: OpenCodeStepFinishPart,
  model: string | null,
  ctx: NormalizerContext,
): NormalizedEvent {
  const { adapterId, adapterName, adapterSessionId, timestamp, importMetadata } = ctx;

  const { totalTokens, inputTokens, outputTokens, inputCachedTokens, cacheWriteTokens, reasoningTokens } =
    extractStepTokens(part);

  // Get cost from top-level (current) or nested metrics (older logs)
  const cost = part.cost ?? part.metrics?.cost?.total;

  const provider = extractProvider(message);

  return {
    subject: AgentSubjects.usage,
    payload: {
      adapterId,
      adapterName,
      agentId: message.agent ?? 'main',
      adapterSessionId,
      messageId: message.id,
      // One step-finish part = one LLM request in OpenCode.
      granularity: 'provider-call',
      provider,
      model: model ?? 'unknown',
      inputTokens,
      inputCachedTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      // Token-counting adapters bill cost units in tokens (see e.g.
      // anthropic-sdk and openai-node extractUsagePayload).
      costUnits: totalTokens,
      costUnitType: 'tokens',
      // Cost comes from the external tool's log, not directly from the provider.
      ...(cost !== undefined ? { cost, costProvenance: 'client-reported' } : {}),
      timestamp,
      _import: importMetadata,
    },
  };
}

/** Normalized token counts of one step-finish part, ready for the `agent.usage` payload. */
interface StepTokenCounts {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputCachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/**
 * Extract normalized token counts from a step-finish part.
 * Prefers top-level tokens (current format) and falls back to nested
 * metrics.tokens (older log format). Cache and reasoning counts only exist in
 * the current top-level format; the legacy nested metrics format never
 * carried them, so they default to 0.
 * @param part - Step finish part with metrics
 * @returns Token counts ready for the `agent.usage` payload
 * @throws Error when the part carries no tokens data in either format
 */
function extractStepTokens(part: OpenCodeStepFinishPart): StepTokenCounts {
  const tokens = part.tokens ?? part.metrics?.tokens;
  if (!tokens) {
    throw new Error('step-finish part has no tokens data');
  }

  return {
    // Calculate total if not provided (current format doesn't have total)
    totalTokens: 'total' in tokens ? tokens.total : tokens.input + tokens.output,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    inputCachedTokens: part.tokens?.cache?.read ?? 0,
    cacheWriteTokens: part.tokens?.cache?.write ?? 0,
    reasoningTokens: part.tokens?.reasoning ?? 0,
  };
}

/**
 * Extract the provider ID from a message, handling both user and assistant formats.
 * @param message - OpenCode message metadata
 * @returns Provider ID, or 'unknown' when the message carries none
 */
function extractProvider(message: OpenCodeMessage): string {
  if ('model' in message && message.model) {
    return message.model.providerID;
  }
  if ('providerID' in message && message.providerID) {
    return message.providerID;
  }
  return 'unknown';
}

/**
 * Build a storage-ready message payload from an OpenCode message and its parts.
 *
 * Extracts plain text (for FTS indexing) and structured blocks from the
 * message parts. Tool parts produce both a `tool_call` block and, when output
 * is present, a `tool_output` block.
 * @param message - OpenCode message metadata
 * @param parts - Message parts (text, reasoning, tool, step-start, step-finish)
 * @param adapterSessionId - Adapter's native session identifier
 * @returns Storage-ready message payload
 */
export function buildMessagePayload(
  message: OpenCodeMessage,
  parts: OpenCodePart[],
  adapterSessionId: string,
): StorageMessagePayload {
  const contentText = extractTextContent(parts);

  const blocks: SessionMessageBlock[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', content: part.text });
    } else if (part.type === 'reasoning') {
      blocks.push({ type: 'reasoning', content: part.text });
    } else if (part.type === 'tool') {
      blocks.push({
        type: 'tool_call',
        toolCallId: part.callID,
        name: part.tool,
        args: part.state.input,
      });
      if (part.state.output !== undefined) {
        blocks.push({
          type: 'tool_output',
          toolCallId: part.callID,
          output: typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output),
        });
      }
    }
    // step-start and step-finish parts carry metrics only — no content blocks
  }

  return {
    adapterMessageId: message.id,
    role: message.role,
    contentText,
    blocks,
    agentId: message.agent ?? 'main',
    adapterSessionId,
    timestamp: message.time.created,
  };
}
