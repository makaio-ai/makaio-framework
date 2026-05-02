import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { PiSdkNamespace } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import { PiConnector } from './connector.js';
import type { PiAgent } from './agent.js';
import { PiSdkConfig } from './config.js';
import { DEFAULT_TIMEOUTS, PiSdkAdapterName } from './constants.js';
import { providerIds, testPresetId } from './provider.js';
import { createPiSdkAdapter } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Create a conformance test configuration for the Pi SDK adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 *
 * Uses the OpenCode Go gateway (`testPresetId = 'opencode-go'`) to avoid
 * expensive direct API calls during test runs while still exercising the
 * full provider registration, credential resolution, and Pi SDK session flow.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<PiSdkBus, PiConnector, PiAgent>> => {
  const bus = await PiSdkNamespace.scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: PiSdkAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new PiConnector(
        await PiSdkConfig.getConfig(resolveTestConfig(options, bus, testPreset.provider, testPreset.providers)),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
    },
    options: {
      defaultTimeout: DEFAULT_TIMEOUTS.acknowledgement,
      concurrency: 8,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createPiSdkAdapter(options),
    adapterName: PiSdkAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
