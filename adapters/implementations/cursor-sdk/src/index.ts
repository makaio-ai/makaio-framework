/**
 * Cursor SDK Adapter
 *
 * Package: \@makaio/adapter-cursor-sdk
 *
 * Provides a standardized interface for the Cursor AI editor agent via its
 * TypeScript SDK in the Makaio AI framework. The Cursor SDK manages its own
 * agentic loop; this adapter wraps `Agent` creation + `agent.send()` streaming.
 */

// Namespace and bus type
export { CursorSdkNamespace, CursorSdkSubjects } from './namespaces/index.js';
export type {
  CursorSdkBus,
  SdkEventPayload,
  TextDelta,
  TextComplete,
  ThinkingDelta,
  ThinkingComplete,
  MessageComplete,
  Usage,
  ToolCompleted,
  AgentComplete,
  ErrorEvent,
  ShellOutputDelta,
  SummaryStarted,
  SummaryComplete,
  StatusChanged,
  RunCreated,
} from './namespaces/index.js';

// Re-export shared types surfaced by the namespace
export type { ToolStartedEvent, AgentStartedEvent, TurnStateChanged } from './namespaces/index.js';

// Constants
export { CursorSdkAdapterName, DefaultModel, DEFAULT_TIMEOUTS } from './constants.js';

// Schemas and config types
export { CursorSdkProviderConfigSchema } from './schemas.js';
export type { CursorSdkProviderConfig } from './schemas.js';

// Types
export { CURSOR_SDK_NAMESPACE } from './types/index.js';
export type { CursorConnectorConfig, CursorSessionConfig } from './types/index.js';

// Turn
export { CursorSdkTurn } from './turn.js';

// Session
export { CursorSdkSession } from './session.js';
export type { CursorSdkSessionConfig } from './session.js';

// Connector, agent
export { CursorSdkConnector } from './connector.js';
export { CursorSdkAgent, normalizeToolOutput } from './agent.js';

// Adapter and factory
export { CursorSdkAdapter, createCursorSdkAdapter } from './adapter.js';

// Config factory
export { CursorSdkConfig } from './config.js';

// Tool handling
export { registerToolApprovalHandler, toGlobalToolApproval } from './tool-handling.js';
export type { ToolApprovalContext } from './tool-handling.js';

// Provider declarations
export { providerIds, defaultPresetId, testPresetId } from './provider.js';

// Package descriptor
export { cursorSdkPackage } from './package.js';

// Adapter definition
export { adapterDefinition } from './definition.js';
