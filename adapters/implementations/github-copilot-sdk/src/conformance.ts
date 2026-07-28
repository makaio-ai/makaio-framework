import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceDefinitionProviders,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { createGitHubCopilotSDKAdapter, GitHubCopilotSdkAdapterName } from './adapter.js';
import { GitHubCopilotConnector } from './connector.js';
import { GitHubCopilotConnectorNamespace } from './namespaces/index.js';
import type { GitHubCopilotConnectorBus } from './namespaces/index.js';
import type { GitHubCopilotAgent } from './agent.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { GitHubCopilotConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';
import { adapterDefinition } from './definition.js';

/**
 * Creates test configuration for conformance testing.
 *
 * Wires tool approval for connector-only testing (without agent layer).
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<GitHubCopilotConnectorBus, GitHubCopilotConnector, GitHubCopilotAgent>> => {
  const bus = await GitHubCopilotConnectorNamespace.scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: GitHubCopilotSdkAdapterName,
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const definitionProviders = resolveConformanceDefinitionProviders({
    adapterName: GitHubCopilotSdkAdapterName,
    providers: testPreset.providers,
    adapterProviders: adapterDefinition.providers,
  });
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<
    GitHubCopilotConnectorBus,
    GitHubCopilotConnector
  >();

  return {
    createConnector: async (options) => {
      const config = await GitHubCopilotConfig.getConfig({
        ...resolveTestConfig(options, bus, testPreset.provider, adapterDefinition.providers),
        globalBus: MakaioBus,
        model: testPreset.primaryModel.modelName,
      });
      return connectorRuntimes.create({
        config,
        connectorFactory: (runtimeConfig) => new GitHubCopilotConnector(runtimeConfig),
      });
    },
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true, // Copilot implements replace delivery mode
      supportsInterrupt: true, // Copilot exposes interrupt() method
    },
    options: {
      concurrency: 4,
      testConcurrency: 3, // Copilot API silently drops responses under concurrent load (inactivity timer handles production)
      defaultTimeout: 120_000, // 120 seconds for API calls (Copilot can be slow)
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    // No clientId, although the manifest declares the `github-copilot` client.
    // Presenting one makes the auth runtime acquire a client config lease over a
    // non-optional `client.sessionConfig.create` request, so a config may only do
    // it while owning a fixture that serves that subject — which is why Claude and
    // Codex pair their clientId with a session-config fixture and this one has
    // none to pair. Nothing here would earn that cost: this preset binds a
    // provider-owned method, and `@makaio/client-github-copilot` registers no
    // `sessionConfig.setup` handler, so the lease would contribute an empty env.
    // The unset id stays inert downstream — `clientId` is optional on the agent
    // event schema, and the default harness lookup falls back to the
    // adapter-scoped default either way.
    createAdapter: async (options) => createGitHubCopilotSDKAdapter({ ...options, definitionProviders }),
    adapterName: GitHubCopilotSdkAdapterName,
    testProviderContext: testPreset.providerContext,
    cleanup: () => connectorRuntimes.closeAll(),
  };
};
