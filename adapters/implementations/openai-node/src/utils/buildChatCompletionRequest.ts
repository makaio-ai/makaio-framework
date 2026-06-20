import { createHash } from 'node:crypto';
import type { AIReasoningLevel } from '@makaio/ai-adapters-core';
import { ResponseSchemaNameSchema, type CacheStrategy, type ResponseSchemaDescriptor } from '@makaio/contracts';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/index.js';
import type { ReasoningEffort } from 'openai/resources/shared.js';
import { getOpenAIToolName } from './getOpenAIToolName.js';

interface BuildChatCompletionRequestInput {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  reasoningEffort?: AIReasoningLevel;
  supportsReasoningEffort: boolean;
  /** Per-turn structured-output schema descriptor forwarded from the message handle. */
  responseSchema?: ResponseSchemaDescriptor;
  /**
   * Whether the active model supports the OpenAI `strict` structured-output flag.
   * When `false`, `strict` is omitted from the `json_schema` payload even if
   * {@link BuildChatCompletionRequestInput.responseSchema} requests it.
   */
  supportsStructuredOutputStrict: boolean;
  /** Caller-expressed caching intent. When 'fullPrefix', sets prompt_cache_key. */
  cacheStrategy?: CacheStrategy;
  /** System prompt string used for cache key derivation (not sent directly — already in messages). */
  systemPrompt?: string;
}

type OpenAIChatCompletionRequest = ChatCompletionCreateParamsStreaming;

/**
 * Map normalized reasoning level to OpenAI `reasoning_effort`.
 * @param reasoningEffort - Makaio reasoning effort
 * @returns OpenAI-compatible reasoning effort
 */
function toOpenAIReasoningEffort(reasoningEffort: AIReasoningLevel): ReasoningEffort {
  if (reasoningEffort === 'extra-high') {
    return 'xhigh';
  }
  return reasoningEffort;
}

/**
 * Derive a provider-safe `name` field for the OpenAI `json_schema` response format.
 *
 * Resolution order:
 * 1. `responseSchema.name` — explicitly supplied by the caller.
 * 2. `responseSchema.schema.title` — when it is a string that satisfies
 *    {@link ResponseSchemaNameSchema} (provider-safe alphanumeric, max 64 characters).
 * 3. `'response'` — safe ASCII fallback that always passes validation.
 * @param responseSchema - The descriptor to extract a name from
 * @returns A provider-safe schema name string
 */
function resolveResponseSchemaName(responseSchema: ResponseSchemaDescriptor): string {
  if (responseSchema.name) return responseSchema.name;
  const title = responseSchema.schema.title;
  if (typeof title === 'string' && ResponseSchemaNameSchema.safeParse(title).success) return title;
  return 'response';
}

/**
 * Build chat.completions payload for OpenAI-compatible providers.
 * @param input - Payload inputs and reasoning capability metadata
 * @returns Request object for `chat.completions.create`
 */
export function buildChatCompletionRequest(input: BuildChatCompletionRequestInput): OpenAIChatCompletionRequest {
  const reasoningEffort =
    input.supportsReasoningEffort && input.reasoningEffort && input.reasoningEffort !== 'none'
      ? toOpenAIReasoningEffort(input.reasoningEffort)
      : undefined;

  const promptCacheKey =
    input.cacheStrategy === 'fullPrefix'
      ? derivePromptCacheKey(input.model, input.systemPrompt, input.tools, input.reasoningEffort)
      : undefined;

  return {
    model: input.model,
    messages: input.messages,
    tools: input.tools.length > 0 ? input.tools : undefined,
    stream: true,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
    stream_options: { include_usage: true },
    ...(input.responseSchema !== undefined && {
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: resolveResponseSchemaName(input.responseSchema),
          schema: input.responseSchema.schema,
          ...(input.supportsStructuredOutputStrict && input.responseSchema.strict === true && { strict: true }),
        },
      },
    }),
  };
}

/**
 * Derive a deterministic cache key from the stable prefix properties of the request.
 * Requests with the same model, system prompt, tools, and reasoning effort share
 * a cache key so OpenAI routes them to the same cache machine.
 * @param model - Model identifier
 * @param systemPrompt - System prompt string
 * @param tools - Tool definitions
 * @param reasoningEffort - Reasoning effort level
 * @returns SHA-256 hex prefix (first 16 characters)
 */
function derivePromptCacheKey(
  model: string,
  systemPrompt: string | undefined,
  tools: ChatCompletionTool[],
  reasoningEffort: AIReasoningLevel | undefined,
): string {
  // Cache keys use the same tool-name resolver as request materialization so
  // function and custom tools hash consistently.
  const toolNames = tools.map(getOpenAIToolName).sort();
  const payload = JSON.stringify({ model, systemPrompt: systemPrompt ?? '', toolNames, reasoningEffort });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
