import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type {
  CacheStrategy,
  JsonValue,
  McpRuntimeSessionContext,
  McpSessionContext,
  Message,
  NativeForkDirective,
  ProtocolId,
  ProviderContext,
  ResponseSchemaDescriptor,
  RequestCorrelationContext,
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
import type { AdapterProviderDefinition } from '../types/provider-definition.js';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import type { ResolvedAdapterAuth } from '../config/resolve-adapter-auth.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';

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
  /** Allowed tool names. Empty array disables all adapter-visible tools. */
  allowedTools?: string[];
  /** Disallowed tool names. Takes precedence over allowedTools. */
  disallowedTools?: string[];
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
  globalBus?: IMakaioBus;
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
   * Refs-only normalized provider selection retained for runtime introspection.
   * Plaintext authentication is available only through {@link adapterAuth}.
   */
  providerContext?: ProviderContext;

  /** Exact HTTP protocol selected by the active adapter/provider reference. */
  providerProtocol?: ProtocolId;

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

  /**
   * Provider-native fork directive approved by session orchestration.
   * When present, native-fork capable connectors should branch from the source
   * provider session instead of starting fresh with replayed history.
   */
  nativeFork?: NativeForkDirective;

  /** Resolved harness ID for tool policy lookup. */
  harnessId?: string;

  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'gemini'). */
  clientId?: string;

  /** Client profile name for session-scoped config isolation. */
  clientProfileName?: string;

  /**
   * Auth-free environment safe for bus-routable tool and MCP contexts.
   *
   * The central adapter runtime derives this from the same merged inputs as
   * `env`, but omits the selected process authentication delivery.
   */
  contextEnv?: Readonly<Record<string, string>>;

  /**
   * Single connector-local normalized auth snapshot.
   *
   * Plaintext exists only on this trusted connector config and must never be
   * emitted, persisted, stringified, or copied back into provider context.
   */
  adapterAuth?: ResolvedAdapterAuth;

  /** Managed client binary selected by the central runtime, when applicable. */
  clientExecution?: ClientExecutionContext;

  /** Callback when a user message is enqueued */
  onMessageSent?: (messageHandle: MessageHandle) => void;

  /**
   * Announce that the connector rotated its provider session with no confirmed
   * successor yet.
   *
   * For rotations the executor can predict, the movement seam is driven from the
   * pre-dispatch check in `AgentTurnExecutor` (see
   * `agent/agent-adapter-session-movement.ts`). A connector that rotates on a
   * decision only it can observe — the CLI's immediate-mode restart, which kills
   * the in-flight subprocess and mints a fresh identity — must announce that
   * movement itself, and `await` it before the dispatch that abandons the old
   * provider session (duty 2).
   *
   * Injected by the owning agent, so the announcement routes through its
   * `ConfirmedAdapterSessionTracker` and inherits the seam's retry anchor
   * (duties 3 and 4) instead of emitting one unrecoverable event.
   */
  onAdapterSessionMoved?: () => Promise<void>;

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

  /**
   * When true, the connector is handling an ephemeral one-shot agent.
   *
   * Ephemeral agents are by contract never resume or fork targets. Connectors
   * that support session persistence should disable it for ephemeral agents so
   * no transcript is written to the provider's session store.
   */
  ephemeral?: boolean;
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
  /** Refs-only normalized provider selection set by session orchestration. */
  providerContext?: ProviderContext;
  /** Previous adapter session ID for resume attempts (from recovery). */
  resumeAdapterSessionId?: string;
  /** Resolved harness ID for tool policy lookup. */
  harnessId?: string;
  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'gemini'). */
  clientId?: string;
  /** Client profile name for session-scoped config isolation. */
  clientProfileName?: string;
  /** Trusted non-serializable auth preparation strategy injected by the host. */
  prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus>;
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
  /** Resolved provider definitions, including adapter-provider auth metadata. */
  definitionProviders?: readonly AdapterProviderDefinition[];

  // Runtime options from StartAgentRequest
  /** Allowed tool names (adapter-specific). Empty array = disable all tools. */
  allowedTools?: string[];
  /** Disallowed tool names (adapter-specific). Takes precedence over allowedTools. */
  disallowedTools?: string[];
  /** Directory restrictions for file-system tool execution. */
  allowedDirectories?: string[];
  /** Per-call adapter-specific JSON config forwarded to the adapter config factory. */
  adapterConfig?: Record<string, unknown>;
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
   * Native fork directive from the orchestrator.
   *
   * When present, the adapter should use the provider's branching API
   * rather than replaying history into a fresh session.
   * Populated by AIAdapter.createAgent when the startAgent mode is 'fork'.
   *
   * AIAgent forwards this through config-factory input so standardized adapter
   * config factories can carry it into connector config. Adapter code must not
   * derive this from raw fork-mode request fields.
   */
  nativeFork?: NativeForkDirective;

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
   * Structured output descriptor for the turn.
   *
   * Adapters that declare `structuredOutput` pass this schema to their native
   * model-level output controls. Other adapters receive an instruction block
   * and the agent validates the terminal output after completion.
   *
   * Validation retries are default-off (`maxRetries: 0`) and fallback
   * enforcement is a no-op unless the host registers structured-output override
   * handlers.
   */
  responseSchema?: ResponseSchemaDescriptor;
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
   * Content-free provider transport correlation. This is carried on the
   * message handle and never materialized into the LLM-facing message.
   */
  requestCorrelation?: RequestCorrelationContext;
  /**
   * Lifecycle turnId from the session orchestrator (`agent.sendMessage.turnId`).
   * Carried on the message handle so user_message lifecycle events pair by it.
   * Distinct from `requestCorrelation.turnId`, which is transport correlation
   * and may be present when no lifecycle turn exists.
   */
  turnId?: string;
  /**
   * Turn-scoped context assembled by PreUserMessage hooks and the orchestrator.
   * Extracted from sessionContext.turnContext by AIAgent.
   * Adapters use this to prepend context blocks to the SDK message.
   *
   * ADAPTER CONTRACT: Every adapter MUST materialize turnContext into the
   * LLM-facing message using serializeTurnContext().
   */
  turnContext?: Record<string, JsonValue>;
  /**
   * Caller-expressed caching intent for the injected message history.
   * Adapters map this to provider-specific cache mechanisms.
   */
  cacheStrategy?: CacheStrategy;
  /**
   * Whether this message is an internal retry turn synthesized by the structured-output
   * manager. When `true`, the connector suppresses `user_message.sent` so the retry
   * is not surfaced as a new user message.
   */
  internalRetry?: boolean;
  /**
   * Caller decision on provider-native session resume for this dispatch.
   *
   * The turn pipeline sets this from the agent's native-resume decision. When
   * `false`, the connector MUST NOT arm its pending start-time resume target
   * (`resumeAdapterSessionId`) for this dispatch: the caller has replaced the
   * provider thread with injected `messageHistory`, so natively resuming would
   * double the conversation context. Honoring connectors discard the
   * unconsumed resume target and mint a fresh provider session instead.
   *
   * When `true` or absent, the connector applies its default resume behavior.
   * The flag never affects a connector's continuity of its own
   * provider-confirmed session (intra-generation multi-turn), and it does not
   * cancel an approved `nativeFork` directive — fork is a separate contract.
   */
  useNativeResume?: boolean;
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
 *
 * Derived from the `agent.usage` schema, so the mandatory `granularity` field
 * is part of this type: adapters MUST declare the truthful measurement
 * granularity of every usage signal they normalize (see
 * `docs/architecture/adapters/usage-and-provenance.md`).
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

/**
 * Per-call overrides for connector (re)creation paths.
 *
 * Shared by `AIAgent.swapConnector`, config-input assembly, and the connector
 * lifecycle factory so the override surface cannot drift between them.
 */
export type AgentConnectorConfigOverrides = Partial<{
  cwd: string;
  model: string;
  providerContext: ProviderContext;
  adapterSessionId: string;
  /**
   * Provider session the replacement generation should native-resume. Key
   * presence (not value) selects this over the agent config's start-time
   * resume target, so an explicit `undefined` builds a fresh connector
   * instead of silently re-resuming a stale start directive.
   */
  resumeAdapterSessionId: string | undefined;
  mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
  /**
   * Target reasoning effort for the replacement generation. Key presence (not
   * value) selects this over the live connector's current effort, so an
   * explicit `undefined` builds a reasoning-less connector. Adapters may
   * consume reasoning only at construction/start, so the replacement must be
   * built with its target effort rather than mutated afterwards.
   */
  reasoningEffort: AIReasoningLevel | undefined;
}>;
