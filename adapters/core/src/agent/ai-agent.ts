/* eslint max-lines: ["error", { "max": 590, "skipBlankLines": true, "skipComments": true }] */
// AIAgent is the composition root and protected-API facade for all adapter
// agents: collaborator wiring plus thin delegates for subclasses. That facade
// role justifies exceeding the repo-wide max-lines default; substantial logic
// belongs in the agent-* collaborator modules, not here.
import type { IMakaioBus, OnOptions, ScopedBus } from '@makaio/bus-core';
import { MakaioBus } from '@makaio/bus-core';
import type { SetRequired } from 'type-fest';
import type {
  AgentContext,
  AgentIdentity,
  AgentStartResult,
  AgentInterruptRequestPayload,
  AgentInterruptResponsePayload,
  AIAgentConfig,
  ContextWindowInput,
  GetCapabilitiesResponsePayload,
  NormalizedCallUsage,
  SendMessageRequestPayload,
  SendMessageResponsePayload,
  StartAgentOptions,
} from './types.js';
import type { NormalizedMessageInput } from '../utils/index.js';
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
  type ProviderContext,
  type SessionContext,
  type SessionMessageBlock,
  type StartMode,
  type StepType,
  type BlockData,
  type SystemPrompt,
} from '@makaio/contracts';
import type { ConfigFactoryInput } from '../adapter/index.js';
import { AIAgentConnector } from '../connector/index.js';
import { MessageLifecycleTracker } from './message-lifecycle-tracker.js';
import { ToolCallTracker, type ResolveHints } from './tool-call-tracker.js';
import type { ToolOutputResult } from './agent-event-bridge.js';
import {
  buildConfigFactoryInput,
  extractErrorCategory,
  resolveSupportedReasoningLevels,
} from './agent-config-input.js';
import type { AgentConnectorConfigOverrides } from './types.js';
import { createStructuredOutputTerminalTransform } from './agent-structured-output-retry.js';
import type { AIModel } from '../types/ai-model.js';
import { AgentEventBridge } from './agent-event-bridge.js';
import { updateAgentActivityStatusBestEffort } from './agent-storage-status.js';
import { AgentTurnExecutor } from './agent-turn-executor.js';
import { AgentRuntimeMutationManager } from './agent-runtime-mutation-manager.js';
import { AgentConnectorLifecycleManager, type ConnectorSwapCommitGuard } from './agent-connector-lifecycle-manager.js';
import { registerAgentBusHandlers } from './agent-bus-handler-registrar.js';
import { AgentPayloadEmitter } from './agent-payload-emitter.js';
import { AgentLifecycleEmitter } from './agent-lifecycle-emitter.js';
import {
  createAgentConnectorLifecycleManager,
  createAgentEventBridge,
  createAgentLifecycleEmitter,
  createAgentRuntimeMutationManager,
  createAgentTurnExecutor,
} from './agent-internal-factories.js';
import { AgentStructuredOutputManager } from './agent-structured-output-manager.js';
import {
  closeConnectorRuntime,
  createConnectorRuntime,
  rollbackAgentInitialization,
  type ConnectorRuntimeHandle,
} from './connector-runtime.js';
import { AgentConnectorSwapCoordinator } from './agent-connector-swap-coordinator.js';
import { ConfirmedAdapterSessionTracker } from './agent-adapter-session-movement.js';
import { createAgentEmissionWiring } from './agent-emission-wiring.js';

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
  /** Connector and auth lease are replaced and released as one lifecycle unit. */
  private connectorRuntime: ConnectorRuntimeHandle<TConnector> | undefined;
  protected confirmedModel?: string;
  protected initialModel?: string;
  /** Owns the confirmed provider-session identity cache and the movement seam. */
  private readonly adapterSessionTracker: ConfirmedAdapterSessionTracker;
  /** Cleanup functions for bus subscriptions (stable, survive connector swap) */
  private busHandlerCleanups: Array<() => void> = [];
  /** Whether init() has been called */
  private initialized = false;
  /** Runtime system prompt captured from start/initialize, preserved across connector swaps. */
  private runtimeSystemPrompt?: SystemPrompt;
  /** Tracks message lifecycle and emits turn events (emission is lazy — safe as field initializer). */
  protected readonly lifecycleTracker = new MessageLifecycleTracker({
    emitGlobal: this.emitGlobal.bind(this),
  });
  /** Tracks tool.use → tool.output correlation across adapters. */
  protected readonly toolCallTracker = new ToolCallTracker();
  /** Event-focused helper for usage/tool/step emissions. */
  protected readonly eventBridge: AgentEventBridge;
  /** Shared turn pipeline for start/sendMessage paths. */
  private readonly turnExecutor: AgentTurnExecutor;
  /** Runtime mutation helper for cwd/model change handlers. */
  private readonly runtimeMutationManager: AgentRuntimeMutationManager;
  /** Connector lifecycle helper for swap/wiring ownership. */
  private readonly connectorLifecycleManager: AgentConnectorLifecycleManager<TBus, TConnector>;
  /** Serialized connector replacement and runtime-config publication owner. */
  private readonly connectorSwapCoordinator: AgentConnectorSwapCoordinator<TBus, TConnector>;
  /** Payload enrichment and global emission helper. */
  private readonly payloadEmitter: AgentPayloadEmitter;
  /** Stateful lifecycle emitter for start/complete/error/session.closed. */
  private readonly lifecycleEmitter: AgentLifecycleEmitter;
  /** Validates structured output before public terminal results and lifecycle events resolve. */
  private readonly structuredOutputManager: AgentStructuredOutputManager;
  /** Latest tracked message completion with agent-level terminal transforms applied. */
  private latestMessageCompletion?: Promise<MessageResult>;
  /** Current content block index within the turn, reset on each turn start */
  private currentBlockIndex = 0;
  /**
   * Start mode for the next `emitStart()` call (consume-on-read).
   *
   * Set before dispatch; {@link emitStart} reads and clears the slot so
   * subsequent calls within the same dispatch (e.g. Copilot SDK sub-turns)
   * fall back to `'rotation'`. The `undefined` initial value is safe —
   * every first-start path sets the mode before the connector fires.
   */
  private pendingStartMode: StartMode | undefined;
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
    this.adapterSessionTracker = new ConfirmedAdapterSessionTracker(this.globalBus, this.config);
    const setLastKnownAdapterSessionId = this.adapterSessionTracker.record.bind(this.adapterSessionTracker);
    this.payloadEmitter = createAgentEmissionWiring({
      globalBus: this.globalBus,
      host: this.config,
      lifecycleTracker: this.lifecycleTracker,
      adapterSessionTracker: this.adapterSessionTracker,
      getConnector: () => this.connector,
    });
    const emitGlobal = this.payloadEmitter.emitGlobal.bind(this.payloadEmitter);
    this.eventBridge = createAgentEventBridge({
      emitGlobal,
      toolCallTracker: this.toolCallTracker,
      lifecycleTracker: this.lifecycleTracker,
      getBlockIndex: this.getBlockIndex.bind(this),
      incrementBlockIndex: this.incrementBlockIndex.bind(this),
      getUsageModel: () => this.confirmedModel ?? this.initialModel,
    });
    this.connectorLifecycleManager = this.createConnectorLifecycleManager(emitGlobal, setLastKnownAdapterSessionId);
    this.connectorSwapCoordinator = new AgentConnectorSwapCoordinator(
      this.globalBus,
      this.connectorLifecycleManager,
      this.config,
      this.adapterSessionTracker.adoptResumeTarget.bind(this.adapterSessionTracker),
    );
    this.turnExecutor = createAgentTurnExecutor({
      agentId: this.agentId,
      adapterId: this.adapterId,
      sessionId: this.sessionId,
      adapterCapabilities: this.capabilities,
      globalBus: this.globalBus,
      getConnector: () => this.connector,
      shouldUseNativeResume: this.shouldUseNativeResume.bind(this),
      hasResumeTarget: () => this.config.resumeAdapterSessionId !== undefined,
      setPendingStartMode: this.setPendingStartMode.bind(this),
      onNativeResumeSuppressed: () => this.adapterSessionTracker.recordUnconfirmedMove(),
      onMessageHandle: this.onMessageHandle.bind(this),
      runDispatch: (dispatch) => this.runtimeMutationManager.runTurnDispatch(dispatch),
      ephemeral: this.config.ephemeral,
    });
    this.runtimeMutationManager = createAgentRuntimeMutationManager({
      agentId: this.agentId,
      sessionId: this.sessionId,
      globalBus: this.globalBus,
      getConnector: () => this.connector,
      runExclusive: (action) => this.connectorSwapCoordinator.runExclusive(action),
      swapConnectorUnlocked: this.connectorSwapCoordinator.swapConnectorUnlocked.bind(this.connectorSwapCoordinator),
      emitGlobal,
      getProviderContext: () => this.config.providerContext,
      setProviderContext: (providerContext: ProviderContext) => void (this.config.providerContext = providerContext),
      setReasoningEffort: (reasoningEffort) => void (this.config.reasoningEffort = reasoningEffort),
      setMcpSessionContext: (mcpSessionContext) => (this.config.mcpSessionContext = mcpSessionContext),
      resolveSupportedReasoningLevels: (model: string) => resolveSupportedReasoningLevels(this.availableModels, model),
    });
    this.lifecycleEmitter = createAgentLifecycleEmitter({
      agentId: this.agentId,
      globalBus: this.globalBus,
      emitGlobal,
      onBeforeEmitCompletion: this.onBeforeEmitCompletion.bind(this),
      clearMessageToolCalls: (messageId) => this.toolCallTracker.clearMessage(messageId),
    });
    this.structuredOutputManager = new AgentStructuredOutputManager({
      bus: this.globalBus,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterCapabilities: this.capabilities,
    });
  }

  /**
   * Create the connector lifecycle collaborator bound to this agent instance.
   * @param emitGlobal - Enriched global event emitter
   * @param setLastKnownAdapterSessionId - Sink for the latest confirmed provider session
   * @returns Connector lifecycle manager for this agent
   */
  private createConnectorLifecycleManager(
    emitGlobal: AgentPayloadEmitter['emitGlobal'],
    setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => void | Promise<void>,
  ): AgentConnectorLifecycleManager<TBus, TConnector> {
    return createAgentConnectorLifecycleManager<TBus, TConnector>({
      agentId: this.agentId,
      buildConfigInput: this.buildConfigInput.bind(this),
      configFactory: this.config.configFactory,
      connectorFactory: this.config.connectorFactory,
      prepareAuthRuntime: this.config.prepareAuthRuntime,
      createOnMessageSent: this.createOnMessageSent.bind(this),
      wireEvents: this.wireEvents.bind(this),
      emitGlobal,
      getConnectorRuntime: () => {
        if (this.connectorRuntime === undefined) {
          throw new Error(`AIAgent ${this.agentId} connector runtime is not initialized.`);
        }
        return this.connectorRuntime;
      },
      setConnectorRuntime: (runtime: ConnectorRuntimeHandle<TConnector>) => {
        this.connectorRuntime = runtime;
        this.connector = runtime.connector;
      },
      getRuntimeSystemPrompt: () => this.runtimeSystemPrompt,
      setLastKnownAdapterSessionId,
      announceAdapterSessionMoved: () => this.adapterSessionTracker.recordUnconfirmedMove(),
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

    // Step 3: Materialize auth and create connector with explicit lease ownership.
    const connectorRuntime = await createConnectorRuntime({
      config: fullConfig,
      connectorFactory: this.config.connectorFactory,
      onMessageSent: this.createOnMessageSent(),
      onAdapterSessionMoved: () => this.adapterSessionTracker.recordUnconfirmedMove(),
      prepareAuthRuntime: this.config.prepareAuthRuntime,
    });
    this.connectorRuntime = connectorRuntime;
    this.connector = connectorRuntime.connector;

    try {
      // One-shot consumption: the fork directive has been captured by the
      // connector's config.  Clear the agent-level copy so subsequent
      // buildConfigInput() calls (connector swaps, MCP server changes,
      // credential rotations) never re-fork the source session.
      this.config.nativeFork = undefined;

      this.busHandlerCleanups.push(
        ...registerAgentBusHandlers({
          globalBus: this.globalBus,
          agentId: this.agentId,
          sessionId: this.sessionId,
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
          onCwdChange: (payload) => this.runtimeMutationManager.handleCwdChange(payload),
          onModelChange: (payload) => this.runtimeMutationManager.handleModelChange(payload),
          onMcpServersSet: (payload) => this.runtimeMutationManager.handleMcpServersSet(payload),
          onCredentialChange: (payload) => this.runtimeMutationManager.handleCredentialChanged(payload),
          onTurnStarted: (turnNumber) => this.connector.setCanonicalTurnNumber(turnNumber),
          onMcpToolsChanged: () => this.connector.markToolRefreshPending(),
        }),
        ...this.structuredOutputManager.registerDefaultHandlers(),
      );

      await this.connectorLifecycleManager.wireAllConnectorEvents(this.connector);

      this.initialized = true;
    } catch (error) {
      const handlerCleanups = this.busHandlerCleanups;
      this.busHandlerCleanups = [];
      this.connectorLifecycleManager.clearConnectorWiring();
      this.connectorRuntime = undefined;
      await rollbackAgentInitialization({
        runtime: connectorRuntime,
        handlerCleanups,
        primaryError: error,
        agentId: this.agentId,
      });
    }
  }

  /**
   * Emit `agent.started` with the pending start mode (consume-on-read).
   *
   * Reads and clears {@link pendingStartMode}; subsequent calls within
   * the same dispatch fall back to `'rotation'`.
   * @param event - Optional additional fields to merge into the payload
   */
  protected async emitStart(
    event?: Omit<
      AgentStarted,
      'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId' | 'model' | 'cwd' | 'startMode'
    >,
  ) {
    const startMode = this.pendingStartMode ?? 'rotation';
    this.pendingStartMode = undefined;
    this.currentBlockIndex = 0;
    await this.lifecycleEmitter.emitStart({
      model: this.connector.model,
      cwd: this.connector.cwd,
      startMode,
      ...event,
    });
  }

  /**
   * Set the start mode for the next `emitStart()` invocation.
   *
   * Called by the turn executor or `initialize()` before dispatching to
   * the connector. The value is consumed (cleared) by the first
   * `emitStart()` call, enforcing the one-shot invariant.
   * @param mode - The start mode to embed in the next `agent.started` event
   */
  public setPendingStartMode(mode: StartMode): void {
    this.pendingStartMode = mode;
  }

  protected async emitCompletion(result: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>) {
    await this.lifecycleEmitter.emitCompletion(result);
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
  protected async enrichPayload<T extends object>(payload: T): Promise<T & AgentIdentity & { messageId?: string }> {
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
   * Emit a tool.use event for an explicitly identified originating message.
   * @param messageId - Message that owns the tool call
   * @param toolName - Name of the tool being invoked
   * @param args - Tool arguments
   * @param nativeId - Provider-native tool call identifier
   * @returns Correlation identifier used for the call
   */
  protected async emitToolUse(
    messageId: string,
    toolName: string,
    args?: Record<string, unknown>,
    nativeId?: string,
  ): Promise<string> {
    return this.eventBridge.emitToolUse(messageId, toolName, args, nativeId);
  }
  /**
   * Emit a tool.output event for an explicitly identified originating message.
   * @param messageId - Message that owns the tool call
   * @param output - Tool output content
   * @param hints - Provider correlation hints
   * @returns Resolved tool-call metadata
   */
  protected async emitToolOutput(messageId: string, output: string, hints: ResolveHints): Promise<ToolOutputResult> {
    return this.eventBridge.emitToolOutput(messageId, output, hints);
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
    updateAgentActivityStatusBestEffort(this.globalBus, this.agentId, 'active');

    this.lifecycleTracker.setCurrentTurnId(ctx.payload.turnId);
    try {
      const result = await this.turnExecutor.executeSendMessage(ctx.payload);
      ctx.setResult(result);
    } catch (error) {
      // On success, lifecycleTracker.complete() clears turnId when the handle finishes. This
      // catch-only path covers errors before a handle is tracked — nothing else would clear it.
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
   * Serializes the complete create-before-close pattern with rollback for safety:
   * 1. Create new connector first (old connector still alive)
   * 2. Wire and initialize the replacement (accumulate cleanups separately)
   * 3. Run the final guard and commit any selected managed account
   * 4. Synchronously publish the ready replacement, then close the old runtime
   * 5. On any pre-publication failure: close the replacement, restore old wiring, and roll back account selection
   *
   * This ensures the agent always has a working connector, even if factory or wiring fails.
   *
   * Preserves runtime overrides across sequential swaps by using current connector values
   * as baseline for non-overridden fields.
   * @param configOverrides - Optional config overrides (e.g., new cwd, model)
   * @param beforeCommit - Optional guard executed before replacing the active connector
   * @throws Error if connector is currently processing a turn
   */
  public async swapConnector(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
  ): Promise<void> {
    // Resume-decision publication happens inside the coordinator's serialized
    // swap transaction so queued swaps can never observe the stale target.
    await this.connectorSwapCoordinator.swapConnector(configOverrides, beforeCommit);
  }

  /**
   * Build config factory input from agent config with optional overrides.
   *
   * Delegates to {@link buildConfigFactoryInput} with live connector-derived
   * values (reasoning effort) and the agent's error sink.
   * @param overrides - Optional field overrides (e.g., cwd, model, adapterSessionId)
   * @returns ConfigFactoryInput ready for config factory
   */
  private buildConfigInput(overrides?: AgentConnectorConfigOverrides): ConfigFactoryInput<TBus> {
    return buildConfigFactoryInput({
      config: this.config,
      availableModels: this.availableModels,
      currentReasoningEffort: this.connector?.currentReasoningEffort ?? this.config.reasoningEffort,
      clearAllToolCalls: this.toolCallTracker.clearAll.bind(this.toolCallTracker),
      overrides,
    });
  }

  /**
   * Create the onMessageSent callback for connector factories.
   *
   * Returns a callback that emits user_message.sent events to the global bus.
   * @returns Callback function for connector config
   */
  private createOnMessageSent(): (handle: MessageHandle) => void {
    return (handle) => {
      // user_message.sent describes the message being submitted, not the
      // executing turn — and it fires before the handle is tracked. Neither
      // enrichment's getCurrentTurnId() (resolves to the still-executing
      // turn) nor any shared tracker field (mutable — overlapping sends
      // overwrite it before a hook-delayed first send emits) is safe here.
      // The handle carries its lifecycle turnId (threaded from
      // agent.sendMessage.turnId at dispatch); requestCorrelation.turnId is
      // deliberately NOT used — it is transport correlation and may exist
      // when no lifecycle turn does, which would leave sent unpaired with
      // acknowledged/completed. The key is set even when undefined so a
      // no-turn submission stays turn-less instead of inheriting the
      // executing turn's id via enrichment.
      void this.emitGlobal(AgentSubjects.user_message.sent, {
        messageId: handle.messageId,
        content: handle.message,
        deliveryMode: handle.deliveryMode,
        turnId: handle.turnId,
      });
    };
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

    const runtime = this.connectorRuntime;
    this.connectorRuntime = undefined;
    if (runtime !== undefined) {
      await closeConnectorRuntime(runtime);
    }
  }

  /**
   * Ensure the connector is initialized, throwing if not.
   * @returns The initialized connector instance
   */
  private ensureConnector(): TConnector {
    if (this.connectorRuntime === undefined) {
      throw new Error(`AIAgent ${this.agentId} connector not initialized. Call init() or start() first.`);
    }
    return this.connector;
  }

  /**
   * Determine whether to use native session resume (SDK manages history) or
   * fresh-with-history (new session, injected messageHistory).
   * @param sessionContext - Context signals from SessionOrchestrator
   * @returns true if native resume should be used
   */
  protected shouldUseNativeResume(sessionContext?: SessionContext): boolean {
    if (!this.supportsNativeResume()) {
      return false;
    }
    if (!sessionContext) return true;
    if (sessionContext.nativeLocality?.kind !== 'native') return false;
    if (sessionContext.isFirstTurn) return false;
    if (sessionContext.hasCompression) return false;
    if (sessionContext.hasNewTransforms) return false;
    if (sessionContext.hasConnectorSwap) return false;
    return true;
  }

  /**
   * Whether this adapter supports native session resume. Override in concrete agents.
   * @returns true if native resume is supported
   */
  protected supportsNativeResume(): boolean {
    return false;
  }
  /**
   * Whether this adapter supports provider-native session fork.
   * Override in concrete agents that can branch from an existing provider session.
   * @returns true if native fork is supported
   */
  protected supportsNativeFork(): boolean {
    return false;
  }

  /**
   * Start the agent with an initial message.
   *
   * Ensures the agent is initialized (idempotent), runs PreUserMessage hooks,
   * and uses sessionContext signals to decide between native resume and fresh
   * with history. HookAbortError propagates to caller.
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
    return this.turnExecutor.executeStart(message, options, this.runtimeSystemPrompt, options?.responseSchema);
  }

  /**
   * Initialize idle (no message). Returns confirmed adapter session ID or `undefined`
   * when the provider has not yet confirmed (idle fork sessions).
   * @param options - Optional initialization options (system prompt, sessionContext)
   * @returns Confirmed adapter session ID, or `undefined` for unconfirmed fork sessions.
   */
  public async initialize(options?: StartAgentOptions): Promise<string | undefined> {
    if (options?.systemPrompt !== undefined && this.runtimeSystemPrompt === undefined) {
      this.runtimeSystemPrompt = options.systemPrompt;
    }
    // Capture fork directive before init() consumes it (one-shot invariant).
    const preInitNativeFork = this.config.nativeFork;
    if (!this.initialized) {
      await this.init();
    }
    // Derive start mode so emitStart() carries the correct mode.
    const sessionContext = options?.sessionContext;
    const enrichedCtx =
      preInitNativeFork && !sessionContext?.nativeFork
        ? { ...sessionContext, nativeFork: preInitNativeFork }
        : sessionContext;
    const hasResumeTarget = this.config.resumeAdapterSessionId !== undefined;
    const initMode = AgentTurnExecutor.deriveStartMode(
      enrichedCtx,
      this.shouldUseNativeResume(enrichedCtx),
      hasResumeTarget,
    );
    this.setPendingStartMode(initMode);

    const connector = this.ensureConnector();
    await connector.initialize(options);
    return connector.getConfirmedAdapterSessionId();
  }

  protected async onBeforeEmitCompletion() {}
  protected async onMessageHandle(messageHandle: MessageHandle, turnId?: string) {
    this.latestMessageCompletion = messageHandle.waitForCompletion();
    const responseSchema = messageHandle.responseSchema;
    const transformTerminal =
      responseSchema === undefined
        ? undefined
        : createStructuredOutputTerminalTransform({
            structuredOutputManager: this.structuredOutputManager,
            getConnector: () => this.connector,
            sessionId: this.sessionId,
            messageHandle,
            responseSchema,
          });

    this.lifecycleTracker.track(
      messageHandle,
      (messageId, result, turnId) => {
        const error = result.error;
        const errorStr = error instanceof Error ? error.message : error;
        const errorCategory = error instanceof Error ? extractErrorCategory(error) : undefined;
        void this.emitCompletion({
          message: result.result?.message,
          messageId,
          ...(turnId !== undefined && { turnId }),
          outcome: result.outcome,
          ...(errorStr && { error: errorStr }),
          ...(errorCategory && { errorCategory }),
          ...(result.structuredOutputValidation !== undefined
            ? { structuredOutputValidation: result.structuredOutputValidation }
            : {}),
        });
      },
      transformTerminal,
      { turnId },
    );
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
   * Announce the provider session this generation resolved to, through the
   * agent's own movement tracker.
   *
   * For producers outside the turn pipeline — cold rehydration resolves an
   * identity before the agent has emitted anything, so payload enrichment has
   * not run yet. Routing through the tracker rather than emitting on the seam
   * directly is what keeps an undelivered announcement retryable: the tracker's
   * acknowledged-announcement marker is the retry anchor, and the agent's next
   * emitted event re-drives the announcement. It also makes the announcement
   * idempotent against that first enrichment call instead of duplicating it.
   * @param adapterSessionId - Provider session ID this generation is current on
   * @returns Promise resolving once the announcement attempt completed
   */
  public async recordConfirmedAdapterSession(adapterSessionId: string): Promise<void> {
    await this.adapterSessionTracker.record(adapterSessionId);
  }

  /**
   * Provider session this agent is currently the live writer of.
   *
   * The occupancy authority for the adapter's registry. Synchronous on purpose:
   * the claim check serializing two concurrent resume attaches reads it inside a
   * critical section, which {@link getAdapterSessionId} — awaiting the connector —
   * cannot serve. Current before any movement is announced, because the tracker
   * caches a confirmed identity before announcing it; that ordering is what lets a
   * concurrent attach see this agent occupying the session the same announcement
   * publishes as resume currency.
   * @returns Last provider-confirmed session ID, or `undefined` before the first confirmation
   */
  public get currentAdapterSessionId(): string | undefined {
    return this.adapterSessionTracker.lastKnownAdapterSessionId;
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   *
   * Waits for the connector to finish, then returns the agent-level terminal
   * result so structured-output transforms are reflected in direct callers.
   * @returns Last message result or null if no messages processed
   * @throws Error if connector is not initialized
   */
  public async complete(): Promise<MessageResult | null> {
    const connectorResult = await this.ensureConnector().complete();
    if (connectorResult === null || this.latestMessageCompletion === undefined) return connectorResult;
    return this.latestMessageCompletion;
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
