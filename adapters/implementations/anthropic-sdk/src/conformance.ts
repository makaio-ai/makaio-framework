import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { AnthropicSdkConnector } from './connector.js';
import { AnthropicSdkConnectorNamespace } from './namespaces/index.js';
import type { AnthropicSdkConnectorBus } from './namespaces/index.js';
import type { AnthropicSdkAgent } from './agent.js';
import { createAnthropicSdkAdapter, AnthropicSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { AnthropicSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

/**
 * Create a conformance test configuration for the Anthropic SDK adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<AnthropicSdkConnectorBus, AnthropicSdkConnector, AnthropicSdkAgent>> => {
  const { scopedBus } = AnthropicSdkConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: AnthropicSdkAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new AnthropicSdkConnector(
        await AnthropicSdkConfig.getConfig(resolveTestConfig(options, bus, testPreset.provider, testPreset.providers)),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true, // Implements replace delivery mode via base class
      supportsInterrupt: true, // Exposes interrupt() method
      supportsUsageMetrics: true, // Tracks usage via stream events
    },
    options: {
      defaultTimeout: 90_000,
      concurrency: 8,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createAnthropicSdkAdapter({ adapterId: options?.adapterId }),
    adapterName: AnthropicSdkAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
