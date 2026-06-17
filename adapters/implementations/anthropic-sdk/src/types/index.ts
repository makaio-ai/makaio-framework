import type { ScopedBus } from '@makaio/bus-core';
import {
  type BaseAgentConnectorConfig,
  type MessageHandle,
  type AIReasoningLevel,
  type ReasoningLevelMap,
  type MessageResult,
} from '@makaio/ai-adapters-core';
import type { AnthropicSdkProviderSettings } from '../schemas.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { SdkEventMessage } from '../namespaces/index.js';
import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';

/**
 * Anthropic SDK adapter namespace identifier.
 */
export const ANTHROPIC_SDK_NAMESPACE = 'adapter:anthropic-sdk' as const;

/**
 * Scoped bus type for Anthropic SDK adapter.
 */
export type AnthropicSdkBus = ScopedBus<typeof ANTHROPIC_SDK_NAMESPACE>;

/**
 * Provider-specific configuration for the Anthropic SDK connector.
 *
 * Contains only non-credential settings. Credentials (e.g., `apiKey`) are
 * resolved at runtime from `providerContext.credentialRefs` via
 * `resolveConnectorCredentials()` and never appear in this type.
 */
export type AnthropicSdkProviderConfig = AnthropicSdkProviderSettings;

/**
 * Configuration for creating an AnthropicSdkAgent connector via AIAgent.createConnector().
 *
 * This type is used by AnthropicSdkAgent to pass config to the underlying connector.
 * Separated from AnthropicSdkAgentConfig to decouple the AIAgent layer from connector internals.
 */
export interface AnthropicSdkAgentConnectorConfig {
  /** Model to use for message creation (e.g., 'claude-sonnet-4-20250514') */
  model?: string;
  /** Working directory for tool execution context */
  cwd?: string;
  /** Environment variables for tool execution context */
  env?: Record<string, string>;
  /** Provider-specific configuration (non-credential settings only) */
  providerConfig?: AnthropicSdkProviderConfig;
}

/**
 * Configuration for an Anthropic SDK agent connector session.
 */
export type AnthropicSdkAgentConfig = BaseAgentConnectorConfig<AnthropicSdkBus, AnthropicSdkProviderConfig>;

/**
 * Configuration for stream processing.
 * Contains bus reference and metadata for event enrichment.
 */
export interface StreamBridgeConfig {
  /** Scoped bus for event emission */
  bus: AnthropicSdkBus;
  /** Agent ID for event metadata */
  agentId: string;
  /** Adapter ID for event metadata */
  adapterId: string;
  /** Adapter name for event metadata */
  adapterName: string;
  /** Adapter-local session ID for event metadata and message_complete filtering */
  adapterSessionId?: string;
  /** Model name for event metadata */
  model: string;
  /** Optional low-level event logger for observability */
  logLowLevelEvent?: (event: unknown) => void;
}

/**
 * In-progress tool call accumulator for partial JSON reassembly.
 * Anthropic tool inputs arrive as `input_json_delta` fragments that must be assembled.
 */
export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  /** Original Anthropic content block index for stable step ordering. */
  blockIndex: number;
}

/** Tool approval payload type (excludes identity context injected by the connector) */
export type AnthropicToolApprovalPayload = Omit<
  AgentToolApproveRequest,
  'adapterName' | 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId'
>;

/** Tool approval response type */
export type AnthropicToolApprovalResponse = AgentToolApproveResponse;

/**
 * Session configuration for Anthropic SDK lifecycle management.
 */
export interface AnthropicSdkSessionConfig {
  bus: AnthropicSdkBus;
  adapterId: string;
  adapterName: string;
  /** Agent ID for tool execution attribution */
  agentId: string;
  /** Makaio session ID for tool execution context */
  sessionId?: string;
  /** Provider-assigned session identifier forwarded to tool execution context. */
  adapterSessionId?: string;
  cwd: string;
  model: string;
  reasoningEffort?: AIReasoningLevel;
  /** Maximum number of tokens to generate per request. Falls back to DEFAULT_MAX_TOKENS when not set. */
  maxTokens?: number;
  /** Timeout for obtaining a stream from messages.create (ms) */
  streamStartTimeoutMs?: number;
  env: Record<string, string>;
  client: Anthropic;
  /** Anthropic-format tools to pass to messages.create */
  anthropicTools: Tool[];
  /** Resolved system prompt string to prepend to messages */
  systemPrompt?: string;
  /**
   * Reasoning levels supported by the active model.
   * Populated by the config factory from the resolved ProviderRecord's model catalog.
   * Absent when the model does not declare reasoning support.
   */
  supportedReasoningLevels?: ReasoningLevelMap;
  /**
   * Directory restrictions for file-system tool execution.
   * Forwarded as `constraints.allowedDirectories` in every tool call.
   */
  allowedDirectories?: string[];
  /** Emit a typed SDK event to the connector bus */
  emitSdkEvent: (event: SdkEventMessage) => Promise<void>;
  /** Handle a connector-level error */
  handleError: (error: Error, rethrow: boolean) => void;
  /** Request tool approval via bus RPC */
  requestToolApproval: (payload: AnthropicToolApprovalPayload) => Promise<AnthropicToolApprovalResponse>;
  logLowLevelEvent?: (event: unknown) => void;
  onTurnStart?: (handle: MessageHandle) => void;
  onTurnComplete?: (handle: MessageHandle, result: MessageResult) => void;
  /**
   * Record one mcp_call invocation in the session tool ledger.
   * Bound by the connector as a closure over its ledger and current turn number.
   * @param toolFullName - Namespaced target tool name from the mcp_call args
   */
  recordMcpCall?: (toolFullName: string) => void;
}
