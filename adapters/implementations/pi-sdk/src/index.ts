/**
 * Pi SDK Adapter
 *
 * Package: \@makaio/ai-adapters-pi-sdk
 *
 * Provides a standardized interface for the Pi coding agent via its TypeScript
 * SDK in the Makaio AI framework. The Pi SDK manages its own agentic loop;
 * this adapter wraps `createAgentSession()` + `session.prompt()` +
 * `session.subscribe()`.
 */

// Namespace and bus type
export { PiSdkNamespace, PiSdkSubjects } from './namespaces/index.js';
export type {
  PiSdkBus,
  SdkEvent,
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
  CompactionStarted,
  CompactionEnded,
  AutoRetryStarted,
  AutoRetryEnded,
  QueueUpdate,
} from './namespaces/index.js';

// Re-export shared types surfaced by the namespace
export type { ToolStartedEvent, AgentStartedEvent, TurnStateChanged } from './namespaces/index.js';

// Constants
export { PiSdkAdapterName, DefaultModel, DEFAULT_TIMEOUTS } from './constants.js';

// Schemas and config types
export { PiSdkProviderConfigSchema, NoToolsValues } from './schemas.js';
export type { PiSdkProviderConfig } from './schemas.js';

// Types
export { PI_SDK_NAMESPACE } from './types/index.js';
export type { PiConnectorConfig, PiThinkingLevel } from './types/index.js';

// Connector, agent, turn
export { PiConnector } from './connector.js';
export { PiAgent } from './agent.js';
export { PiConnectorTurn } from './turn.js';

// Adapter and factory
export { PiAdapter, createPiSdkAdapter } from './adapter.js';

// Config factory
export { PiSdkConfig } from './config.js';

// Tool handling
export { registerToolApprovalHandler } from './tool-handling.js';
export type { ToolApprovalContext } from './tool-handling.js';

// Tool conversion
export { toPiToolFormat, fetchToolsForPi } from './tool-conversion.js';

// Provider declarations
export { providerIds, defaultPresetId } from './provider.js';

// Package descriptor
export { piSdkPackage } from './package.js';
