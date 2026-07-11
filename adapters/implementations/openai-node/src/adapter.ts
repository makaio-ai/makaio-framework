import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { DiscoveredAIModel } from '@makaio/contracts';
import { OpenAIAgent } from './agent.js';
import { OpenAINodeConnector } from './connector.js';
import { OpenAINodeConnectorNamespace, type OpenAINodeConnectorBus } from './namespaces/index.js';
import { OpenAINodeConfig } from './config.js';
import { MODEL_FETCH_TIMEOUT_MS, OpenAINodeAdapterName } from './constants.js';
import { resolveOpenAIConstructorAuth } from './constructor-auth.js';
import { normalizeOpenAIModels, type RawModelData } from './model-normalization.js';

export { OpenAINodeAdapterName };

/** Typed, credential-free failure when model discovery has no selected API key. */
export class OpenAIModelFetchAuthError extends Error {
  public constructor() {
    super('OpenAI-compatible model discovery requires an explicit API-key selection.');
    this.name = 'OpenAIModelFetchAuthError';
  }
}

/**
 * OpenAI Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * OpenAIAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * OpenAIAgent extends AIAgent
 *     -> creates via connectorFactory()
 * OpenAINodeConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create OpenAIAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new OpenAIAdapter();
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createOpenAINodeAdapter();
 * ```
 */
export class OpenAIAdapter extends AIAdapter<OpenAINodeConnectorBus, OpenAINodeConnector, OpenAIAgent> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: OpenAINodeAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override', 'systemPrompt:append', 'structuredOutput'],
      ...config,
      namespace: OpenAINodeConnectorNamespace,
      agentFactory: (agentConfig) => {
        return new OpenAIAgent(agentConfig);
      },
      configFactory: OpenAINodeConfig.getConfig,
      connectorFactory: (fullConfig) => new OpenAINodeConnector(fullConfig),
      definitionProviders: config?.definitionProviders,
    });
  }

  /**
   * Fetch available models from OpenAI-compatible /v1/models endpoint.
   *
   * Normalizes responses from various providers (OpenAI, NanoGPT, Z.AI, Kimi, etc.)
   * to a consistent AIModel[] format.
   * @param baseUrl - Optional base URL for the provider (defaults to OpenAI)
   * @param auth - Final normalized auth delivery compiled by the trusted host
   * @returns Array of normalized model objects
   * @throws Error if the API request fails
   */
  public async fetchModels(baseUrl: string | undefined, auth: ResolvedAdapterAuth): Promise<DiscoveredAIModel[]> {
    const apiUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/models` : 'https://api.openai.com/v1/models';
    const { apiKey } = resolveOpenAIConstructorAuth(auth);

    if (apiKey === null) {
      throw new OpenAIModelFetchAuthError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models from ${apiUrl}: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { data?: RawModelData[] };

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format from /v1/models endpoint - expected { data: [...] }');
      }

      return normalizeOpenAIModels(data.data);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Failed to fetch models from ${apiUrl}: timed out after ${MODEL_FETCH_TIMEOUT_MS}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Factory function to create and initialize an OpenAI adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Optional adapter configuration
 * @returns Initialized OpenAIAdapter instance
 * @example
 * ```typescript
 * const adapter = await createOpenAINodeAdapter();
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createOpenAINodeAdapter(config?: Partial<AIAdapterConfig>): Promise<OpenAIAdapter> {
  const adapter = new OpenAIAdapter(config);
  await adapter.init();
  return adapter;
}
