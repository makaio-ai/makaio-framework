import type { ConformanceTestConfig } from '@makaio/ai-adapters-core';
import { resolveTestConfig, createTestProviderContext } from '@makaio/ai-adapters-core';
import { PiSdkNamespace } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import { PiConnector } from './connector.js';
import type { PiAgent } from './agent.js';
import { PiSdkConfig } from './config.js';
import { DEFAULT_TIMEOUTS, PiSdkAdapterName } from './constants.js';
import { testPresetId } from './provider.js';
import { createPiSdkAdapter } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
// Test-only import — not part of the distributable adapter runtime entrypoint.
import { openaiProviderDefinition as testProviderDef } from '@makaio/provider-opencode-go';

/**
 * Create a conformance test configuration for the Pi SDK adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 *
 * Uses the OpenCode Go gateway (`testPresetId = 'opencode-go'`) to avoid
 * expensive direct API calls during test runs while still exercising the
 * full provider registration, credential resolution, and Pi SDK session flow.
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (): Promise<ConformanceTestConfig<PiSdkBus, PiConnector, PiAgent>> => {
  const bus = await PiSdkNamespace.scopedBus();
  if (!testProviderDef?.defaultModel) {
    throw new Error(`[pi-sdk] Invalid test provider definition '${testPresetId}': missing defaultModel`);
  }
  const primaryModelName = testProviderDef.fastModel ?? testProviderDef.defaultModel;

  return {
    createConnector: async (options) =>
      new PiConnector(await PiSdkConfig.getConfig(resolveTestConfig(options, bus, testProviderDef))),
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
      primaryModel: {
        definitionId: testPresetId,
        modelName: primaryModelName,
        reasoningEffort: 'low',
      },
      secondaryModel: {
        definitionId: testPresetId,
        modelName: testProviderDef.defaultModel,
        reasoningEffort: 'low',
      },
    },
    createAdapter: async (options) => createPiSdkAdapter(options),
    adapterName: PiSdkAdapterName,
    testProviderContext: createTestProviderContext(testProviderDef),
  };
};
