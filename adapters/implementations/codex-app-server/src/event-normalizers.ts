/**
 * Pure functions to normalize non-terminal Codex app-server events to AgentSubjects.
 *
 * Completion is deliberately excluded: the active MessageHandle owns the
 * canonical messageId/turnId correlation for `agent.complete`.
 * @packageDocumentation
 */

import type { NormalizedEvent } from '@makaio/ai-adapters-core';
import { AgentSubjects } from '@makaio/contracts';
import { DefaultModel, DefaultProvider } from './constants.js';
import type { ServerNotification } from './protocol/generated/ServerNotification.js';
import type {
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  ItemStartedNotification,
  ReasoningTextDeltaNotification,
  ThreadTokenUsageUpdatedNotification,
} from './protocol/generated/v2/index.js';

/** Context needed for event normalization */
export interface NormalizationContext {
  adapterId: string;
  adapterName: string;
  agentId: string;
  adapterSessionId: string;
  model?: string;
}

/**
 * Normalize app-server event to canonical AgentSubjects.
 *
 * Transforms app-server protocol notifications to global agent events that do
 * not require a message-handle correlation. `turn/completed` is intentionally
 * excluded: the active MessageHandle is the sole completion producer and
 * carries the canonical messageId and turnId.
 * Returns array of normalized events (some notifications may map to multiple).
 * @param notification - The server notification from app-server
 * @param context - Normalization context with session/adapter info
 * @returns Array of normalized events (may be empty for unhandled types)
 */
export function normalizeAppServerEvent(
  notification: ServerNotification,
  context: NormalizationContext,
): NormalizedEvent[] {
  const { method, params } = notification;

  // Handle notifications that map to global agent events
  if (method === 'item/agentMessage/delta') {
    return [normalizeAgentMessageDelta(params, context)];
  }
  if (method === 'item/started') {
    return normalizeItemStarted(params, context);
  }
  if (method === 'item/commandExecution/outputDelta') {
    return [normalizeCommandOutputDelta(params, context)];
  }
  if (method === 'item/reasoning/textDelta') {
    return [normalizeReasoningDelta(params, context)];
  }
  if (method === 'thread/tokenUsage/updated') {
    return [normalizeTokenUsage(params, context)];
  }
  // All other notifications are unhandled - return empty array
  return [];
}

/**
 * Normalize agent message delta to agent.message_delta subject.
 * @param params - The agent message delta notification
 * @param ctx - Normalization context
 * @returns Normalized event for message_delta
 */
function normalizeAgentMessageDelta(params: AgentMessageDeltaNotification, ctx: NormalizationContext): NormalizedEvent {
  return {
    subject: AgentSubjects.message_delta,
    payload: {
      ...ctx,
      text: params.delta,
    },
  };
}

/**
 * Normalize item started to appropriate subject based on item type.
 * @param params - The item started notification
 * @param ctx - Normalization context
 * @returns Array of normalized events (may be empty for unhandled types)
 */
function normalizeItemStarted(params: ItemStartedNotification, ctx: NormalizationContext): NormalizedEvent[] {
  const { item } = params;

  if (item.type === 'agentMessage') {
    // Message started - emit as message_delta with empty text to signal start
    return [
      {
        subject: AgentSubjects.message_delta,
        payload: {
          ...ctx,
          text: '',
        },
      },
    ];
  }

  if (item.type === 'commandExecution') {
    // Command execution started - map to tool.started
    return [
      {
        subject: AgentSubjects.tool.started,
        payload: {
          ...ctx,
          toolName: 'bash',
          toolCallId: item.id,
        },
      },
    ];
  }

  if (item.type === 'fileChange') {
    // File change started - map to tool.started
    return [
      {
        subject: AgentSubjects.tool.started,
        payload: {
          ...ctx,
          toolName: 'patch',
          toolCallId: item.id,
        },
      },
    ];
  }

  if (item.type === 'mcpToolCall') {
    // MCP tool call started - map to tool.started
    return [
      {
        subject: AgentSubjects.tool.started,
        payload: {
          ...ctx,
          toolName: `${item.server}:${item.tool}`,
          toolCallId: item.id,
        },
      },
    ];
  }

  // Unhandled item types
  return [];
}

/**
 * Normalize command output delta to agent.tool.output subject.
 * @param params - The command output delta notification
 * @param ctx - Normalization context
 * @returns Normalized event for tool output
 */
function normalizeCommandOutputDelta(
  params: CommandExecutionOutputDeltaNotification,
  ctx: NormalizationContext,
): NormalizedEvent {
  return {
    subject: AgentSubjects.tool.output,
    payload: {
      ...ctx,
      output: params.delta,
      toolCallId: params.itemId,
    },
  };
}

/**
 * Normalize reasoning delta to agent.reasoning_delta subject.
 * @param params - The reasoning text delta notification
 * @param ctx - Normalization context
 * @returns Normalized event for reasoning delta
 */
function normalizeReasoningDelta(params: ReasoningTextDeltaNotification, ctx: NormalizationContext): NormalizedEvent {
  return {
    subject: AgentSubjects.reasoning_delta,
    payload: {
      ...ctx,
      content: params.delta,
    },
  };
}

/**
 * Derive provider from model name.
 * @param model - The model name
 * @returns The provider identifier
 */
function deriveProvider(model: string): string {
  if (model.startsWith('claude')) {
    return 'anthropic';
  }
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai';
  }
  return DefaultProvider;
}

/**
 * Normalize token usage to agent.usage subject.
 * @param params - The token usage updated notification
 * @param ctx - Normalization context
 * @returns Normalized event for usage
 */
function normalizeTokenUsage(params: ThreadTokenUsageUpdatedNotification, ctx: NormalizationContext): NormalizedEvent {
  const { last } = params.tokenUsage;
  const model = ctx.model ?? DefaultModel;
  const provider = deriveProvider(model);

  return {
    subject: AgentSubjects.usage,
    payload: {
      ...ctx,
      // `tokenUsage.last` covers the latest single model request per
      // protocol update — hence `provider-call`.
      granularity: 'provider-call',
      provider,
      model,
      inputTokens: last.inputTokens,
      inputCachedTokens: last.cachedInputTokens,
      outputTokens: last.outputTokens,
      reasoningTokens: last.reasoningOutputTokens,
      totalTokens: last.totalTokens,
      costUnits: last.totalTokens,
      costUnitType: 'tokens',
    },
  };
}
