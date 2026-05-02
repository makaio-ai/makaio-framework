import type { ConformanceTestConfig } from '@makaio/ai-adapters-core';
import { resolveTestConfig, createTestProviderContext } from '@makaio/ai-adapters-core';
import { QwenAcpNamespace } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { QwenAcpConnector } from './connector.js';
import type { QwenAcpAgent } from './agent.js';
import { QwenAcpConfig } from './config.js';
import { QwenAcpAdapterName } from './constants.js';
// Test-only import — not part of the distributable adapter
import { providerDefinition as testProviderDef } from '@makaio/provider-qwen-acp';
import { createQwenAcpAdapter } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Create a conformance test configuration for the Qwen ACP adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (): Promise<
  ConformanceTestConfig<QwenAcpBus, QwenAcpConnector, QwenAcpAgent>
> => {
  const bus = await QwenAcpNamespace.scopedBus();
  if (!testProviderDef.defaultModel) {
    throw new Error(`[qwen-acp] Invalid test provider definition '${testProviderDef.id}': missing defaultModel`);
  }
  const primaryModelName = testProviderDef.fastModel ?? testProviderDef.defaultModel;

  return {
    createConnector: async (options) =>
      new QwenAcpConnector(await QwenAcpConfig.getConfig(resolveTestConfig(options, bus, testProviderDef))),
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true, // CancelNotification only requires sessionId
      supportsUsageMetrics: true, // per-turn tokens from agent_message_chunk._meta.usage
    },
    options: {
      defaultTimeout: 90_000,
      primaryModel: {
        definitionId: testProviderDef.id,
        modelName: primaryModelName,
      },
    },
    createAdapter: async (options) => createQwenAcpAdapter(options),
    adapterName: QwenAcpAdapterName,
    testProviderContext: createTestProviderContext(testProviderDef),
  };
};
