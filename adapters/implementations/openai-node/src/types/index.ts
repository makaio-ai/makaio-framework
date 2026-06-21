import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import {
  type BaseAgentConnectorConfig,
  type MessageHandle,
  type AIReasoningLevel,
  type ReasoningLevelMap,
  type MessageResult,
} from '@makaio/ai-adapters-core';
import type { OpenAINodeProviderSettings } from '../schemas.js';
import { type ExtractSubjectPayload, type ExtractSubjectResponse } from '@makaio/core';
import { type OpenAINodeConnectorBus, OpenAINodeConnectorSubjects, type SdkEventMessage } from '../namespaces/index.js';
import type OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/index.js';

/**
 * OpenAI Node adapter namespace identifier
 */
export const OPENAI_NODE_NAMESPACE = 'adapter:openai-node' as const;

/**
 * Scoped bus type for OpenAI Node adapter
 */
export type OpenAIBus = ScopedBus<typeof OPENAI_NODE_NAMESPACE>;

/**
 * Provider-specific configuration for the OpenAI Node connector.
 *
 * Contains only non-credential settings. Credentials (e.g., `apiKey`) are
 * resolved at runtime from `providerContext.credentialRefs` via
 * `resolveConnectorCredentials()` and never appear in this type.
 */
export type OpenAINodeProviderConfig = OpenAINodeProviderSettings;

/**
 * Configuration for creating an OpenAINodeAgent connector via AIAgent.createConnector().
 *
 * This type is used by OpenAIAgent to pass config to the underlying OpenAINodeAgent.
 * Separated from OpenAINodeAgentConfig to decouple the AIAgent layer from connector internals.
 */
export interface OpenAIAgentConnectorConfig {
  /** Model to use for chat completions (e.g., 'gpt-4o', 'gpt-4o-mini') */
  model?: string;
  /** Working directory for tool execution context */
  cwd?: string;
  /** Environment variables for tool execution context */
  env?: Record<string, string>;
  /** Provider-specific configuration (non-credential settings only) */
  providerConfig?: OpenAINodeProviderConfig;
}

/**
 * Configuration for an OpenAI Node agent session.
 */
export type OpenAINodeAgentConfig = BaseAgentConnectorConfig<OpenAIBus, OpenAINodeProviderConfig>;

/**
 * Configuration for stream processing.
 * Contains bus reference and metadata for event enrichment.
 */
export interface StreamBridgeConfig {
  /** Scoped bus for event emission */
  bus: OpenAIBus;
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
  /** Tool names that stay internal and are omitted from public tool lifecycle events. */
  hiddenToolCallNames?: readonly string[];

  logLowLevelEvent?: (event: unknown) => void;
}

/**
 * In-progress tool call accumulator for delta reassembly.
 * Tool calls arrive as fragments that must be assembled.
 */
export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/** Tool approval request payload type (extracted from namespace subject) */
export type ToolApprovalPayload = Omit<
  ExtractSubjectPayload<typeof OpenAINodeConnectorSubjects.tool_approval>,
  'adapterName' | 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId'
>;

/** Tool approval response type (extracted from namespace subject) */
export type ToolApprovalResponse = ExtractSubjectResponse<typeof OpenAINodeConnectorSubjects.tool_approval>;

/** Configuration for OpenAI session lifecycle management */
export interface OpenAISessionConfig {
  bus: OpenAINodeConnectorBus;
  globalBus?: IMakaioBus;
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
  /** Timeout for obtaining a stream from chat.completions.create (ms) */
  streamStartTimeoutMs?: number;
  env: Record<string, string>;
  client: OpenAI;
  openAITools: ChatCompletionTool[];
  /** Resolved system prompt string to prepend to messages */
  systemPrompt?: string;
  /**
   * Whether the provider accepts `response_format: json_schema` alongside
   * tools in the same request, bypassing the finalizer-tool workaround.
   */
  supportsResponseFormatWithTools: boolean;
  /**
   * Whether the provider accepts `strict: true` on `json_schema`
   * response format payloads for guaranteed schema conformance.
   */
  supportsStructuredOutputStrict: boolean;
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
  emitSdkEvent: (event: SdkEventMessage) => Promise<void>;
  handleError: (error: Error, rethrow: boolean) => void;
  requestToolApproval: (payload: ToolApprovalPayload) => Promise<ToolApprovalResponse>;
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
