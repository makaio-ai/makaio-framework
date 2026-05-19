export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKAssistantMessagePayload,
  SDKAssistantMessageError,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKToolResultMessage,
  SDKUsage,
  ModelUsage,
  SDKPermissionDenial,
  SDKMessageOrigin,
  SDKToolProgressMessage,
  SDKStatus,
  SDKStatusMessage,
  SDKSessionStateChangedMessage,
  ApiKeySource,
  PermissionMode,
  FastModeState,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  TextCitation,
  ModelInfo,
  AccountInfo,
  McpServerStatus,
  SlashCommand,
  PermissionResult,
  CanUseToolCallback,
  MakaioOptions,
  McpServerConfig,
  McpSdkServerConfig,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
  CreateSdkMcpServerOptions,
  QueryParams,
  StartupParams,
  MakaioToolDefinition,
  MakaioQuery,
  SDKSessionInfo,
  SessionMessage,
  ListSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
} from './types.js';

export {
  MakaioCredentialError,
  MakaioConnectionError,
  MakaioModelError,
  MakaioUnsupportedFeatureError,
} from './errors.js';

export { tool } from './tools.js';

export {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  forkSession,
  deleteSession,
  renameSession,
} from './sessions.js';

export { accountInfo, mcpServerStatus, supportedCommands, supportedModels } from './introspection.js';

export { registerHooks } from './hooks.js';
export type { HookEvent, HookEventData, HookCallback, HookConfig } from './hooks.js';

export { buildMcpSessionContext, createSdkMcpServer } from './mcp.js';
