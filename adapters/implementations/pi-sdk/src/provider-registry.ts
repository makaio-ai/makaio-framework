import type { ProtocolEndpoints } from '@makaio/contracts';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { Api } from '@mariozechner/pi-ai';
import type { PiThinkingLevel } from './types/index.js';

/**
 * Map Makaio reasoning levels to Pi SDK thinking levels.
 *
 * Pi's `ThinkingLevel` has an extra granularity step (`'minimal'`) between
 * `'off'` and `'low'`, and uses `'xhigh'` for `'extra-high'`.
 */
export const REASONING_TO_THINKING: Record<string, PiThinkingLevel> = {
  none: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
};

const PI_MODEL_THINKING_LEVELS: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Map Makaio wire protocol identifiers to Pi SDK API types. */
const PROTOCOL_TO_PI_API: Record<string, Api> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
};

/**
 * Resolve the Pi API type and base URL from Makaio's protocol endpoint map.
 * @param endpointOverrides - Protocol-to-URL mapping from providerContext
 * @returns Resolved `{ piApi, baseUrl }` or `undefined` when unrecognized
 */
export function resolveProviderEndpoint(
  endpointOverrides: ProtocolEndpoints | undefined,
): { piApi: Api; baseUrl: string } | undefined {
  if (!endpointOverrides) return undefined;
  for (const [protocol, url] of Object.entries(endpointOverrides)) {
    const piApi = PROTOCOL_TO_PI_API[protocol];
    if (piApi && url) return { piApi, baseUrl: url };
  }
  return undefined;
}

/**
 * Register a Makaio provider in Pi's model registry with a single model entry.
 * @param modelRegistry - Pi's ModelRegistry to register the provider on
 * @param providerName - Makaio provider definition ID
 * @param modelId - Model identifier to register
 * @param endpointOverrides - Protocol-to-URL mapping from providerContext
 * @param apiKey - Resolved API key or env var name
 */
export function registerMakaioProviderModel(
  modelRegistry: ModelRegistry,
  providerName: string,
  modelId: string,
  endpointOverrides: ProtocolEndpoints | undefined,
  apiKey?: string,
): void {
  const endpoint = resolveProviderEndpoint(endpointOverrides);
  if (!endpoint) return;

  modelRegistry.registerProvider(providerName, {
    baseUrl: endpoint.baseUrl,
    api: endpoint.piApi,
    apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: true,
        // Pi's ModelRegistry consumes Pi-native thinking keys here. Makaio
        // reasoning levels are translated before calling session.setThinkingLevel().
        thinkingLevelMap: Object.fromEntries(PI_MODEL_THINKING_LEVELS.map((level) => [level, level])),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
    ],
  });
}
