import type { SystemMessageConfig } from '@github/copilot-sdk';
import type { SystemPrompt } from '@makaio/contracts';

/**
 * Map Makaio {@link SystemPrompt} to the Copilot SDK's {@link SystemMessageConfig}.
 *
 * - A plain `string` prompt maps to `mode: 'replace'` (replaces the base system message).
 * - A structured prompt with `content` maps to `mode: 'append'` (appended to the base message).
 * - `undefined` returns `undefined` so the caller can omit `systemMessage` from the SDK config.
 * @param prompt - System prompt to map
 * @returns Copilot SDK SystemMessageConfig, or `undefined` when no prompt is set
 */
export function mapSystemPromptToSdkConfig(prompt: SystemPrompt | undefined): SystemMessageConfig | undefined {
  if (prompt === undefined) return undefined;

  if (typeof prompt === 'string') {
    return { mode: 'replace' as const, content: prompt };
  }

  return { mode: 'append' as const, content: prompt.content };
}
