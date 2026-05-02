import type { AIModel } from '@makaio/ai-adapters-core';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
} from '@google/gemini-cli-core';

/**
 * Gemini model registry with context window sizes.
 *
 * Context window sizes based on Google AI documentation:
 * - Gemini 2.5 Pro: 2M tokens
 * - Gemini 2.5 Flash: 1M tokens
 * - Gemini 2.5 Flash Lite: 1M tokens
 */
export const GEMINI_MODELS: AIModel[] = [
  {
    name: DEFAULT_GEMINI_MODEL,
    friendlyName: 'Gemini 2.5 Pro',
    labId: 'google',
    contextWindowSize: 2097152, // 2M tokens
  },
  {
    name: DEFAULT_GEMINI_FLASH_MODEL,
    friendlyName: 'Gemini 2.5 Flash',
    labId: 'google',
    contextWindowSize: 1048576, // 1M tokens
  },
  {
    name: DEFAULT_GEMINI_FLASH_LITE_MODEL,
    friendlyName: 'Gemini 2.5 Flash Lite',
    labId: 'google',
    contextWindowSize: 1048576, // 1M tokens
  },
];

/**
 * Default context window size for unknown Gemini models.
 * Falls back to 1M tokens (Gemini Flash context window).
 */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 1048576;

/**
 * Get context window size for a specific Gemini model.
 * @param modelName - Name of the model to look up
 * @returns Context window size in tokens
 */
export function getContextWindowSize(modelName: string): number {
  const model = GEMINI_MODELS.find((m) => m.name === modelName);
  return model?.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
}
