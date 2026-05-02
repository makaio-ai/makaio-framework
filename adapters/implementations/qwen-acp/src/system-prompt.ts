import type { ProcessingState } from '@makaio/ai-adapters-core';
import type { SystemPrompt } from '@makaio/contracts';

/**
 * Convert a runtime system prompt into the text written to QWEN_SYSTEM_MD.
 * @param prompt - Runtime system prompt
 * @returns Plain-text prompt content
 */
export function getSystemPromptText(prompt: SystemPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.content;
}

/**
 * Whether an idle connector should recreate its ACP session to apply a newly
 * resolved system prompt at spawn time.
 * @param options - Current connector state and the next prompt
 * @returns True when the connector should rebuild its ACP session
 */
export function shouldReinitializeSystemPrompt(options: {
  isInitialized: boolean;
  nextPrompt: SystemPrompt | undefined;
  currentPrompt: SystemPrompt | undefined;
  hasActiveTurn: boolean;
  hasPendingMessage: boolean;
  hasCompletedTurn: boolean;
  processingState: ProcessingState;
}): boolean {
  if (!options.isInitialized || options.nextPrompt === undefined) {
    return false;
  }

  if (
    options.hasActiveTurn ||
    options.hasPendingMessage ||
    options.hasCompletedTurn ||
    options.processingState !== 'idle'
  ) {
    return false;
  }

  const currentPromptText = options.currentPrompt ? getSystemPromptText(options.currentPrompt) : undefined;
  return currentPromptText !== getSystemPromptText(options.nextPrompt);
}
