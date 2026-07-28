import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceDefinitionProviders,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { GeminiConnector } from './connector.js';
import { GeminiConnectorNamespace } from './namespaces/index.js';
import type { GeminiConnectorBus } from './namespaces/index.js';
import type { GeminiAgent } from './agent.js';
import { createGeminiSDKAdapter, GeminiSdkAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { GeminiSdkConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';
import { adapterDefinition } from './definition.js';

/**
 * Create a conformance test configuration for the Gemini SDK adapter.
 *
 * Used by the shared conformance test suite to exercise this adapter's
 * connector, bus event routing, and full adapter lifecycle.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<GeminiConnectorBus, GeminiConnector, GeminiAgent>> => {
  const { scopedBus } = GeminiConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: GeminiSdkAdapterName,
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const definitionProviders = resolveConformanceDefinitionProviders({
    adapterName: GeminiSdkAdapterName,
    providers: testPreset.providers,
    adapterProviders: adapterDefinition.providers,
  });
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<GeminiConnectorBus, GeminiConnector>();

  return {
    createConnector: async (options) => {
      const config = await GeminiSdkConfig.getConfig({
        ...resolveTestConfig(options, bus, testPreset.provider, adapterDefinition.providers),
        globalBus: MakaioBus,
      });
      return connectorRuntimes.create({
        config,
        connectorFactory: (runtimeConfig) => new GeminiConnector(runtimeConfig),
      });
    },
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
    },
    options: {
      defaultTimeout: 90_000, // because of Gemini's rate limits
      testConcurrency: 3, // Gemini's rate limits don't handle concurrent tests well
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    // No clientId, although the manifest declares the `gemini` client. Presenting
    // one makes the auth runtime acquire a client config lease over a
    // non-optional `client.sessionConfig.create` request, so a config may only do
    // it while owning a fixture that serves that subject — which is why Claude and
    // Codex pair their clientId with a session-config fixture and this one has
    // none to pair. Nothing here would earn that cost: this preset binds a
    // provider-owned method, and `@makaio/client-gemini` registers no
    // `sessionConfig.setup` handler, so the lease would contribute an empty env.
    // The unset id stays inert downstream — `clientId` is optional on the agent
    // event schema, and the client-scoped harness lookup in `connector.ts` falls
    // back to the adapter-scoped default either way.
    createAdapter: async (options) => createGeminiSDKAdapter({ ...options, definitionProviders }),
    adapterName: GeminiSdkAdapterName,
    testProviderContext: testPreset.providerContext,
    cleanup: () => connectorRuntimes.closeAll(),
  };
};
