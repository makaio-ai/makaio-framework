import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { registerToolApprovalHandler } from '@makaio/ai-adapters-claude-shared';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { createClaudeAdapter, ClaudeCodeAdapterName } from './adapter.js';
import { ClaudeSdkConnector } from './connector.js';
import { ClaudeCodeConnectorNamespace, ClaudeCodeConnectorSubjects } from './namespace/index.js';
import type { ClaudeCodeConnectorBus } from './namespace/index.js';
import type { ClaudeCodeAgent } from './agent.js';
import { createSessionAccountObservationRequester } from './account-observation-requester.js';
import { ClaudeCodeConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

/**
 * Create a test configuration for conformance testing.
 *
 * Sets up tool approval wiring and creates a connector for testing.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns ConformanceTestConfig with agent factory and capabilities
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<ClaudeCodeConnectorBus, ClaudeSdkConnector, ClaudeCodeAgent>> => {
  const { scopedBus } = ClaudeCodeConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: ClaudeCodeAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new ClaudeSdkConnector({
        ...(await ClaudeCodeConfig.getConfig(
          resolveTestConfig(options, bus, testPreset.provider, testPreset.providers),
        )),
        clientId: claudeClientDefinition.id,
        // Conformance tests create `bus` via `Namespace.scopedBus()`, which is a
        // typed view over the same MakaioBus context rather than a separate
        // handler registry. Cross-namespace account observations still need the
        // global client subject, so the requester intentionally targets
        // MakaioBus here.
        requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
      }),
    bus,
    registerToolApprovalHandler: (connector, context, globalBus) =>
      registerToolApprovalHandler(connector, ClaudeCodeConnectorSubjects, context, globalBus),
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
    },
    options: {
      defaultTimeout: 45_000,
      concurrency: 4,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createClaudeAdapter(options),
    adapterName: ClaudeCodeAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
