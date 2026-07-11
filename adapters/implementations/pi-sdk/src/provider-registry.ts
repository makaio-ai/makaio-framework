import type { ProtocolEndpoints, ProtocolId } from '@makaio/contracts';
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
 * @param protocol - Exact protocol declared by the selected adapter/provider ref
 * @param endpoints - Effective protocol-to-URL mapping from providerContext
 * @returns Resolved `{ piApi, baseUrl }` or `undefined` when unrecognized
 */
export function resolveProviderEndpoint(
  protocol: ProtocolId,
  endpoints: ProtocolEndpoints | undefined,
): { piApi: Api; baseUrl: string } | undefined {
  const piApi = PROTOCOL_TO_PI_API[protocol];
  const baseUrl = endpoints?.[protocol];
  return piApi && baseUrl ? { piApi, baseUrl } : undefined;
}

/**
 * Register a Makaio provider in Pi's model registry with a single model entry.
 * @param modelRegistry - Pi's ModelRegistry to register the provider on
 * @param providerName - Makaio provider definition ID
 * @param modelId - Model identifier to register
 * @param protocol - Exact protocol selected by the adapter/provider ref
 * @param endpointOverrides - Protocol-to-URL mapping from providerContext
 * @param apiKey - Selected provider API key
 */
export function registerMakaioProviderModel(
  modelRegistry: ModelRegistry,
  providerName: string,
  modelId: string,
  protocol: ProtocolId,
  endpointOverrides: ProtocolEndpoints | undefined,
  apiKey: string,
): void {
  const endpoint = resolveProviderEndpoint(protocol, endpointOverrides);
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
