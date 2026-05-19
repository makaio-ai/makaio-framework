import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type {
  JsonValue,
  McpRuntimeSessionContext,
  McpSessionContext,
  Message,
  ProviderContext,
  SessionContext,
  SystemPrompt,
} from '@makaio/contracts';
import type { LedgerSessionContext, ISessionToolLedger } from './session-tool-ledger.js';
import type { TrackedTimeoutConfig } from '@makaio/utils';
import type { AIReasoningLevel, AIModel, ReasoningLevelMap } from '../types/ai-model.js';
import type { SetRequired } from 'type-fest';
import { z } from 'zod';
import type { AIAgentConnector } from '../connector/agent-connector.js';
import type { ConfigFactoryInput } from '../adapter/ai-adapter-config.js';
import { AgentSchemas, AgentSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';
import type { MessageHandle, ProcessingState, SendMessageOptions } from '../message-handle/index.js';

// ============================================================================
// Base Types - DRY foundations for agent identity and runtime options
// ============================================================================

/**
 * Core agent identity fields.
 * Used as base for contexts, configs, and request payloads.
 */
export interface AgentIdentity {
  /** Unique agent identifier */
  agentId: string;
  /** Adapter instance identifier */
  adapterId: string;
  /** Adapter type name (e.g., 'claude-code', 'gemini-sdk') */
  adapterName: string;
  /** Session identifier for multi-turn conversations */
  adapterSessionId?: string;
}

/**
 * Runtime options as INPUT - model/cwd optional (adapters provide defaults via configFactory).
 */
export interface AgentRuntimeInput {
  /** Model to use (optional - adapter provides default) */
  model?: string;
  /** Working directory for agent execution (optional - platform provides default) */
  cwd?: string;
  /** Environment variables to pass to agent execution */
  env?: Record<string, string>;
  /** Reasoning effort for supporting adapters */
  reasoningEffort?: AIReasoningLevel;
}

/**
 * Runtime options as RESOLVED config - model/cwd required (after configFactory applies defaults).
 */
export type AgentRuntimeOptions = SetRequired<AgentRuntimeInput, 'model' | 'cwd'>;

// ============================================================================
// Context Types
// ============================================================================

/**
 * Common context fields for all agent.* subject emissions.
 * AIAgent automatically enriches payloads with these fields.
 */
export type AgentContext = Required<AgentIdentity>;

/**
 * Execution context for per-agent processors.
 * Baked in at processor creation time, eliminating runtime registry lookups.
 */
export type ExecutionContext = AgentContext;

// ============================================================================
// Config Types
// ============================================================================

export interface MinimalAgentConnectorConfig<TBus extends ScopedBus<string> = ScopedBus<string>> {
  bus: TBus;
}

/**
 * Base configuration for AI agent connector instances.
 */
export interface BaseAgentConnectorConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TProviderConfig extends object = object,
> extends MinimalAgentConnectorConfig<TBus>,
    Omit<AgentIdentity, 'adapterId'>,
    AgentRuntimeOptions {
  /** Makaio session ID for tool execution context and multi-session correlation */
  sessionId?: string;
  errorHandler?: (error: Error, terminate: boolean) => void;

  /**
   * Resolved timeout configuration with provenance tracking.
   * Set by configFactory after merging all timeout layers.
   */
  timeouts?: TrackedTimeoutConfig;

  /**
   * UUID of the ProviderConfig entity used during agent creation.
   * Carried on the connector config for runtime introspection and dynamic provider switching.
   */
  providerConfigId?: string;

  /**
   * Unresolved provider context (credential refs, not plaintext).
   *
   * Passed through from the factory input so connectors can call
   * `resolveConnectorCredentials()` locally during initialization.
   * Connectors must NOT read plaintext credentials from this field —
   * they must resolve refs via `resolveConnectorCredentials()`.
   */
  providerContext?: ProviderContext;

  providerConfig?: TProviderConfig;

  /**
   * Maps supported reasoning levels to provider-native values for the active model.
   *
   * Populated by the config factory when the resolved model declares reasoning support.
   * Absent when the model does not support extended thinking.
   */
  supportedReasoningLevels?: ReasoningLevelMap;

  /** Previous adapter session ID for resume attempts. */
  resumeAdapterSessionId?: string;

  /** Resolved harness ID for tool policy lookup. */
  harnessId?: string;

  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'gemini'). */
  clientId?: string;

  /** Client profile name for session-scoped config isolation. */
  clientProfileName?: string;

  /** Callback when a user message is enqueued */
  onMessageSent?: (messageHandle: MessageHandle) => void;

  /**
   * Directory restrictions for file-system tool execution.
   * When set, forwarded as `constraints.allowedDirectories` in every tool call.
   * Empty array means no restriction; undefined means no restriction.
   */
  allowedDirectories?: string[];

  /**
   * MCP session context resolved by the orchestrator.
   * Provides the direct and discoverable tool sets for the current session.
   * When present, enables MCP tool injection and ledger tracking.
   *
   * Intentionally narrowed to LedgerSessionContext — the minimal shape the
   * ledger needs. Adapters requiring the full McpSessionContext (with
   * resolution keys / servers) re-declare this field via Omit + intersection
   * in their own config types (e.g. BaseStreamConnectorConfig, ClaudeAgentConfig).
   */
  mcpSessionContext?: LedgerSessionContext | McpRuntimeSessionContext | McpSessionContext;

  /**
   * Session-scoped tool ledger for tracking injection, discovery, and call history.
   * When present, the connector records tool events into this ledger.
   */
  toolLedger?: ISessionToolLedger;
}

/**
 * Configuration for creating an AIAgent instance.
 *
 * Combines agent identity, runtime input, and factory functions.
 * model/cwd are optional here - configFactory provides adapter defaults.
 * @typeParam TBus - The scoped bus type for this adapter
 * @typeParam TConnector - The connector type (for proper factory return typing)
 */
export interface AIAgentConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
> extends Omit<AgentIdentity, 'adapterSessionId'>,
    AgentRuntimeInput {
  /** Adapter-specific session identifier for multi-turn conversations */
  adapterSessionId?: string;
  /** Makaio session identifier */
  sessionId?: string;
  /**
   * Unresolved provider context (credential refs, not plaintext).
   * Set by the orchestrator before forwarding the startAgent request.
   * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
   */
  providerContext?: ProviderContext;
  /** Previous adapter session ID for resume attempts (from recovery). */
  resumeAdapterSessionId?: string;
  /** Resolved harness ID for tool policy lookup. */
  harnessId?: string;
  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'gemini'). */
  clientId?: string;
  /** Client profile name for session-scoped config isolation. */
  clientProfileName?: string;
  /** Global bus instance (defaults to MakaioBus singleton) */
  globalBus?: IMakaioBus;
  /** Scoped bus for adapter-specific events */
  adapterBus: TBus;

  // Adapter metadata
  /** Adapter capabilities (e.g., ['streaming', 'tools', 'vision']) */
  capabilities: string[];
  /** Native tools built into the adapter (e.g., ['shell_command', 'apply_patch']) */
  nativeTools: string[];
  /** Available models for this adapter (used for context window lookup) */
  availableModels?: AIModel[];

  // Runtime options from StartAgentRequest
  /** Allowed tool names (adapter-specific). Empty array = disable all tools. */
  allowedTools?: string[];
  /** Disallowed tool names (adapter-specific). Takes precedence over allowedTools. */
  disallowedTools?: string[];
  /** Directory restrictions for file-system tool execution. */
  allowedDirectories?: string[];
  /**
   * MCP session context resolved by the orchestrator.
   * Passed through to the connector config so adapters can inject direct tools.
   */
  mcpSessionContext?: LedgerSessionContext | McpRuntimeSessionContext;
  /**
   * Session-scoped ledger tracking MCP injection/discovery/call history.
   * Created once per agent session and passed through unchanged on connector swaps.
   */
  toolLedger?: ISessionToolLedger;

  /**
   * When true, PreUserMessage hooks are skipped for this agent.
   * Use for ephemeral ping agents where session enrichment and context injection
   * are not needed and would be actively harmful.
   */
  ephemeral?: boolean;

  /**
   * Config factory - transforms partial input into full adapter-specific config.
   * This is the seam where adapters inject their defaults (especially model).
   */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;

  /**
   * Connector factory - creates connector from full config.
   * Called AFTER configFactory returns the complete configuration.
   * Config includes adapterId (passed through from input by config factory).
   */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;
}

// ============================================================================
// Result and Options Types
// ============================================================================

/**
 * Result returned from agent.start()
 */
export interface AgentStartResult {
  adapterSessionId: string;
  agentId: string;
  messageHandle: MessageHandle;
}

/**
 * Options for sending a message to an agent.
 * Extends SendMessageOptions with curated message history and system prompt configuration.
 */
export interface AgentSendMessageOptions extends SendMessageOptions {
  /** Curated message history from orchestration layer */
  messageHistory?: Message[];

  /**
   * System prompt configuration.
   * - `string`: Replace/set the entire system prompt
   * - `{ mode: 'append', content: string }`: Append to adapter's default system prompt
   */
  systemPrompt?: SystemPrompt;

  /**
   * Context signals assembled by SessionOrchestrator.
   * Used by AIAgent to decide: native resume vs fresh with history.
   * Hooks inject context via sessionContext.turnContext (set by replacePayload).
   */
  sessionContext?: SessionContext;

  /**
   * JSON Schema for structured output.
   * When present and the adapter declares `structuredOutput` capability,
   * the adapter enforces this schema at the model level.
   * Ignored by adapters that lack the capability.
   */
  responseSchema?: Record<string, unknown>;
}

/**
 * Options for starting an agent session.
 * Same as AgentSendMessageOptions - both start() and sendMessage() accept the same options.
 */
export type StartAgentOptions = AgentSendMessageOptions;

/**
 * Options for connector-level message operations.
 * Extends AgentSendMessageOptions with turnContext for internal AIAgent to Connector communication.
 * AIAgent extracts sessionContext.turnContext and passes it here.
 * Inherits responseSchema from AgentSendMessageOptions.
 */
export interface ConnectorSendMessageOptions extends AgentSendMessageOptions {
  /**
   * Turn-scoped context assembled by PreUserMessage hooks and the orchestrator.
   * Extracted from sessionContext.turnContext by AIAgent.
   * Adapters use this to prepend context blocks to the SDK message.
   *
   * ADAPTER CONTRACT: Every adapter MUST materialize turnContext into the
   * LLM-facing message using serializeTurnContext().
   */
  turnContext?: Record<string, JsonValue>;
}

/**
 * Options for connector-level start operations.
 * Same as ConnectorSendMessageOptions.
 */
export type ConnectorStartOptions = ConnectorSendMessageOptions;

// ============================================================================
// Agent Subject Payload Aliases
// ============================================================================

/** Payload type for `agent.sendMessage` requests. */
export type SendMessageRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.sendMessage>;
/** Response type for `agent.sendMessage` requests. */
export type SendMessageResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.sendMessage>;
/** Payload type for `agent.interrupt` requests. */
export type AgentInterruptRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.interrupt>;
/** Response type for `agent.interrupt` requests. */
export type AgentInterruptResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.interrupt>;
/** Response type for `agent.getCapabilities` requests. */
export type GetCapabilitiesResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.getCapabilities>;

/** Payload type for `agent.cwd.change` requests. */
export type AgentCwdChangeRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.cwd.change>;
/** Response type for `agent.cwd.change` requests. */
export type AgentCwdChangeResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.cwd.change>;

/** Payload type for `agent.model.change` requests. */
export type AgentModelChangeRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.model.change>;
/** Response type for `agent.model.change` requests. */
export type AgentModelChangeResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.model.change>;

/** Payload type for `agent.mcp.servers.set` requests. */
export type AgentMcpServersSetRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.mcp.servers.set>;
/** Response type for `agent.mcp.servers.set` requests. */
export type AgentMcpServersSetResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.mcp.servers.set>;

/** Payload type for `agent.credential.change` requests. */
export type AgentCredentialChangeRequestPayload = ExtractSubjectPayload<typeof AgentSubjects.credential.change>;
/** Response type for `agent.credential.change` requests. */
export type AgentCredentialChangeResponsePayload = ExtractSubjectResponse<typeof AgentSubjects.credential.change>;

export type EmitteryEvents = {
  processingStateChanged: ProcessingState;
};

// ============================================================================
// Usage Types
// ============================================================================

/**
 * Normalized usage metrics for a single agent call.
 * Adapter implementations normalize provider-specific usage data to this format.
 */
export type NormalizedCallUsage = Omit<z.infer<typeof AgentSchemas.usage>, keyof AgentContext | 'model'>;

// ============================================================================
// Context Window Types
// ============================================================================

/**
 * Input for context window update emission.
 * Adapters provide raw metrics, helper calculates percentage and level.
 */
export interface ContextWindowInput {
  /** Total tokens in context (input + output for next turn prediction) */
  currentTokens: number;
  /** Model's context window limit */
  maxTokens: number;
  /** Cached tokens (optional, reduces cost but still in context) */
  cachedTokens?: number;
}
