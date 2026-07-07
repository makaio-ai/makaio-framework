import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { ClaudeCodeCliConnectorNamespace } from './namespace/index.js';
import type { ClaudeCodeCliConnectorBus } from './namespace/index.js';
import { ClaudeCliConnector } from './connector.js';
import { ClaudeCodeCliConfig } from './config.js';
import type { ClaudeCodeCliAgent } from './agent.js';
import { ClaudeCodeCliAdapterName } from './constants.js';
import { providerIds, testPresetId } from './provider.js';
import { createClaudeCliAdapter } from './adapter.js';

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
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) => {
      const baseConfig = await ClaudeCodeCliConfig.getConfig(
        resolveTestConfig(options, bus, testPreset.provider, testPreset.providers),
      );
      return new ClaudeCliConnector(baseConfig);
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
    testProviderContext: testPreset.providerContext,
  };
};
