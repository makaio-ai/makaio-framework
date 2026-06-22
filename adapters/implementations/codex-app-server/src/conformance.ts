import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { CodexAppServerNamespace } from './namespaces/index.js';
import type { CodexAppServerBus } from './namespaces/index.js';
import type { CodexAppServerAgent } from './agent.js';
import { CodexAppServerConnector } from './connector.js';
import { createCodexAppServerAdapter, CodexAppServerAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { CodexAppServerConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

/**
 * Create a conformance test configuration for the Codex App-Server adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<CodexAppServerBus, CodexAppServerConnector, CodexAppServerAgent>> => {
  const { scopedBus } = CodexAppServerNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: CodexAppServerAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (connectorOptions) =>
      new CodexAppServerConnector(
        await CodexAppServerConfig.getConfig(
          resolveTestConfig(connectorOptions, bus, testPreset.provider, testPreset.providers),
        ),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
    },
    options: {
      defaultTimeout: 45_000,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (adapterOptions) => createCodexAppServerAdapter(adapterOptions),
    adapterName: CodexAppServerAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
