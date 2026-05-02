import type { AIReasoningLevel } from '@makaio/ai-adapters-core';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/index.js';
import type { ReasoningEffort } from 'openai/resources/shared.js';

interface BuildChatCompletionRequestInput {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  reasoningEffort?: AIReasoningLevel;
  supportsReasoningEffort: boolean;
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
 * Build chat.completions payload for OpenAI-compatible providers.
 * @param input - Payload inputs and reasoning capability metadata
 * @returns Request object for `chat.completions.create`
 */
export function buildChatCompletionRequest(input: BuildChatCompletionRequestInput): OpenAIChatCompletionRequest {
  const reasoningEffort =
    input.supportsReasoningEffort && input.reasoningEffort && input.reasoningEffort !== 'none'
      ? toOpenAIReasoningEffort(input.reasoningEffort)
      : undefined;

  return {
    model: input.model,
    messages: input.messages,
    tools: input.tools.length > 0 ? input.tools : undefined,
    stream: true,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    stream_options: { include_usage: true },
  };
}
