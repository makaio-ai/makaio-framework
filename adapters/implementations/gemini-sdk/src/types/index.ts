import type { ScopedBus } from '@makaio/bus-core';
import { BaseAgentConnectorConfig, MessageHandle, type ISessionToolLedger } from '@makaio/ai-adapters-core';
import { GeminiConnectorBus, type SdkEvent } from '../namespaces/index.js';
import { type Config, type GeminiChat } from '@google/gemini-cli-core';
import type { GeminiSdkProviderSettings } from '../schemas.js';
import type { HandleErrorFn, ToolApprovalFn } from '../utils/execute-tool-calls.js';

/**
 * Gemini SDK adapter namespace identifier.
 */
export const GEMINI_SDK_NAMESPACE = 'adapter:geminiSDK' as const;

/**
 * Scoped bus type for Gemini SDK adapter.
 */
export type GeminiBus = ScopedBus<typeof GEMINI_SDK_NAMESPACE>;

/**
 * Metadata for tracking active Gemini agents and their sessions.
 */
export interface GeminiAgentMetadata {
  adapterId: string;
  adapterName: string;
  agentId: string;
  sessionId: string;
  adapterSessionId: string;
}

/**
 * Configuration for creating a GeminiConnector via GeminiAgent.createConnector().
 *
 * This type is used by GeminiAgent to pass config to the underlying GeminiConnector.
 * Separated from GeminiConnectorConfig to decouple the AIAgent layer from connector internals.
 */
export interface GeminiAgentConnectorConfig {
  /** Model to use for chat completions (e.g., 'gemini-2.5-flash', 'gemini-2.5-pro') */
  model?: string;
  /** Working directory for tool execution context */
  cwd?: string;
  /** Environment variables for tool execution context */
  env?: Record<string, string>;
  /** Provider-specific configuration */
  providerConfig?: GeminiSdkProviderSettings;
}

/**
 * Configuration for a GeminiConnector (lowest layer).
 * Extends BaseAgentConnectorConfig with Gemini-specific options.
 */
export type GeminiConnectorConfig = BaseAgentConnectorConfig<GeminiBus, GeminiSdkProviderSettings> & {
  /** Optional adapter ID override (defaults to module-level shared ID) */
  adapterId?: string;
};

/**
 * Configuration for GeminiConnectorSession.
 */
export interface GeminiSessionConfig {
  bus: GeminiConnectorBus;
  adapterId: string;
  adapterName: string;
  agentId: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  geminiConfig: Config;
  geminiChat: GeminiChat;
  emitSdkEvent: (event: SdkEvent) => Promise<void>;
  handleError: HandleErrorFn;
  requestToolApproval: ToolApprovalFn;
  onTurnStart?: (handle: MessageHandle) => void;
  onTurnComplete?: (handle: MessageHandle, result: { outcome: string; result?: unknown; error?: unknown }) => void;
  /**
   * Names of tools loaded from the central ToolRegistry.
   * Used by executeToolCalls to route to the bus fallback path when the
   * SDK's internal ToolRegistry does not contain the called tool.
   */
  registryToolNames?: ReadonlySet<string>;
  /** Session tool ledger used for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for MCP ledger bookkeeping. */
  getCurrentTurnNumber?: () => number;
}
