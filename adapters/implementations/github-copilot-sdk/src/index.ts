import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { createGitHubCopilotSDKAdapter, GitHubCopilotSdkAdapterName } from './adapter.js';
import { GitHubCopilotConnector } from './connector.js';
import { GitHubCopilotConnectorNamespace } from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { GitHubCopilotConfig } from './config.js';
import { providerIds, testPresetId } from './provider.js';

// Adapter class and factory
export { GitHubCopilotAdapter, createGitHubCopilotSDKAdapter, GitHubCopilotSdkAdapterName } from './adapter.js';

// Agent class (middle layer)
export { GitHubCopilotAgent } from './agent.js';

// Connector class (SDK bridge)
export { GitHubCopilotConnector } from './connector.js';

// Session/Turn architecture
export { CopilotConnectorSession } from './session.js';
export type { CopilotSessionConfig } from './types';

export { CopilotConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespaces and subjects
export { GitHubCopilotConnectorNamespace, GitHubCopilotConnectorSubjects } from './namespaces/index.js';
import type { GitHubCopilotConnectorBus } from './namespaces/index.js';
export type { GitHubCopilotConnectorBus } from './namespaces/index.js';
import type { GitHubCopilotAgent } from './agent.js';

// Types
export type {
  CopilotSessionOptions,
  ConsumptionCompleteResult,
  GitHubCopilotAgentConnectorConfig,
} from './types/index.js';

// Export schemas
export { GitHubCopilotSdkProviderConfigSchema, type GitHubCopilotSdkProviderSettings } from './schemas.js';

// Tool handling utilities
export {
  toGlobalToolApproval,
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  requestToolApproval,
  mapPermissionRequestToCoreRequest,
  mapCoreResponseToPermissionResult,
  toCopilotToolFormat,
  fetchToolsForCopilot,
  type ToolApprovalContext,
  type CopilotToolHandlerContext,
} from './tool-handling.js';

// Event normalizers for log import
export {
  normalizeAssistantMessage,
  normalizeAssistantTurnEnd,
  normalizeAssistantTurnStart,
  normalizeGitHubCopilotLogRecord,
  normalizeSessionError,
  normalizeSessionTruncation,
  normalizeToolExecutionComplete,
  normalizeToolExecutionPartialResult,
  normalizeToolExecutionStart,
  normalizeToolUserRequested,
  normalizeUserMessage,
} from './event-normalizers.js';
export type {
  NormalizationContext,
  NormalizeOptions,
  RawGitHubCopilotLogRecord,
  ToolNameResolver,
} from './event-normalizers.js';

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
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  return {
    createConnector: async (options) =>
      new GitHubCopilotConnector(
        await GitHubCopilotConfig.getConfig({
          ...resolveTestConfig(options, bus, testPreset.provider, testPreset.providers),
          model: testPreset.primaryModel.modelName,
        }),
      ),
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
    createAdapter: async (options) => createGitHubCopilotSDKAdapter(options),
    adapterName: GitHubCopilotSdkAdapterName,
    testProviderContext: testPreset.providerContext,
  };
};
