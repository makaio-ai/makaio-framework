/**
 * OpenAI Node Adapter
 *
 * Provides a three-layer adapter implementation for the OpenAI SDK:
 * - OpenAIAdapter: Domain-level adapter, handles adapter.* subjects
 * - OpenAIAgent: Agent wrapper, handles agent.* subjects
 * - OpenAINodeAgent: SDK connector, handles provider communication
 * @example
 * ```typescript
 * import { OpenAIAdapter, createOpenAINodeAdapter } from '@makaio/adapter-openai-node';
 *
 * // Using the class-based adapter
 * const adapter = new OpenAIAdapter();
 * await adapter.init();
 *
 * // Or using the convenience factory
 * const adapter = await createOpenAINodeAdapter();
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
import { OpenAINodeConnector } from './connector.js';
import { OpenAINodeConnectorNamespace } from './namespaces/index.js';
import { createOpenAINodeAdapter, OpenAINodeAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { OpenAINodeConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

// Core adapter class and factory
export { OpenAIAdapter, createOpenAINodeAdapter, OpenAINodeAdapterName } from './adapter.js';

// Middle layer agent class
export { OpenAIAgent } from './agent.js';

// Connector (SDK bridge) class
export { OpenAINodeConnector } from './connector.js';

// Session and Turn classes for state management
export { OpenAIConnectorSession } from './session.js';
export type { OpenAISessionConfig } from './types/index.js';
export { OpenAIConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace and subjects for bus integration
export { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects, type SdkEvent } from './namespaces/index.js';
import type { OpenAINodeConnectorBus } from './namespaces/index.js';
export type { OpenAINodeConnectorBus } from './namespaces/index.js';
import type { OpenAIAgent } from './agent.js';

export { OPENAI_NODE_NAMESPACE } from './types/index.js';

/**
 * Creates test configuration for conformance test suite.
 * Sets up scoped bus and tool approval proxy.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Configuration for running conformance tests against this adapter
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
