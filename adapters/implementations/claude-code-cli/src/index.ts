/**
 * Claude Code CLI AI Adapter
 *
 * Provides integration with Claude via the `claude` CLI binary using
 * stdio JSON streaming instead of the Agent SDK.
 *
 * Architecture (three-layer):
 * - ClaudeCodeCliAdapter: Domain-level adapter extending AIAdapter
 * - ClaudeCodeCliAgent: AIAgent subclass that wires connector events to global subjects
 * - ClaudeCliConnector: Spawns `claude -p` processes and consumes JSONL stdout
 *
 * The CLI emits identical event shapes to the SDK — the shared claude-shared
 * namespace schemas describe them exactly — so the shared agent base class
 * handles all event routing without modification.
 *
 * MCP integration is handled via bus RPC to `McpSubjects.session.register` /
 * `McpSubjects.session.unregister`. The singleton HTTP MCP server is managed
 * by `McpServerBridgeService` — the adapter is a pure consumer.
 */

import { resolveTestConfig, createTestProviderContext } from '@makaio/ai-adapters-core';
import type { ConformanceTestConfig } from '@makaio/ai-adapters-core';
import { ClaudeCodeCliConnectorNamespace } from './namespace/index.js';
import type { ClaudeCodeCliConnectorBus } from './namespace/index.js';
import { ClaudeCliConnector } from './connector.js';
import { ClaudeCodeCliConfig } from './config.js';
import type { ClaudeCodeCliAgent } from './agent.js';
import { ClaudeCodeCliAdapterName } from './constants.js';
// Test-only import — not part of the distributable adapter
import { providerDefinition as testProviderDef } from '@makaio/provider-anthropic';
import { createClaudeCliAdapter } from './adapter.js';

// Adapter class and factory
export {
  ClaudeCodeCliAdapter,
  createClaudeCliAdapter,
  ClaudeCodeCliAdapterName,
  type ClaudeCodeCliAdapterConfig,
} from './adapter.js';

// Agent class
export { ClaudeCodeCliAgent } from './agent.js';

// Connector class
export { ClaudeCliConnector } from './connector.js';

// Namespace and subjects
export {
  ClaudeCodeCliConnectorSubjects,
  ClaudeCodeCliConnectorNamespace,
  type ClaudeCodeCliConnectorBus,
} from './namespace/index.js';

// Types
export type { ClaudeCliAgentConfig } from './types.js';

// Schemas
export { ClaudeCodeCliProviderConfigSchema, type ClaudeCodeCliProviderConfig } from './schemas.js';

/**
 * Create a test configuration for conformance testing.
 *
 * MCP integration uses bus RPC to `McpSubjects.session.register` with graceful
 * degradation: when no bridge service handler is registered, `requestOptional`
 * returns `{ handled: false }` and MCP config is omitted for that turn. Tests
 * that require MCP tool approval should register a `McpServerBridgeService` (or
 * a mock handler on `McpSubjects.session.register`) before running.
 * @returns ConformanceTestConfig with connector factory and adapter factory
 */
export const createTestConfig = async (): Promise<
  ConformanceTestConfig<ClaudeCodeCliConnectorBus, ClaudeCliConnector, ClaudeCodeCliAgent>
> => {
  const { scopedBus } = ClaudeCodeCliConnectorNamespace;
  const bus = await scopedBus();

  if (!testProviderDef.defaultModel) {
    throw new Error(`[claude-code-cli] Invalid test provider definition '${testProviderDef.id}': missing defaultModel`);
  }
  const primaryModelName = testProviderDef.fastModel ?? testProviderDef.defaultModel;

  return {
    createConnector: async (options) => {
      const baseConfig = await ClaudeCodeCliConfig.getConfig(resolveTestConfig(options, bus, testProviderDef));
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
    },
    options: {
      defaultTimeout: 60_000,
      concurrency: 2,
      primaryModel: {
        definitionId: testProviderDef.id,
        modelName: primaryModelName,
        reasoningEffort: 'low',
      },
      secondaryModel: {
        definitionId: testProviderDef.id,
        modelName: testProviderDef.defaultModel,
        reasoningEffort: 'low',
      },
    },
    createAdapter: async (adapterOptions) => createClaudeCliAdapter(adapterOptions),
    adapterName: ClaudeCodeCliAdapterName,
    testProviderContext: createTestProviderContext(testProviderDef),
  };
};
