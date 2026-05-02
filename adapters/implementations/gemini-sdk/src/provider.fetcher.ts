import type { AIModel, ProviderDefinition } from '@makaio/contracts';
import { VALID_GEMINI_MODELS, getDisplayString } from '@google/gemini-cli-core';

/**
 * Discover available models from the Gemini CLI SDK.
 *
 * Uses the SDK's own `VALID_GEMINI_MODELS` set rather than calling the
 * Google AI API — this gives us exactly the models the SDK supports,
 * avoids requiring credentials, and stays in sync with dependency bumps.
 *
 * Context window sizes and reasoning levels are not available from the SDK,
 * so the caller must enrich results from curated provider.ts data.
 * @param _definition - Provider definition (unused — models come from the SDK)
 * @returns Array of models with name and friendlyName (contextWindowSize defaults to 0)
 */
export async function fetchModels(_definition: ProviderDefinition): Promise<AIModel[] | null> {
  const models: AIModel[] = [];

  for (const modelName of VALID_GEMINI_MODELS) {
    models.push({
      name: modelName,
      friendlyName: getDisplayString(modelName),
      contextWindowSize: 0, // Not provided by SDK — enriched from curated data
      labId: 'google',
    });
  }

  return models;
}
