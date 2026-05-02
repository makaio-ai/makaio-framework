/**
 * Anthropic SDK Adapter
 *
 * Provides a three-layer adapter implementation for the Anthropic SDK:
 * - AnthropicSdkAdapter: Domain-level adapter, handles adapter.* subjects
 * - AnthropicSdkAgent: Agent wrapper, handles agent.* subjects
 * - AnthropicSdkConnector: SDK connector, handles provider communication
 * @example
 * ```typescript
 * import { AnthropicSdkAdapter, createAnthropicSdkAdapter } from '@makaio/adapter-anthropic-sdk';
 *
 * // Using the class-based adapter
 * const adapter = new AnthropicSdkAdapter();
 * await adapter.init();
 *
 * // Or using the convenience factory
 * const adapter = await createAnthropicSdkAdapter();
 *
 * // Adapter is ready to handle adapter.startAgent RPC via bus
 * // Start agents via MakaioBus.request(AdapterSubjects.startAgent, { adapterId, ... })
 * ```
 * @packageDocumentation
 */

import {
  type ConformanceTestConfig,
  type CreateConformanceTestConfigOptions,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { AnthropicSdkConnector } from './connector.js';
import { AnthropicSdkConnectorNamespace } from './namespaces/index.js';
import { createAnthropicSdkAdapter, AnthropicSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { AnthropicSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

// Core adapter class and factory
export { AnthropicSdkAdapter, createAnthropicSdkAdapter, AnthropicSdkAdapterName } from './adapter.js';

// Middle layer agent class
export { AnthropicSdkAgent } from './agent.js';

// Connector (SDK bridge) class
export { AnthropicSdkConnector } from './connector.js';

// Session and Turn classes for state management
export { AnthropicSdkSession } from './session.js';
export type { AnthropicSdkSessionConfig } from './types/index.js';
export { AnthropicSdkConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace and subjects for bus integration
export {
  AnthropicSdkConnectorNamespace,
  AnthropicSdkConnectorSubjects,
  type SdkEvent,
  type SdkEventMessage,
} from './namespaces/index.js';
import type { AnthropicSdkConnectorBus } from './namespaces/index.js';
export type { AnthropicSdkConnectorBus } from './namespaces/index.js';
import type { AnthropicSdkAgent } from './agent.js';

export { ANTHROPIC_SDK_NAMESPACE } from './types/index.js';

// MakaioExtension descriptor — wraps adapterDefinition in the unified contribution surface
export { anthropicSdkPackage } from './package.js';

/**
 * Creates test configuration for conformance test suite.
 * Sets up scoped bus and tool approval proxy.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Configuration for running conformance tests against this adapter
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
