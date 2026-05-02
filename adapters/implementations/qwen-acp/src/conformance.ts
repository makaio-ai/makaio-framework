import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { QwenAcpNamespace } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { QwenAcpConnector } from './connector.js';
import type { QwenAcpAgent } from './agent.js';
import { QwenAcpConfig } from './config.js';
import { QwenAcpAdapterName } from './constants.js';
import { providerIds, testPresetId } from './provider.js';
import { createQwenAcpAdapter } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Create a conformance test configuration for the Qwen ACP adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<QwenAcpBus, QwenAcpConnector, QwenAcpAgent>> => {
  const bus = await QwenAcpNamespace.scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: QwenAcpAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
  });

  return {
    createConnector: async (options) =>
      new QwenAcpConnector(
        await QwenAcpConfig.getConfig(resolveTestConfig(options, bus, testPreset.provider, testPreset.providers)),
      ),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true, // CancelNotification only requires sessionId
      supportsUsageMetrics: true, // per-turn tokens from agent_message_chunk._meta.usage
    },
    options: {
      defaultTimeout: 90_000,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createQwenAcpAdapter(options),
    adapterName: QwenAcpAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
