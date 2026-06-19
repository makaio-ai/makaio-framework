import type { ChatCompletionTool } from 'openai/resources/index.js';

/**
 * Return the OpenAI tool name regardless of concrete tool kind.
 * @param tool - OpenAI chat completion tool definition
 * @returns Tool name used in model-visible requests and cache keys
 */
export function getOpenAIToolName(tool: ChatCompletionTool): string {
  return tool.type === 'function' ? tool.function.name : tool.custom.name;
}
