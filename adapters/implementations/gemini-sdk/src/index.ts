/**
 * Gemini SDK Adapter
 *
 * Package: `@makaio/adapter-gemini-sdk`
 *
 * Provides standardized interface for Gemini SDK interactions
 * in the Makaio AI framework using the three-layer architecture.
 *
 * Architecture:
 * - GeminiAdapter (AIAdapter) - Factory for creating agents
 * - GeminiAgent (AIAgent) - Middle layer, wires events to global bus
 * - GeminiConnector (AIAgentConnector) - SDK-level bridge
 */

import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { GeminiConnector } from './connector.js';
import { GeminiConnectorNamespace } from './namespaces/index.js';
import { createGeminiSDKAdapter, GeminiSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { GeminiSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

// Adapter exports
export { createGeminiSDKAdapter, GeminiSdkAdapterName, GeminiAdapter } from './adapter.js';

// Agent exports (three-layer architecture)
export { GeminiAgent } from './agent.js';
export { GeminiConnector, GeminiConnector as GeminiAgentLegacy } from './connector.js';

// Session/Turn abstractions (for prompt cache preservation pattern)
export { GeminiConnectorSession } from './session.js';
export { GeminiConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace exports
export { GeminiConnectorNamespace, GeminiConnectorSubjects } from './namespaces/index.js';
import type { GeminiConnectorBus } from './namespaces/index.js';
import type { GeminiAgent } from './agent.js';

// eslint-disable-next-line no-restricted-syntax -- type-only wildcard
export type * from './namespaces/index.js';

// Session types
export type {
  GeminiAgentMetadata,
  GeminiConnectorConfig,
  GeminiAgentConnectorConfig,
  GeminiSessionConfig,
} from './types/index.js';

// Re-export core types for convenience
export type { AIAdapterPromptOptions, AIAdapterPromptResult } from '@makaio/ai-adapters-core';

// Export schemas
export { GeminiSdkProviderConfigSchema, type GeminiSdkProviderSettings } from './schemas.js';

// Tool handling utilities
export {
  toGlobalToolApproval,
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  requestToolApproval,
  type ToolApprovalContext,
} from './tool-handling.js';

/**
 * Create test configuration for conformance tests.
 * Uses GeminiConnector directly for isolated testing.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Configuration for conformance testing
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<GeminiConnectorBus, GeminiConnector, GeminiAgent>> => {
  const { scopedBus } = GeminiConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: GeminiSdkAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new GeminiConnector(
        await GeminiSdkConfig.getConfig(resolveTestConfig(options, bus, testPreset.provider, testPreset.providers)),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
    },
    options: {
      defaultTimeout: 90_000, // because of Gemini's rate limits
      testConcurrency: 3, // Gemini's rate limits don't handle concurrent tests well
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createGeminiSDKAdapter(options),
    adapterName: GeminiSdkAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
