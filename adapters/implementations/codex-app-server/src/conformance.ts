import type {
  BaseAgentConnectorConfig,
  ConformanceTestConfig,
  CreateConformanceTestConfigOptions,
} from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceDefinitionProviders,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import {
  prepareAdapterAuthRuntime,
  type BoundAdapterRuntimeConfig,
  type PreparedAdapterAuthRuntime,
} from '@makaio/ai-adapters-core/config';
import { MakaioBus, type ScopedBus } from '@makaio/bus-core';
import { CodexAppServerNamespace } from './namespaces/index.js';
import type { CodexAppServerBus } from './namespaces/index.js';
import type { CodexAppServerAgent } from './agent.js';
import { CodexAppServerConnector } from './connector.js';
import { createCodexAppServerAdapter, CodexAppServerAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { CodexAppServerConfig } from './config.js';
import { clientDefinition as codexClientDefinition } from '@makaio/client-codex';
import { providerIds, testPresetId } from './provider.js';
import { adapterDefinition } from './definition.js';
import {
  acquireCodexConformanceSessionConfigFixture,
  closeCodexConformanceResources,
} from './test/session-config-fixture.js';

/** Prepare auth through the production seam while retaining the trusted host PATH for global binary discovery.
 * @param config - Bound conformance connector configuration
 * @returns Prepared connector configuration and its owned client lease
 */
async function prepareConformanceAuthRuntime<
  TBus extends ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus>,
>(config: BoundAdapterRuntimeConfig<TBus, TConfig>): Promise<PreparedAdapterAuthRuntime<TBus, TConfig>> {
  const prepared = await prepareAdapterAuthRuntime(config);
  const hostPath = process.env.PATH;
  if (!hostPath) throw new Error('Codex conformance requires a non-empty host PATH');
  return { ...prepared, config: { ...prepared.config, env: { ...prepared.config.env, PATH: hostPath } } };
}

/**
 * Client identity backing conformance authentication for this adapter.
 *
 * Both the connector and the adapter must present the same client, or the
 * client-owned authentication binding is rejected as belonging to someone else.
 */
const CODEX_CONFORMANCE_CLIENT_ID = codexClientDefinition.id;

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
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const sessionConfigFixture = await acquireCodexConformanceSessionConfigFixture();
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<CodexAppServerBus, CodexAppServerConnector>();
  const definitionProviders = resolveConformanceDefinitionProviders({
    adapterName: CodexAppServerAdapterName,
    providers: testPreset.providers,
    adapterProviders: adapterDefinition.providers,
  });

  return {
    createConnector: async (connectorOptions) => {
      const config = await CodexAppServerConfig.getConfig({
        ...resolveTestConfig(connectorOptions, bus, testPreset.provider, adapterDefinition.providers),
        providerContextRequired: true,
        clientId: CODEX_CONFORMANCE_CLIENT_ID,
        globalBus: MakaioBus,
      });
      return connectorRuntimes.create({
        config,
        prepareAuthRuntime: prepareConformanceAuthRuntime,
        connectorFactory: (runtimeConfig) => new CodexAppServerConnector(runtimeConfig),
      });
    },
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
      nativeResume: true,
      nativeFork: true,
    },
    options: {
      defaultTimeout: 45_000,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (adapterOptions) =>
      createCodexAppServerAdapter({
        ...adapterOptions,
        definitionProviders,
        clientId: CODEX_CONFORMANCE_CLIENT_ID,
        prepareAuthRuntime: prepareConformanceAuthRuntime,
      }),
    adapterName: CodexAppServerAdapterName,
    testProviderContext: testPreset.providerContext,
    cleanup: () => closeCodexConformanceResources(() => connectorRuntimes.closeAll(), sessionConfigFixture),
  };
};
