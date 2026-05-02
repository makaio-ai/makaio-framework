import type { AIReasoningLevel } from '@makaio/ai-adapters-core';
import type {
  MessageCreateParamsStreaming,
  MessageParam,
  TextBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { parseReasoningLevel } from './parseReasoningLevel.js';

/** Default max_tokens for Anthropic API requests. */
const DEFAULT_MAX_TOKENS = 32_000;

/** Input contract for assembling an Anthropic messages.create() streaming request. */
interface BuildMessageCreateRequestInput {
  /** Anthropic model identifier (e.g., 'claude-sonnet-4-20250514'). */
  model: string;
  /** Conversation history in Anthropic message format. */
  messages: MessageParam[];
  /** Resolved system prompt string. When provided, it is sent as a top-level param with prompt caching enabled. */
  systemPrompt?: string;
  /** Anthropic-format tools to expose to the model. Omitted from the request when empty. */
  tools?: Tool[];
  /** Makaio reasoning effort controlling the thinking token budget. */
  reasoningEffort?: AIReasoningLevel;
  /** Whether the selected model supports extended thinking. When false, the thinking param is never sent. */
  supportsReasoningEffort?: boolean;
  /** Override for max_tokens. Falls back to {@link DEFAULT_MAX_TOKENS} when not provided. */
  maxTokens?: number;
}

/**
 * Assembles parameters for an Anthropic `messages.create()` streaming call.
 *
 * Key differences from the OpenAI equivalent:
 * - `max_tokens` is required — defaults to {@link DEFAULT_MAX_TOKENS}.
 * - The system prompt is a top-level field with `cache_control: { type: 'ephemeral' }` for prompt caching.
 * - Reasoning is expressed via `thinking: { type: 'enabled', budget_tokens }` instead of `reasoning_effort`.
 * - Usage is always included in Anthropic streaming responses; no `stream_options` needed.
 * @param input - Request components and model capability metadata.
 * @returns Anthropic API request parameters with `stream: true`.
 */
export function buildMessageCreateRequest(input: BuildMessageCreateRequestInput): MessageCreateParamsStreaming {
  const { model, messages, systemPrompt, tools, reasoningEffort, supportsReasoningEffort } = input;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const system = buildSystemParam(systemPrompt);
  const thinking = buildThinkingParam(reasoningEffort, supportsReasoningEffort, maxTokens);

  return {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
    // Top-level cache_control auto-applies an ephemeral marker to the last cacheable
    // block (system, tools, etc.). Only sent when cacheable content exists — some
    // Anthropic-compatible providers (Alibaba, etc.) may not support this field.
    ...(system !== undefined ? { cache_control: { type: 'ephemeral', ttl: '5m' } } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

/**
 * Wraps the system prompt string in a `TextBlockParam` array with prompt caching enabled.
 * Returns `undefined` when no system prompt is provided.
 * @param systemPrompt - The resolved system prompt string, if any.
 * @returns A single-element `TextBlockParam` array with ephemeral cache control, or `undefined`.
 */
function buildSystemParam(systemPrompt: string | undefined): TextBlockParam[] | undefined {
  if (!systemPrompt) {
    return undefined;
  }
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Maps a Makaio reasoning level to Anthropic's `thinking` config param.
 * Returns `undefined` when the model does not support reasoning or the level is `'none'`.
 * @param reasoningEffort - The Makaio reasoning effort to convert.
 * @param supportsReasoningEffort - Whether the model supports extended thinking.
 * @param maxTokens - The request-level max token limit that thinking must remain below.
 * @returns An enabled `ThinkingConfigParam` or `undefined`.
 */
function buildThinkingParam(
  reasoningEffort: AIReasoningLevel | undefined,
  supportsReasoningEffort: boolean | undefined,
  maxTokens: number,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!supportsReasoningEffort || !reasoningEffort) {
    return undefined;
  }
  // Anthropic requires thinking.budget_tokens < max_tokens (strictly less).
  const budgetTokens = Math.min(parseReasoningLevel(reasoningEffort), maxTokens - 1);
  if (budgetTokens <= 0) {
    return undefined;
  }
  return { type: 'enabled', budget_tokens: budgetTokens };
}
