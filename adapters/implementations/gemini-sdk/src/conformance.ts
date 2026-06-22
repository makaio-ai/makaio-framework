import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { GeminiConnector } from './connector.js';
import { GeminiConnectorNamespace } from './namespaces/index.js';
import type { GeminiConnectorBus } from './namespaces/index.js';
import type { GeminiAgent } from './agent.js';
import { createGeminiSDKAdapter, GeminiSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { GeminiSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

/**
 * Create a conformance test configuration for the Gemini SDK adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
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
