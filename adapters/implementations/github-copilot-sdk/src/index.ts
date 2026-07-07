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
export type { GitHubCopilotConnectorBus } from './namespaces/index.js';

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
  TurnStartMode,
} from './event-normalizers.js';
