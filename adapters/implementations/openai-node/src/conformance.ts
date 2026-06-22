import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { OpenAINodeConnector } from './connector.js';
import { OpenAINodeConnectorNamespace } from './namespaces/index.js';
import type { OpenAINodeConnectorBus } from './namespaces/index.js';
import type { OpenAIAgent } from './agent.js';
import { createOpenAINodeAdapter, OpenAINodeAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { OpenAINodeConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

/**
 * Create a conformance test configuration for the OpenAI Node adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<OpenAINodeConnectorBus, OpenAINodeConnector, OpenAIAgent>> => {
  const { scopedBus } = OpenAINodeConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: OpenAINodeAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new OpenAINodeConnector(
        await OpenAINodeConfig.getConfig(resolveTestConfig(options, bus, testPreset.provider, testPreset.providers)),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true, // Implements replace delivery mode via base class
      supportsInterrupt: true, // Exposes interrupt() method
      supportsUsageMetrics: true, // Tracks usage via stream_options
    },
    options: {
      defaultTimeout: 90_000,
      concurrency: 8,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createOpenAINodeAdapter({ adapterId: options?.adapterId }),
    adapterName: OpenAINodeAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
