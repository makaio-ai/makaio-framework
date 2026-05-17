import type { SystemPrompt } from '@makaio/contracts';

/**
 * Provider config system prompt type from the Claude Agent SDK. The shared
 * package intentionally mirrors the SDK shape without depending on the SDK
 * package so Claude CLI/agent shared helpers stay lightweight. The current SDK
 * accepts raw strings, prompt-part arrays, and the preset object including
 * `excludeDynamicSections`, so this type must stay aligned with that surface.
 */
export type ProviderSystemPrompt =
  | string
  | string[]
  | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
      excludeDynamicSections?: boolean;
    }
  | undefined;

const MEMORY_INSTRUCTION = 'You are naturally continuing a conversation with user.';

/**
 * Append content to a Claude preset prompt without losing preset metadata.
 * @param baseSystemPrompt - Existing Claude preset prompt object.
 * @param content - Prompt text to append.
 * @returns Updated preset prompt preserving SDK-only flags.
 */
function appendPresetPrompt(
  baseSystemPrompt: Extract<NonNullable<ProviderSystemPrompt>, { type: 'preset' }>,
  content: string,
): NonNullable<ProviderSystemPrompt> {
  return {
    ...baseSystemPrompt,
    append: baseSystemPrompt.append ? `${baseSystemPrompt.append} ${content}` : content,
  };
}

/**
 * Append content to any supported provider prompt shape.
 * @param baseSystemPrompt - Existing provider-config prompt payload.
 * @param content - Prompt text to append.
 * @returns Appended prompt payload in the same semantic shape where possible.
 */
function appendProviderPrompt(
  baseSystemPrompt: ProviderSystemPrompt,
  content: string,
): NonNullable<ProviderSystemPrompt> {
  if (typeof baseSystemPrompt === 'string') {
    return baseSystemPrompt ? `${baseSystemPrompt} ${content}` : content;
  }
  if (Array.isArray(baseSystemPrompt)) {
    return [...baseSystemPrompt, content];
  }
  if (baseSystemPrompt) {
    return appendPresetPrompt(baseSystemPrompt, content);
  }
  return content;
}

/**
 * Builds the final system prompt from base config and runtime options.
 *
 * Logic:
 * - If runtime prompt is a string (replace mode): use it directly
 * - If runtime prompt has append mode: append to the base provider prompt while
 *   preserving Claude SDK array/preset semantics
 * - If no runtime prompt: use base with default continuation instruction
 * @param baseSystemPrompt - System prompt from provider config (string, preset object, or undefined)
 * @param runtimeSystemPrompt - Runtime system prompt from start options
 * @returns Final system prompt payload for the Claude SDK
 */
export function buildSystemPrompt(
  baseSystemPrompt: ProviderSystemPrompt,
  runtimeSystemPrompt: SystemPrompt | undefined,
): NonNullable<ProviderSystemPrompt> {
  if (runtimeSystemPrompt) {
    if (typeof runtimeSystemPrompt === 'string') {
      // Replace mode: use runtime prompt directly
      return runtimeSystemPrompt;
    }
    return appendProviderPrompt(baseSystemPrompt, runtimeSystemPrompt.content);
  }

  // Default: use base prompt with continuation instruction
  return appendProviderPrompt(baseSystemPrompt, MEMORY_INSTRUCTION);
}
