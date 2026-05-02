/**
 * Claude Code AI Adapter
 *
 * Provides integration with the Claude Code Agent SDK using the three-layer architecture:
 * - ClaudeCodeAdapter: Domain-level adapter extending AIAdapter
 * - ClaudeCodeAgent: AIAgent subclass that wires connector events to global subjects
 * - ClaudeSdkConnector: SDK-level bridge to Claude Agent SDK
 *
 * Emits granular, type-safe events for all SDK message types.
 */

import { ClaudeSdkConnector } from './connector.js';
import { type ConformanceTestConfig, resolveTestConfig, createTestProviderContext } from '@makaio/ai-adapters-core';
import { ClaudeCodeConnectorNamespace, ClaudeCodeConnectorSubjects } from './namespace/index.js';
import { createClaudeAdapter, ClaudeCodeAdapterName } from './adapter.js';
import { registerToolApprovalHandler } from '@makaio/ai-adapters-claude-shared';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { createSessionAccountObservationRequester } from './account-observation-requester.js';
import { ClaudeCodeConfig } from './config.js';
// Test-only import — not part of the distributable adapter
import { providerDefinition as testProviderDef } from '@makaio/provider-anthropic';

// Export the adapter class and factory
export {
  createClaudeAdapter,
  ClaudeCodeAdapterName,
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterConfig,
} from './adapter.js';

// Export the agent class
export { ClaudeCodeAgent } from './agent.js';

// Export the connector class
export { ClaudeSdkConnector } from './connector.js';

// Export namespace and subjects
export { ClaudeCodeConnectorSubjects, ClaudeCodeConnectorNamespace } from './namespace/index.js';
import type { ClaudeCodeConnectorBus } from './namespace/index.js';
export type { ClaudeCodeConnectorBus } from './namespace/index.js';
import type { ClaudeCodeAgent } from './agent.js';

// Export types
export type { ClaudeAgentConfig } from './types/index.js';
export { ClaudeAccountObservationEmitter, normalizeClaudeAccountObservationPayload } from './account-observation.js';
export type { ClaudeAccountObservationPayload, ClaudeObservedAccountInfo } from './account-observation.js';

// Export schemas
export { ClaudeCodeProviderConfigSchema, type ClaudeCodeProviderConfig } from './schemas.js';

// Tool handling utilities
export {
  toGlobalToolApproval,
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  requestToolApproval,
  type ToolApprovalContext,
  type ClaudePermissionResult,
} from '@makaio/ai-adapters-claude-shared';

// Type-safe content block handlers
export { CONTENT_BLOCK_HANDLERS } from '@makaio/ai-adapters-claude-shared';

export { UserMessageQueue } from '@makaio/ai-adapters-core';
export { ClaudeConnectorTurn, type ClaudeTurnState } from './turn.js';

/**
 * Create a test configuration for conformance testing.
 * Sets up tool approval wiring and creates a connector for testing.
 * @returns ConformanceTestConfig with agent factory and capabilities
 */
export const createTestConfig = async (): Promise<
  ConformanceTestConfig<ClaudeCodeConnectorBus, ClaudeSdkConnector, ClaudeCodeAgent>
> => {
  const { scopedBus } = ClaudeCodeConnectorNamespace;
  const bus = await scopedBus();

  if (!testProviderDef.defaultModel) {
    throw new Error(`[claude-code] Invalid test provider definition '${testProviderDef.id}': missing defaultModel`);
  }
  const primaryModelName = testProviderDef.fastModel ?? testProviderDef.defaultModel;

  return {
    createConnector: async (options) =>
      new ClaudeSdkConnector({
        ...(await ClaudeCodeConfig.getConfig(resolveTestConfig(options, bus, testProviderDef))),
        clientId: claudeClientDefinition.id,
        // Conformance tests create `bus` via `Namespace.scopedBus()`, which is a
        // typed view over the same MakaioBus context rather than a separate
        // handler registry. Cross-namespace account observations still need the
        // global client subject, so the requester intentionally targets
        // MakaioBus here.
        requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
      }),
    bus,
    registerToolApprovalHandler: (connector, context) =>
      registerToolApprovalHandler(connector, ClaudeCodeConnectorSubjects, context),
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
    },
    options: {
      defaultTimeout: 45_000,
      concurrency: 4,
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
    createAdapter: async (options) => createClaudeAdapter(options),
    adapterName: ClaudeCodeAdapterName,
    testProviderContext: createTestProviderContext(testProviderDef),
  };
};
