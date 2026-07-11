import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import {
  ConformanceConnectorRuntimeRegistry,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import {
  acquireClaudeConformanceSessionConfigFixture,
  closeClaudeConformanceConnectorRuntimes,
  createClaudeConformanceProviderContext,
} from '@makaio/ai-adapters-claude-process-shared/testing';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { ClaudeCodeCliConnectorNamespace } from './namespace/index.js';
import type { ClaudeCodeCliConnectorBus } from './namespace/index.js';
import { ClaudeCliConnector } from './connector.js';
import { ClaudeCodeCliConfig } from './config.js';
import type { ClaudeCodeCliAgent } from './agent.js';
import { ClaudeCodeCliAdapterName } from './constants.js';
import { providerIds, testPresetId } from './provider.js';
import { createClaudeCliAdapter } from './adapter.js';
import { adapterDefinition } from './definition.js';

/**
 * Create a test configuration for conformance testing.
 *
 * MCP integration uses bus RPC to `McpSubjects.session.register` with graceful
 * degradation: when no bridge service handler is registered, `requestOptional`
 * returns `{ handled: false }` and MCP config is omitted for that turn. Tests
 * that require MCP tool approval should register a `McpServerBridgeService` (or
 * a mock handler on `McpSubjects.session.register`) before running.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns ConformanceTestConfig with connector factory and adapter factory
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<ClaudeCodeCliConnectorBus, ClaudeCliConnector, ClaudeCodeCliAgent>> => {
  const { scopedBus } = ClaudeCodeCliConnectorNamespace;
  const bus = await scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: ClaudeCodeCliAdapterName,
    testProviderDefinitionId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });
  const testProviderContext = createClaudeConformanceProviderContext(testPreset.provider);
  const sessionConfigFixture = await acquireClaudeConformanceSessionConfigFixture();
  const connectorRuntimes = new ConformanceConnectorRuntimeRegistry<ClaudeCodeCliConnectorBus, ClaudeCliConnector>();

  return {
    createConnector: async (options) => {
      const providerContext = options?.providerContext ?? testProviderContext;
      const config = await ClaudeCodeCliConfig.getConfig({
        ...resolveTestConfig({ ...options, providerContext }, bus, testPreset.provider, adapterDefinition.providers),
        providerContextRequired: true,
        clientId: claudeClientDefinition.id,
        globalBus: MakaioBus,
      });
      return connectorRuntimes.create({
        config,
        connectorFactory: (resolvedConfig) => new ClaudeCliConnector(resolvedConfig),
      });
    },
    bus,
    // Tool approval for CLI flows through the MCP server → global AgentSubjects.toolApprove bus.
    // The MCP server already routes approval requests to the global bus, so no additional
    // bridging is needed here. Tests register their own handlers on AgentSubjects.toolApprove.
    registerToolApprovalHandler: (_connector, _context) => () => {},
    capabilities: {
      supportsReplace: false,
      supportsInterrupt: false,
      nativeResume: true,
      nativeFork: true,
    },
    options: {
      defaultTimeout: 60_000,
      concurrency: 2,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (adapterOptions) => createClaudeCliAdapter(adapterOptions),
    adapterName: ClaudeCodeCliAdapterName,
    testProviderContext,
    cleanup: () => closeClaudeConformanceConnectorRuntimes(() => connectorRuntimes.closeAll(), sessionConfigFixture),
  };
};
