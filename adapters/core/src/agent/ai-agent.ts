/* eslint max-lines: ["error", { "max": 1100 }] */
import type { IMakaioBus, OnOptions, ScopedBus } from '@makaio/bus-core';
import { MakaioBus } from '@makaio/bus-core';
import type { SetRequired } from 'type-fest';
import type {
  AgentContext,
  AgentStartResult,
  AgentCredentialChangeRequestPayload,
  AgentCredentialChangeResponsePayload,
  AgentCwdChangeRequestPayload,
  AgentCwdChangeResponsePayload,
  AgentInterruptRequestPayload,
  AgentInterruptResponsePayload,
  AgentModelChangeRequestPayload,
  AgentModelChangeResponsePayload,
  AgentMcpServersSetRequestPayload,
  AgentMcpServersSetResponsePayload,
  AIAgentConfig,
  ContextWindowInput,
  GetCapabilitiesResponsePayload,
  NormalizedCallUsage,
  SendMessageRequestPayload,
  SendMessageResponsePayload,
  StartAgentOptions,
} from './types.js';
import type { NormalizedMessageInput } from '../utils/index.js';
import { createSentinelProviderContext } from '../utils/index.js';
import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import { z } from 'zod';
import {
  createConnectorEventMapping,
  type DiscriminatorKeys,
  type ConnectorEventHandlers,
} from '../utils/createConnectorEventMapping.js';
import type {
  ExtractSubjectPayload,
  HandlerForSubjectDefinition,
  RequestContext,
  ScopedSubjectDefinition,
  SubjectDefinition,
} from '@makaio/core';
import {
  AgentSchemas,
  type AgentStarted,
  AgentSubjects,
  type MessageInput,
  type McpRuntimeSessionContext,
  type McpSessionContext,
  McpSubjects,
  type ReasoningLevelMap,
  type ProviderContext,
  SessionSubjects,
  type SessionContext,
  type SessionMessageBlock,
  type StepType,
  type BlockData,
  type SystemPrompt,
} from '@makaio/contracts';
import { RateLimitError, AuthenticationError, ModelUnavailableError, QuotaExceededError } from '@makaio/core';
import type { ConfigFactoryInput } from '../adapter/index.js';
import { AIAgentConnector } from '../connector/index.js';
import { MessageLifecycleTracker } from './message-lifecycle-tracker.js';
import { ToolCallTracker, type ResolveHints } from './tool-call-tracker.js';
import type { AIModel } from '../types/ai-model.js';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { LedgerSessionContext } from './session-tool-ledger.js';
import { AgentEventBridge } from './agent-event-bridge.js';
import { AgentTurnExecutor } from './agent-turn-executor.js';
import { AgentRuntimeMutationManager } from './agent-runtime-mutation-manager.js';
import { AgentConnectorLifecycleManager } from './agent-connector-lifecycle-manager.js';
import { registerAgentBusHandlers } from './agent-bus-handler-registrar.js';
import { AgentPayloadEmitter } from './agent-payload-emitter.js';
import { AgentLifecycleEmitter } from './agent-lifecycle-emitter.js';
import {
  createAgentConnectorLifecycleManager,
  createAgentEventBridge,
  createAgentPayloadEmitter,
  createAgentRuntimeMutationManager,
  createAgentTurnExecutor,
} from './agent-internal-factories.js';

/**
 * Extract typed error category from known Makaio error subclasses.
 * @param error - Error emitted by connector/runtime code
 * @returns Structured error category when available
 */
function extractErrorCategory(
  error: Error,
):
  | RateLimitError['code']
  | AuthenticationError['code']
  | ModelUnavailableError['code']
  | QuotaExceededError['code']
  | undefined {
  if (
    error instanceof RateLimitError ||
    error instanceof AuthenticationError ||
    error instanceof ModelUnavailableError ||
    error instanceof QuotaExceededError
  ) {
    return error.code;
  }
  return undefined;
}

interface ToolOutputResolution {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * Abstract base class for AI agents.
 *
 * Bridges adapter/agent bus subjects to connector sessions.
 * @typeParam TBus - The scoped bus type for this adapter
 * @typeParam TConnector - The connector type this agent wraps
 */
export abstract class AIAgent<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
> {
  /** The underlying connector instance (created in init) */
  protected connector!: TConnector;
  protected confirmedModel?: string;
  protected initialModel?: string;
  /** Cached adapterSessionId from the last connector that had a session — survives connector swaps. */
  private lastKnownAdapterSessionId?: string;
  /** Cleanup functions for bus subscriptions (stable, survive connector swap) */
  private busHandlerCleanups: Array<() => void> = [];
  /** Whether init() has been called */
  private initialized = false;
  /** Runtime system prompt captured from start/initialize, preserved across connector swaps. */
  private runtimeSystemPrompt?: SystemPrompt;
  /** Runtime response schema captured from start/initialize, preserved across connector swaps. */
  private runtimeResponseSchema?: Record<string, unknown>;
  /** Tracks message lifecycle and emits turn events. */
  protected readonly lifecycleTracker: MessageLifecycleTracker;
  /** Tracks tool.use → tool.output correlation across adapters. */
  protected readonly toolCallTracker = new ToolCallTracker();
  /** Event-focused helper for usage/tool/step emissions. */
  private readonly eventBridge: AgentEventBridge;
  /** Shared turn pipeline for start/sendMessage paths. */
  private readonly turnExecutor: AgentTurnExecutor;
  /** Runtime mutation helper for cwd/model change handlers. */
  private readonly runtimeMutationManager: AgentRuntimeMutationManager;
  /** Connector lifecycle helper for swap/wiring ownership. */
  private readonly connectorLifecycleManager: AgentConnectorLifecycleManager<TBus, TConnector>;
  /** Payload enrichment and global emission helper. */
  private readonly payloadEmitter: AgentPayloadEmitter;
  /** Stateful lifecycle emitter for start/complete/error/session.closed. */
  private readonly lifecycleEmitter: AgentLifecycleEmitter;
  /** Current content block index within the turn, reset on each turn start */
  private currentBlockIndex = 0;
  /** Normalized config with defaults applied */
  protected readonly config: SetRequired<AIAgentConfig<TBus, TConnector>, 'globalBus'>;
  /** Available models for context window lookup */
  protected readonly availableModels?: AIModel[];
  /**
   * Create an AIAgent instance.
   *
   * Note: Does NOT create the connector yet - call init() after construction.
   * @param config - Agent configuration
   */
  public constructor(config: AIAgentConfig<TBus, TConnector>) {
    this.config = { ...config, globalBus: config.globalBus ?? MakaioBus };
    this.availableModels = config.availableModels;
    // Initialize lifecycle tracker with bound emit function
    this.lifecycleTracker = new MessageLifecycleTracker({
      emitGlobal: this.emitGlobal.bind(this),
    });
    this.payloadEmitter = createAgentPayloadEmitter({
      globalBus: this.globalBus,
      getAgentContextBase: () => ({
        agentId: this.agentId,
        adapterId: this.adapterId,
        adapterName: this.adapterName,
        sessionId: this.sessionId,
      }),
      lifecycleTracker: this.lifecycleTracker,
      getConnectorAdapterSessionId: () => this.connector?.adapterSessionId,
      getLastKnownAdapterSessionId: () => this.lastKnownAdapterSessionId,
      setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => {
        this.lastKnownAdapterSessionId = adapterSessionId;
      },
      getAdapterSessionId: this.getAdapterSessionId.bind(this),
      getEventMetadataDefaults: this.getEventMetadataDefaults.bind(this),
    });
    this.eventBridge = createAgentEventBridge({
      emitGlobal: this.payloadEmitter.emitGlobal.bind(this.payloadEmitter),
      toolCallTracker: this.toolCallTracker,
      getBlockIndex: this.getBlockIndex.bind(this),
      incrementBlockIndex: this.incrementBlockIndex.bind(this),
      getUsageModel: () => this.confirmedModel ?? this.initialModel,
    });
    this.turnExecutor = createAgentTurnExecutor({
      agentId: this.agentId,
      adapterId: this.adapterId,
      sessionId: this.sessionId,
      globalBus: this.globalBus,
      getConnector: () => this.connector,
      shouldUseNativeResume: this.shouldUseNativeResume.bind(this),
      onMessageHandle: this.onMessageHandle.bind(this),
      onBeforeDispatch: () => this.runtimeMutationManager.applyStagedMutations(),
      ephemeral: this.config.ephemeral,
    });
    this.runtimeMutationManager = createAgentRuntimeMutationManager({
      agentId: this.agentId,
      sessionId: this.sessionId,
      globalBus: this.globalBus,
      getConnector: () => this.connector,
      swapConnector: this.swapConnector.bind(this),
      emitGlobal: this.payloadEmitter.emitGlobal.bind(this.payloadEmitter),
      getProviderContext: () => this.config.providerContext,
      setProviderContext: (providerContext: ProviderContext) => void (this.config.providerContext = providerContext),
      setReasoningEffort: (reasoningEffort) => void (this.config.reasoningEffort = reasoningEffort),
      setMcpSessionContext: (mcpSessionContext) => (this.config.mcpSessionContext = mcpSessionContext),
      resolveSupportedReasoningLevels: (model: string) => {
        return this.getSupportedReasoningLevels(model);
      },
    });
    this.connectorLifecycleManager = createAgentConnectorLifecycleManager<TBus, TConnector>({
      agentId: this.agentId,
      buildConfigInput: this.buildConfigInput.bind(this),
      configFactory: this.config.configFactory,
      connectorFactory: this.config.connectorFactory,
      createOnMessageSent: this.createOnMessageSent.bind(this),
      wireEvents: this.wireEvents.bind(this),
      emitGlobal: this.payloadEmitter.emitGlobal.bind(this.payloadEmitter),
      getConnector: () => this.connector,
      setConnector: (connector: TConnector) => {
        this.connector = connector;
      },
      getRuntimeSystemPrompt: () => this.runtimeSystemPrompt,
      getRuntimeResponseSchema: () => this.runtimeResponseSchema,
      setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => {
        this.lastKnownAdapterSessionId = adapterSessionId;
      },
    });
    this.lifecycleEmitter = this.createLifecycleEmitter();
  }

  private getEventMetadataDefaults() {
    return {
      clientId: this.config.clientId,
      providerConfigId: this.connector?.providerConfigId ?? this.config.providerContext?.providerConfigId,
      occurredAt: Date.now(),
    };
  }

  private createLifecycleEmitter(): AgentLifecycleEmitter {
    return new AgentLifecycleEmitter({
      agentId: this.agentId,
      globalBus: this.globalBus,
      emitStarted: async (payload) => {
        await this.payloadEmitter.emitGlobal(AgentSubjects.started, payload);
      },
      emitComplete: async (payload) => {
        await this.payloadEmitter.emitGlobal(AgentSubjects.complete, payload);
      },
      emitSessionClosed: async (payload) => {
        await this.payloadEmitter.emitGlobal(AgentSubjects.session.closed, payload);
      },
      onBeforeEmitCompletion: this.onBeforeEmitCompletion.bind(this),
      clearToolCallTracker: () => this.toolCallTracker.clear(),
    });
  }
  // ── Public getters (external API) ──────────────────────────────────────────
  /** @returns Unique agent identifier */
  public get agentId(): string {
    return this.config.agentId;
  }
  /** @returns Adapter instance identifier */
  public get adapterId(): string {
    return this.config.adapterId;
  }
  /** @returns Adapter type name (e.g., 'claude-code', 'gemini-sdk') */
  public get adapterName(): string {
    return this.config.adapterName;
  }
  /** @returns Adapter capabilities for runtime feature detection */
  public get capabilities(): string[] {
    return this.config.capabilities;
  }
  /** @returns Native tools built into the adapter */
  public get nativeTools(): string[] {
    return this.config.nativeTools;
  }
  /** @returns Shared Makaio sessionId */
  public get sessionId(): string | undefined {
    return this.config.sessionId;
  }
  /** @returns Initial adapter session ID from config (may differ from connector's resolved session ID) */
  protected get adapterSessionId(): string | undefined {
    return this.config.adapterSessionId;
  }
  /** @returns Global bus for cross-namespace communication (defaulted in constructor) */
  protected get globalBus(): IMakaioBus {
    return this.config.globalBus;
  }

  /**
   * Initialize the agent.
   *
   * Creates the connector via the abstract createConnector() method
   * and sets up handlers for agent.* subjects with agentId filtering.
   * @throws Error if already initialized
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      throw new Error(`AIAgent ${this.agentId} already initialized. init() can only be called once.`);
    }

    // Step 1: Build config factory input from agent config
    const configInput = this.buildConfigInput();

    // Step 2: Get full config from adapter's config factory (applies defaults like model)
    const fullConfig = await this.config.configFactory(configInput);

    // Step 3: Create connector with the full config
    this.connector = await this.config.connectorFactory({
      ...fullConfig,
      onMessageSent: this.createOnMessageSent(),
    });

    this.busHandlerCleanups.push(
      ...registerAgentBusHandlers({
        globalBus: this.globalBus,
        agentId: this.agentId,
        onSendMessage: async (ctx: RequestContext<SendMessageRequestPayload, SendMessageResponsePayload>) => {
          await this.sendMessage(ctx);
        },
        onInterrupt: async (ctx: RequestContext<AgentInterruptRequestPayload, AgentInterruptResponsePayload>) => {
          await this.handleInterrupt(ctx);
        },
        getCapabilities: (): GetCapabilitiesResponsePayload => ({
          capabilities: this.capabilities,
          nativeTools: this.nativeTools,
          model: this.connector?.model ?? this.confirmedModel ?? this.initialModel,
        }),
        onCwdChange: async (ctx: RequestContext<AgentCwdChangeRequestPayload, AgentCwdChangeResponsePayload>) => {
          await this.handleCwdChange(ctx);
        },
        onModelChange: async (ctx: RequestContext<AgentModelChangeRequestPayload, AgentModelChangeResponsePayload>) => {
          await this.handleModelChange(ctx);
        },
        onMcpServersSet: async (
          ctx: RequestContext<AgentMcpServersSetRequestPayload, AgentMcpServersSetResponsePayload>,
        ) => {
          await this.handleMcpServersSet(ctx);
        },
        onCredentialChange: async (
          ctx: RequestContext<AgentCredentialChangeRequestPayload, AgentCredentialChangeResponsePayload>,
        ) => {
          await this.handleCredentialChanged(ctx);
        },
      }),
    );

    // Step 4b: Subscribe to MCP tool change events so connectors can refresh at the next
    // turn boundary. These go into busHandlerCleanups (not connectorWiringCleanups) because
    // MCP subscriptions are agent-lifetime — they must survive connector swaps.
    if (this.sessionId) {
      this.busHandlerCleanups.push(
        this.globalBus.on(
          SessionSubjects.turn.started,
          (ctx) => {
            if (!ctx.payload.agentIds.includes(this.agentId)) {
              return;
            }
            this.connector.setCanonicalTurnNumber(ctx.payload.turnNumber);
          },
          { filter: { sessionId: this.sessionId } },
        ),
      );
    }
    this.busHandlerCleanups.push(
      this.globalBus.on(McpSubjects.tools.updated, () => {
        this.connector.markToolRefreshPending();
      }),
      this.globalBus.on(McpSubjects.tools.enabled, () => {
        this.connector.markToolRefreshPending();
      }),
    );

    await this.connectorLifecycleManager.wireAllConnectorEvents(this.connector);

    this.initialized = true;
  }

  protected async emitStart(
    event?: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId' | 'model' | 'cwd'>,
  ) {
    this.currentBlockIndex = 0;
    await this.lifecycleEmitter.emitStart({
      model: this.connector.model,
      cwd: this.connector.cwd,
      ...event,
    });
  }

  protected async emitCompletion(result: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>) {
    await this.lifecycleEmitter.emitCompletion(result);
  }

  /**
   * Stash error metadata for the next emitCompletion call.
   *
   * The lifecycle tracker emits `agent.complete` with `outcome: 'error'` when the
   * message handle completes. This method runs first (from the connector's errorHandler)
   * and stashes `errorCategory` so emitCompletion can include it in the complete payload.
   *
   * No longer emits `agent.error` — all terminal events flow through `agent.complete`.
   * @param result - Error payload from the connector
   */
  protected emitError(result: Pick<z.infer<typeof AgentSchemas.complete>, 'error' | 'errorCategory'>): void {
    this.lifecycleEmitter.emitError(result);
  }

  /**
   * Emit agent session closed event. Emits only once per session.
   * AIAdapter listens to cleanup agent and re-emit as AdapterSubjects.session.closed.
   * @param reason - Reason for session closure (e.g., 'aborted', 'closed')
   */
  protected emitSessionClosed(reason?: string): void {
    this.lifecycleEmitter.emitSessionClosed(reason);
  }

  /**
   * Enrich a payload with agent context fields.
   * @param payload - The base payload to enrich
   * @returns Payload with AgentContext fields and optional messageId added
   */
  protected async enrichPayload<T extends object>(payload: T): Promise<T & AgentContext & { messageId?: string }> {
    return this.payloadEmitter.enrichPayload(payload);
  }

  /**
   * Emit to a global subject with automatic payload enrichment.
   * @param subject - The subject to emit to
   * @param payload - The payload (without AgentContext fields - they're added automatically)
   */
  protected async emitGlobal<S extends SubjectDefinition>(
    subject: S,
    payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext> & { messageId?: string },
  ): Promise<void> {
    await this.payloadEmitter.emitGlobal(subject, payload);
  }

  /**
   * Track usage and emit to global bus.
   * AIAdapter aggregates session totals from per-call usage events.
   * @param normalized - Normalized usage metrics from adapter-specific normalizer
   */
  protected async trackUsage(normalized: NormalizedCallUsage): Promise<void> {
    await this.eventBridge.trackUsage(normalized);
  }

  /**
   * Get context window size for a model.
   *
   * Looks up the context window size from availableModels based on model name.
   * @param modelName - Model name to look up (defaults to confirmedModel or initialModel)
   * @returns Context window size in tokens, or undefined if not found
   */
  protected getContextWindowSize(modelName?: string): number | undefined {
    const model = modelName ?? this.confirmedModel ?? this.initialModel;
    if (!model || !this.availableModels) return undefined;

    const modelInfo = this.availableModels.find((m) => m.name === model);
    return modelInfo?.contextWindowSize;
  }

  /**
   * Emit context window status for compression trigger decisions.
   *
   * Calculates fill percentage and warning level from raw metrics.
   * Called by subclasses after usage tracking with provider-specific metrics.
   * @param input - Raw metrics: currentTokens, maxTokens, optional cachedTokens
   */
  protected async emitContextWindowUpdate(input: ContextWindowInput): Promise<void> {
    await this.eventBridge.emitContextWindowUpdate(input);
  }

  /**
   * Emit tool.use event with automatic correlation tracking.
   * Registers the tool call with ToolCallTracker and emits to global bus.
   * Use this instead of directly emitting to AgentSubjects.tool.use.
   * @param toolName - Name of the tool being invoked
   * @param args - Tool arguments
   * @param nativeId - Native provider ID if available (e.g., toolu_*, call_*)
   * @returns The correlation ID used (nativeId if provided, else generated UUID)
   */
  protected async emitToolUse(toolName: string, args?: Record<string, unknown>, nativeId?: string): Promise<string> {
    return this.eventBridge.emitToolUse(toolName, args, nativeId);
  }
  /**
   * Emit tool.output event with automatic correlation resolution.
   * Resolves the correlation ID from ToolCallTracker using provided hints.
   * Use this instead of directly emitting to AgentSubjects.tool.output.
   * @param output - Tool output content
   * @param hints - Hints for correlation (nativeId and/or toolName)
   * @returns Resolved toolCallId, toolName (falls back to 'unknown'), and args from the matched tool.use call
   */
  protected async emitToolOutput(output: string, hints: ResolveHints): Promise<ToolOutputResolution> {
    return this.eventBridge.emitToolOutput(output, hints);
  }

  /**
   * Emit step.started event with automatic block index management.
   * Call this when a content block begins processing.
   * @param stepType - The type of step (text, reasoning, tool_use)
   * @param blockData - Optional metadata for the block (e.g., toolName for tool_use)
   * @param content - Optional content for the step (e.g., tool_call block for tool_use)
   */
  protected async emitStepStarted(
    stepType: StepType,
    blockData?: BlockData,
    content?: SessionMessageBlock,
  ): Promise<void> {
    await this.eventBridge.emitStepStarted(stepType, blockData, content);
  }

  /**
   * Emit step.finished event with content and increment block index.
   * Call this when a content block completes processing.
   * @param stepType - The type of step that finished
   * @param content - The complete content of the step (text, reasoning, tool_call, or tool_output)
   */
  protected async emitStepFinished(stepType: StepType, content: SessionMessageBlock): Promise<void> {
    await this.eventBridge.emitStepFinished(stepType, content);
  }

  /**
   * Get the current block index (for adapters that need to track it externally).
   * @returns Current block index within the turn
   */
  protected getBlockIndex(): number {
    return this.currentBlockIndex;
  }

  /**
   * Increment block index (for adapters using SDK-provided indices).
   * Call after emitting step.finished if managing index externally.
   */
  protected incrementBlockIndex(): void {
    this.currentBlockIndex++;
  }

  /**
   * Handle agent.sendMessage request.
   * The filter has already been applied at subscription time - this method
   * only receives messages intended for this agent.
   * Runs PreUserMessage hooks before delegating to the connector's sendMessage method.
   * Uses sessionContext signals to decide between native resume and fresh with history.
   * HookAbortError propagates to caller (session layer handles lifecycle).
   * Subclasses can override for custom handling.
   * @param ctx - Request context with payload and response methods
   */
  protected async sendMessage(
    ctx: RequestContext<SendMessageRequestPayload, SendMessageResponsePayload>,
  ): Promise<void> {
    // Fire-and-forget status update: storage handlers may not be registered (optional enrichment).
    // Failures are intentionally ignored to avoid blocking message processing.
    void this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId: this.agentId,
      status: 'active',
    });

    this.lifecycleTracker.setCurrentTurnId(ctx.payload.turnId);
    try {
      const result = await this.turnExecutor.executeSendMessage(ctx.payload);
      ctx.setResult(result);
    } catch (error) {
      // On success, lifecycleTracker.complete() clears turnId when the message
      // handle finishes. This catch-only path handles errors that occur before
      // a handle is tracked — no terminal lifecycle event would clear it.
      this.lifecycleTracker.clearCurrentTurnId();
      throw error;
    }
  }

  /**
   * Handle agent.interrupt request.
   * Delegates to the connector's native interrupt behavior.
   * @param ctx - Request context with interrupt payload
   */
  private async handleInterrupt(
    ctx: RequestContext<AgentInterruptRequestPayload, AgentInterruptResponsePayload>,
  ): Promise<void> {
    try {
      await this.ensureConnector().interrupt();
      ctx.setResult({ success: true });
    } catch (error) {
      ctx.setResult({ success: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Register a cleanup function for connector wiring.
   * These cleanups are cleared on connector swap but preserved across bus handler changes.
   * @param cleanup - Cleanup function to register
   */
  protected addConnectorWiringCleanup(cleanup: () => void): void {
    this.connectorLifecycleManager.addConnectorWiringCleanup(cleanup);
  }

  /**
   * Registers a cleanup function for a global bus subscription.
   * These survive connector swaps and are cleaned up in close().
   * @param cleanup - Function to unsubscribe from the bus
   */
  protected addBusHandlerCleanup(cleanup: () => void): void {
    this.busHandlerCleanups.push(cleanup);
  }

  /**
   * Replace the current connector with a fresh one.
   *
   * Uses create-before-close pattern with rollback for safety:
   * 1. Create new connector first (old connector still alive)
   * 2. Wire events to new connector (accumulate cleanups separately)
   * 3. If successful: close old connector, assign new one
   * 4. If failed: close new connector, restore old wiring, throw
   *
   * This ensures the agent always has a working connector, even if factory or wiring fails.
   *
   * Preserves runtime overrides across sequential swaps by using current connector values
   * as baseline for non-overridden fields.
   * @param configOverrides - Optional config overrides (e.g., new cwd, model)
   * @throws Error if connector is currently processing a turn
   */
  public async swapConnector(
    configOverrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ): Promise<void> {
    await this.connectorLifecycleManager.swapConnector(configOverrides);
    if (configOverrides?.providerContext !== undefined) {
      // Persist successful provider overrides so later swaps rebuild from the
      // latest credential/env/endpoint context instead of the start-time config.
      this.config.providerContext = configOverrides.providerContext;
    }
    if (configOverrides?.mcpSessionContext !== undefined) {
      this.config.mcpSessionContext = configOverrides.mcpSessionContext;
    }
  }

  /**
   * Resolve the supported reasoning levels for a given model name.
   *
   * Centralised lookup into `availableModels` so callers do not repeat the
   * find/optional-chain pattern inline.
   * @param model - Model name to look up, or `undefined` to return `undefined`
   * @returns The `supportedReasoningLevels` map for the model, or `undefined`
   */
  private getSupportedReasoningLevels(model?: string): ReasoningLevelMap | undefined {
    if (!model) return undefined;
    return this.availableModels?.find((entry) => entry.name === model)?.supportedReasoningLevels;
  }

  /**
   * Build config factory input from agent config with optional overrides.
   *
   * Explicitly maps AIAgentConfig fields to ConfigFactoryInput — avoids
   * accidentally forwarding adapter-only fields (capabilities, nativeTools, etc.)
   * into the factory.
   * @param overrides - Optional field overrides (e.g., cwd, model, adapterSessionId)
   * @returns ConfigFactoryInput ready for config factory
   */
  private buildConfigInput(
    overrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      adapterSessionId: string;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ): ConfigFactoryInput<TBus> {
    const cfg = this.config;
    const currentReasoningEffort = this.connector?.currentReasoningEffort ?? cfg.reasoningEffort;
    // providerContext is required by ConfigFactoryInput. Priority:
    //   1. Explicit override (e.g. provider swap on model change)
    //   2. Agent config value (set by orchestrator at start time, or updated by setProviderContext)
    //   3. Sentinel fallback for rehydration and tests that bypass orchestrator provider setup
    const pendingProviderContext = overrides?.providerContext ?? cfg.providerContext;
    if (pendingProviderContext === undefined) {
      console.warn(
        `[AIAgent] No providerContext available for agent "${cfg.agentId}" — falling back to sentinel. ` +
          'This indicates the orchestrator did not populate a provider context before calling startAgent.',
      );
    }
    const providerContext: ProviderContext = pendingProviderContext ?? createSentinelProviderContext();
    return {
      bus: cfg.adapterBus,
      agentId: cfg.agentId,
      adapterId: cfg.adapterId,
      adapterName: cfg.adapterName,
      providerContext,
      model: overrides?.model ?? cfg.model,
      cwd: overrides?.cwd ?? cfg.cwd,
      env: cfg.env,
      adapterSessionId: overrides?.adapterSessionId ?? cfg.adapterSessionId,
      sessionId: cfg.sessionId,
      resumeAdapterSessionId: cfg.resumeAdapterSessionId,
      reasoningEffort: currentReasoningEffort,
      supportedReasoningLevels: this.getSupportedReasoningLevels(overrides?.model ?? cfg.model),
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      allowedDirectories: cfg.allowedDirectories,
      mcpSessionContext: overrides?.mcpSessionContext ?? cfg.mcpSessionContext,
      toolLedger: cfg.toolLedger,
      clientId: cfg.clientId,
      clientProfileName: cfg.clientProfileName,
      harnessId: cfg.harnessId,
      errorHandler: (error: Error, _terminate: boolean) => {
        const errorCategory = extractErrorCategory(error);
        this.emitError({ error: error.message, ...(errorCategory && { errorCategory }) });
      },
    };
  }

  /**
   * Create the onMessageSent callback for connector factories.
   *
   * Returns a callback that emits user_message.sent events to the global bus.
   * @returns Callback function for connector config
   */
  private createOnMessageSent(): (handle: MessageHandle) => void {
    return (handle) => {
      void this.emitGlobal(AgentSubjects.user_message.sent, {
        messageId: handle.messageId,
        content: handle.message,
        deliveryMode: handle.deliveryMode,
      });
    };
  }

  /**
   * Handle agent.cwd.change request — prefers native in-place change, falls back to connector swap.
   * @param ctx - Request context with newCwd payload
   */
  private async handleCwdChange(
    ctx: RequestContext<AgentCwdChangeRequestPayload, AgentCwdChangeResponsePayload>,
  ): Promise<void> {
    const result = await this.runtimeMutationManager.handleCwdChange(ctx.payload);
    ctx.setResult(result);
  }

  /**
   * Handle agent.model.change request — prefers native in-place change, falls back to connector swap.
   * @param ctx - Request context with newModel payload
   */
  private async handleModelChange(
    ctx: RequestContext<AgentModelChangeRequestPayload, AgentModelChangeResponsePayload>,
  ): Promise<void> {
    const result = await this.runtimeMutationManager.handleModelChange(ctx.payload);
    ctx.setResult(result);
  }

  /**
   * Handle agent.mcp.servers.set request — rebuilds immediately when idle or stages for the next turn.
   * @param ctx - Request context with replacement MCP session context
   */
  private async handleMcpServersSet(
    ctx: RequestContext<AgentMcpServersSetRequestPayload, AgentMcpServersSetResponsePayload>,
  ): Promise<void> {
    const result = await this.runtimeMutationManager.handleMcpServersSet(ctx.payload);
    ctx.setResult(result);
  }

  /**
   * Handle agent.credential.change request — defers when a turn is active, otherwise swaps connector.
   * @param ctx - Request context with credential change payload
   */
  private async handleCredentialChanged(
    ctx: RequestContext<AgentCredentialChangeRequestPayload, AgentCredentialChangeResponsePayload>,
  ): Promise<void> {
    const result = await this.runtimeMutationManager.handleCredentialChanged(ctx.payload);
    ctx.setResult(result);
  }

  /**
   * Wire adapter-specific connector events.
   * Called automatically during init() and connector swap.
   * Subclasses implement this to set up their event mappings.
   * @param connector - Connector instance to wire
   */
  protected abstract wireEvents(connector: TConnector): void | Promise<void>;

  /**
   * Subscribe to a connector subject and register its cleanup as connector wiring.
   *
   * Use this in adapter `wireEvents()` implementations so connector swaps can
   * remove old listeners before rewiring the new connector.
   * @param connector - Connector instance to subscribe on
   * @param subject - Subject definition to subscribe to
   * @param handler - Subject handler
   * @param options - Optional bus subscription options
   */
  protected subscribeConnector<
    Subject extends ScopedSubjectDefinition<
      TConnector extends AIAgentConnector<infer TBus> ? TBus['namespace'] : never
    >,
  >(connector: TConnector, subject: Subject, handler: HandlerForSubjectDefinition<Subject>, options?: OnOptions): void {
    const cleanup = connector.on(subject, handler, options);
    this.connectorLifecycleManager.addConnectorWiringCleanup(cleanup);
  }

  /**
   * Clean up resources and emit session closed event.
   *
   * Emits session.closed event (once per session) unless explicitly suppressed,
   * then unsubscribes from all bus handlers and aborts the connector if available.
   * @param options - Cleanup options; ephemeral agents suppress session-close lifecycle events because they never join a session.
   */
  public async close(options: { emitSessionClosed?: boolean } = {}): Promise<void> {
    if (options.emitSessionClosed ?? true) {
      this.emitSessionClosed('closed');
    }

    for (const cleanup of this.busHandlerCleanups) {
      try {
        cleanup();
      } catch (error) {
        console.warn(`[AIAgent] Bus handler cleanup failed:`, error);
      }
    }
    this.busHandlerCleanups = [];

    this.connectorLifecycleManager.clearConnectorWiring();

    await this.connector.close();
  }

  /**
   * Ensure the connector is initialized, throwing if not.
   * @returns The initialized connector instance
   * @throws Error if connector is not initialized
   */
  private ensureConnector(): TConnector {
    if (!this.connector) {
      throw new Error(`AIAgent ${this.agentId} connector not initialized. Call init() or start() first.`);
    }
    return this.connector;
  }

  /**
   * Determine whether to use native session resume or fresh with history.
   *
   * Native resume: SDK manages history, don't inject messageHistory, preserve cache.
   * Fresh with history: Create new session, inject messageHistory.
   *
   * Override in adapter-specific agents if needed.
   * @param sessionContext - Context signals from SessionOrchestrator
   * @returns true if native resume should be used
   */
  protected shouldUseNativeResume(sessionContext?: SessionContext): boolean {
    if (!this.supportsNativeResume()) {
      return false;
    }
    if (!sessionContext) return true;
    if (sessionContext.isFirstTurn) return false;
    if (sessionContext.hasCompression) return false;
    if (sessionContext.hasNewTransforms) return false;
    if (sessionContext.hasConnectorSwap) return false;
    return true;
  }

  /**
   * Whether this adapter supports native session resume.
   * Override in adapter-specific agents that can resume SDK sessions.
   * @returns true if native resume is supported
   */
  protected supportsNativeResume(): boolean {
    return false; // Default: no native resume support
  }

  /**
   * Start the agent with an initial message.
   *
   * Ensures the agent is initialized (idempotent) before delegating to the connector.
   * Runs PreUserMessage hooks before sending the message.
   * Uses sessionContext signals to decide between native resume and fresh with history.
   * HookAbortError propagates to caller.
   * @param message - User message (normalized or unnormalized)
   * @param options - Optional start options (e.g., delivery mode, sessionContext)
   * @returns Session ID, agent ID, and message handle for tracking
   */
  public async start(
    message: NormalizedMessageInput | MessageInput,
    options?: StartAgentOptions,
  ): Promise<AgentStartResult> {
    if (!this.initialized) {
      await this.init();
    }

    // Capture systemPrompt for reuse across connector swaps
    if (options?.systemPrompt !== undefined && this.runtimeSystemPrompt === undefined) {
      this.runtimeSystemPrompt = options.systemPrompt;
    }
    // Capture responseSchema for reuse across connector swaps
    if (options?.responseSchema !== undefined && this.runtimeResponseSchema === undefined) {
      this.runtimeResponseSchema = options.responseSchema;
    }
    return this.turnExecutor.executeStart(message, options, this.runtimeSystemPrompt, this.runtimeResponseSchema);
  }

  /**
   * Initialize the agent without sending a message (idle creation).
   * Ensures init() is called, then delegates to connector.initialize().
   * @param options - Optional initialization options (system prompt, sessionContext)
   */
  public async initialize(options?: StartAgentOptions): Promise<void> {
    // Capture systemPrompt for reuse across connector swaps
    if (options?.systemPrompt !== undefined && this.runtimeSystemPrompt === undefined) {
      this.runtimeSystemPrompt = options.systemPrompt;
    }
    // Capture responseSchema for reuse across connector swaps
    if (options?.responseSchema !== undefined && this.runtimeResponseSchema === undefined) {
      this.runtimeResponseSchema = options.responseSchema;
    }
    if (!this.initialized) {
      await this.init();
    }
    await this.ensureConnector().initialize(options);
  }

  protected async onBeforeEmitCompletion() {}

  protected async onMessageHandle(messageHandle: MessageHandle) {
    // Reset per-turn dedup so adapters that don't emit agent.started per turn
    // (e.g., codex emits thread_started once) can still fire agent.complete.
    this.lifecycleEmitter.resetTurnState();
    this.lifecycleTracker.track(messageHandle, (messageId, result) => {
      const errorStr = result.error instanceof Error ? result.error.message : result.error;
      void this.emitCompletion({
        message: result.result?.message,
        messageId,
        outcome: result.outcome,
        ...(errorStr && { error: errorStr }),
      });
    });
  }

  /**
   * Abort the agent immediately (panic mode).
   * Triggers AbortController which may cause provider errors.
   * Use close() for graceful shutdown instead.
   *
   * Emits session.closed event (once per session) then delegates
   * to the underlying connector's abort method.
   * @throws Error if connector is not initialized
   */
  public abort(): void {
    this.emitSessionClosed('aborted');
    this.ensureConnector().abort();
  }

  /**
   * Get session ID, waiting for provider to generate it if not yet available.
   *
   * Delegates to the underlying connector's getSessionId method.
   * @returns Session ID from provider
   * @throws Error if connector is not initialized
   */
  public async getAdapterSessionId(): Promise<string> {
    return this.ensureConnector().getAdapterSessionId();
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   *
   * Delegates to the underlying connector's complete method.
   * @returns Last message result or null if no messages processed
   * @throws Error if connector is not initialized
   */
  public async complete(): Promise<MessageResult | null> {
    return this.ensureConnector().complete();
  }

  /**
   * Creates a type-safe event mapping from connector events to scoped subjects or handlers.
   * @param sourceSubject - The connector subject to subscribe to
   * @param discriminator - The discriminator key within the message (e.g., 'type')
   * @param handlers - Map of discriminator values to target subjects or handler functions
   * @param nestedMessageProp - Property containing the discriminated union (e.g., 'msg'), or undefined for top-level
   * @returns Unsubscribe function for the connector event mapping subscription
   */
  protected createConnectorEventMapping<
    TSourceSubject extends ScopedSubjectDefinition<
      TConnector extends AIAgentConnector<infer TBus> ? TBus['namespace'] : never
    >,
    TNestedMessageProp extends keyof TSourceSubject['$meta']['payload'] | undefined = undefined,
    TMessage = TNestedMessageProp extends keyof TSourceSubject['$meta']['payload']
      ? TSourceSubject['$meta']['payload'][TNestedMessageProp]
      : TSourceSubject['$meta']['payload'],
    TDiscriminator extends DiscriminatorKeys<TMessage> = DiscriminatorKeys<TMessage>,
  >(
    sourceSubject: TSourceSubject,
    discriminator: TDiscriminator,
    handlers: ConnectorEventHandlers<TMessage, TDiscriminator>,
    nestedMessageProp?: TNestedMessageProp,
  ): () => void {
    const cleanup = createConnectorEventMapping(
      this.globalBus,
      this.connector,
      sourceSubject,
      nestedMessageProp,
      discriminator,
      handlers,
      this.enrichPayload.bind(this),
    );
    this.connectorLifecycleManager.addConnectorWiringCleanup(cleanup);
    return cleanup;
  }
}
