import type { AIModel, ProviderDefinition } from '@makaio/contracts';
import { resolvePresetCredentials } from '@makaio/ai-adapters-core';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_MODELS_URL = 'https://api.anthropic.com/v1/models';

/**
 * Raw model entry from an Anthropic-compatible /v1/models endpoint.
 */
interface AnthropicRawModel {
  type: string;
  id: string;
  display_name?: string;
  created_at?: string;
}

/**
 * Build the models endpoint URL for a provider definition.
 * @param definition - Provider definition with optional anthropic endpoint
 * @returns Full URL to the models endpoint
 */
function resolveModelsUrl(definition: ProviderDefinition): string {
  const baseUrl = definition.endpoints?.anthropic;
  if (baseUrl) {
    const base = baseUrl.replace(/\/+$/, '');
    const normalizedBase = base.endsWith('/v1') ? base.slice(0, -3) : base;
    return `${normalizedBase}/v1/models`;
  }
  return DEFAULT_MODELS_URL;
}

/**
 * Fetch versioned models from the /v1/models HTTP endpoint.
 * @param definition - Provider definition with endpoint URL
 * @param apiKey - Resolved API key
 * @returns Array of raw model entries
 */
async function fetchVersionedModels(definition: ProviderDefinition, apiKey: string): Promise<AnthropicRawModel[]> {
  const url = resolveModelsUrl(definition);
  const response = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!response.ok) {
    throw new Error(`${definition.name} API returned ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { data: AnthropicRawModel[] };
  return data.data;
}

/**
 * Fetch live model list from an Anthropic-compatible API.
 *
 * For API-key providers (`anthropic`, `z-ai`, etc.): calls `/v1/models` to get
 * versioned model IDs.
 *
 * For OAuth providers (`anthropic-oauth`): queries the Agent SDK's
 * `supportedModels()` which returns family aliases (`sonnet`, `opus`, `haiku`).
 * These are resolved to versioned model IDs by cross-referencing the `/v1/models`
 * catalog — so only models the SDK actually supports are returned, but with their
 * real versioned names.
 *
 * The Anthropic API does not return context window sizes or capabilities,
 * so the caller must enrich results from curated data.
 * @param definition - Provider definition to fetch models for
 * @returns Array of models, or null if credentials are unavailable
 */
export async function fetchModels(definition: ProviderDefinition): Promise<AIModel[] | null> {
  const credentials = resolvePresetCredentials(definition);
  const apiKey = credentials?.apiKey;

  if (definition.id === 'anthropic-oauth') {
    const session = query({ prompt: '' });
    const sdkAliases = await session.supportedModels();
    const aliasNames = new Set(sdkAliases.map((m) => m.value).filter((v) => v !== 'default'));

    // Resolve aliases to versioned model IDs using the public API catalog.
    // The API key comes from the sibling `anthropic` provider's env var.
    const catalogApiKey = apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!catalogApiKey) {
      // No API key available — return aliases as-is for merge script matching.
      return sdkAliases
        .filter((m) => m.value !== 'default')
        .map((m) => ({
          name: m.value,
          friendlyName: m.displayName,
          contextWindowSize: 0,
          labId: 'anthropic',
        }));
    }

    const catalog = await fetchVersionedModels(definition, catalogApiKey);
    // Sort newest first so the first match per alias is the latest version.
    const sorted = [...catalog].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

    const resolved: AIModel[] = [];
    for (const alias of aliasNames) {
      const match = sorted.find((m) => m.id.endsWith(`-${alias}`) || m.id.includes(`-${alias}-`));
      if (match) {
        resolved.push({
          name: match.id,
          friendlyName: match.display_name,
          contextWindowSize: 0,
          labId: 'anthropic',
        });
      }
    }
    return resolved;
  }

  if (!apiKey) {
    return null;
  }

  const versioned = await fetchVersionedModels(definition, apiKey);
  return versioned.map((m) => ({
    name: m.id,
    friendlyName: m.display_name,
    contextWindowSize: 0,
    labId: 'anthropic',
  }));
}
