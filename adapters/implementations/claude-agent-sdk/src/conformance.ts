import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { registerToolApprovalHandler } from '@makaio/ai-adapters-claude-shared';
import {
  acquireClaudeConformanceSessionConfigFixture,
  closeClaudeConformanceConnectorRuntimes,
  createClaudeConformanceProviderContext,
} from '@makaio/ai-adapters-claude-process-shared/testing';
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
import { adapterDefinition } from './definition.js';

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
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const testProviderContext = createClaudeConformanceProviderContext(testPreset.provider);
  const sessionConfigFixture = await acquireClaudeConformanceSessionConfigFixture();
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<ClaudeCodeConnectorBus, ClaudeSdkConnector>();

  return {
    createConnector: async (options) => {
      const providerContext = options?.providerContext ?? testProviderContext;
      const config = await ClaudeCodeConfig.getConfig({
        ...resolveTestConfig({ ...options, providerContext }, bus, testPreset.provider, adapterDefinition.providers),
        providerContextRequired: true,
        clientId: claudeClientDefinition.id,
        globalBus: MakaioBus,
      });
      return connectorRuntimes.create({
        config,
        connectorFactory: (resolvedConfig) =>
          new ClaudeSdkConnector({
            ...resolvedConfig,
            // Conformance tests create `bus` via `Namespace.scopedBus()`, which is a
            // typed view over the same MakaioBus context rather than a separate
            // handler registry. Cross-namespace account observations still need the
            // global client subject, so the requester intentionally targets MakaioBus.
            requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
          }),
      });
    },
    bus,
    registerToolApprovalHandler: (connector, context, globalBus) =>
      registerToolApprovalHandler(connector, ClaudeCodeConnectorSubjects, context, globalBus),
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      nativeResume: true,
      nativeFork: true,
    },
    options: {
      defaultTimeout: 45_000,
      concurrency: 4,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (options) => createClaudeAdapter(options),
    adapterName: ClaudeCodeAdapterName,
    testProviderContext,
    cleanup: () => closeClaudeConformanceConnectorRuntimes(() => connectorRuntimes.closeAll(), sessionConfigFixture),
  };
};
