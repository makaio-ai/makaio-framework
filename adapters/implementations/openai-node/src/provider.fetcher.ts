import type { AIModelMetadata, DiscoveredAIModel, ProviderDefinitionInput } from '@makaio/contracts';
import { resolvePresetCredentials } from '@makaio/ai-adapters-core';
import { MODEL_FETCH_TIMEOUT_MS } from './constants.js';

/**
 * Raw model entry from an OpenAI-compatible /v1/models endpoint.
 *
 * Field availability varies by provider:
 * - OpenAI: id, created, owned_by
 * - NanoGPT: id, name, description, context_length, max_output_tokens, capabilities, pricing
 * - Z.AI: id, created, owned_by
 */
interface OpenAIRawModel {
  id: string;
  name?: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
    reasoning?: boolean;
    tool_calling?: boolean;
    parallel_tool_calls?: boolean;
    structured_output?: boolean;
    pdf_upload?: boolean;
  };
  pricing?: {
    prompt?: number;
    completion?: number;
  };
  subscription?: {
    included?: boolean;
  };
}

/**
 * Normalize raw OpenAI-compatible model data into the canonical AIModel shape.
 * @param raw - Raw model from the API
 * @returns Normalized discovered model with metadata when available
 */
function normalizeModel(raw: OpenAIRawModel): DiscoveredAIModel {
  const metadata: AIModelMetadata = {};
  let hasMetadata = false;

  if (typeof raw.max_output_tokens === 'number') {
    metadata.maxOutputTokens = raw.max_output_tokens;
    hasMetadata = true;
  }

  if (raw.capabilities) {
    metadata.capabilities = {
      vision: raw.capabilities.vision,
      toolCalling: raw.capabilities.tool_calling,
      parallelToolCalls: raw.capabilities.parallel_tool_calls,
      structuredOutput: raw.capabilities.structured_output,
      pdfUpload: raw.capabilities.pdf_upload,
    };
    hasMetadata = true;
  }

  if (typeof raw.pricing?.prompt === 'number' && typeof raw.pricing?.completion === 'number') {
    metadata.pricing = {
      token: {
        inputPerMillion: raw.pricing.prompt,
        outputPerMillion: raw.pricing.completion,
      },
    };
    hasMetadata = true;
  }

  if (raw.subscription?.included !== undefined) {
    metadata.includedInSubscription = raw.subscription.included;
    hasMetadata = true;
  }

  return {
    name: raw.id,
    friendlyName: raw.name ?? raw.display_name,
    contextWindowSize: raw.context_length ?? 0,
    ...(hasMetadata ? { metadata } : {}),
  };
}

/**
 * Fetch live model list from an OpenAI-compatible API.
 *
 * Used only by the registry generation script — not imported at runtime.
 * Resolves credentials from environment variables based on the definition's credentialEnvVars.
 * Works with any provider that implements the OpenAI /v1/models endpoint
 * (OpenAI, NanoGPT, Z.AI, OpenRouter, etc.).
 * @param definition - Provider definition to fetch models for
 * @returns Array of normalized discovered model objects, or null if credentials are unavailable
 */
export async function fetchModels(definition: ProviderDefinitionInput): Promise<DiscoveredAIModel[] | null> {
  const credentials = resolvePresetCredentials(definition);
  const apiKey = credentials?.apiKey;
  if (!apiKey) {
    return null;
  }

  const base = definition.endpoints?.openai ?? 'https://api.openai.com/v1';
  let url = `${base}/models`;

  if (definition.id === 'nanogpt') url += '?detailed=true';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${definition.name} API returned ${response.status}: ${response.statusText}`);
    }

    const json = (await response.json()) as { data?: OpenAIRawModel[] };
    if (!Array.isArray(json.data)) {
      throw new Error(`${definition.name} API returned unexpected shape (missing data array)`);
    }
    return json.data.map(normalizeModel);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${definition.name} API request timed out after ${MODEL_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
