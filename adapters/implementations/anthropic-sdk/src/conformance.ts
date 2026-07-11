import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { AnthropicSdkConnector } from './connector.js';
import { AnthropicSdkConnectorNamespace } from './namespaces/index.js';
import type { AnthropicSdkConnectorBus } from './namespaces/index.js';
import type { AnthropicSdkAgent } from './agent.js';
import { createAnthropicSdkAdapter, AnthropicSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { AnthropicSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';
import { adapterDefinition } from './definition.js';

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
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<AnthropicSdkConnectorBus, AnthropicSdkConnector>();

  return {
    createConnector: async (options) => {
      const config = await AnthropicSdkConfig.getConfig({
        ...resolveTestConfig(options, bus, testPreset.provider, adapterDefinition.providers),
        globalBus: MakaioBus,
      });
      return connectorRuntimes.create({
        config,
        connectorFactory: (runtimeConfig) => new AnthropicSdkConnector(runtimeConfig),
      });
    },
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
    cleanup: () => connectorRuntimes.closeAll(),
  };
};
