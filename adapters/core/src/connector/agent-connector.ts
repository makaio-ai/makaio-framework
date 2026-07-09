// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 590 }] */
import { MakaioBus, NoHandlerError, OnOptions, RequestError } from '@makaio/bus-core';
import type { IFilteredBus, IMakaioBus, ScopedBus } from '@makaio/bus-core';
import {
  DirectoryNotFoundError,
  type HandlerForSubjectDefinition,
  type ScopedSubjectDefinition,
  type SubjectRecord,
} from '@makaio/core';
import type { SystemPrompt, AIReasoningLevel } from '@makaio/contracts';
import type {
  AgentStartResult,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  EmitteryEvents,
  BaseAgentConnectorConfig,
} from '../agent/types.js';
export type { BaseAgentConnectorConfig };
import { cleanEnvForAdapter } from '../utils/index.js';
import { DeferredPromise } from '@makaio/utils';
import Emittery from 'emittery';
import { getProcessingStateUpdates } from '../utils/getProcessingStateUpdates.js';
import {
  MessageHandle,
  type MessageHandleOptions,
  type MessageResult,
  type ProcessingState,
} from '../message-handle/index.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';
import * as process from 'node:process';
import * as fs from 'node:fs';
import os from 'node:os';
import type { UnknownRecord } from 'type-fest';
import { resolveTimeouts, type TrackedTimeoutConfig } from '@makaio/utils';

type Forbid<T, K extends PropertyKey> = Omit<T, K> & { [P in K]?: never };
type ForbiddenKeys = 'agentId' | 'adapterId' | 'adapterSessionId' | 'adapterName' | 'sessionId';
/** Extract Subjects type parameter from a ScopedBus */
type ExtractScopedBusSubjects<T> = T extends { withFilter: (...args: unknown[]) => IFilteredBus<string, infer S> }
  ? S
  : T extends ScopedBus<string, infer S>
    ? S
    : SubjectRecord;

/**
 * Abstract base class for AI agent implementations.
 *
 * Each adapter provides its own message queue implementation (UserMessageQueue).
 * This base class provides common infrastructure for state management, bus operations,
 * and error handling.
 * @typeParam TBus - Scoped bus type for adapter namespace
 */
export abstract class AIAgentConnector<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> {
  /** Unique identifier for this agent instance. */
  protected readonly agentId: string;
  /** Session ID from the provider (set after connection/start). */
  public adapterSessionId?: string;
  /** Makaio session ID for cross-session correlation and approval routing. */
  protected readonly sessionId?: string;
  /** Currently active message handle waiting for completion. */
  protected pendingMessageHandle?: MessageHandle;
  /** Scoped event bus for adapter-specific emission; global bus owns cross-namespace runtime requests. */
  private readonly scopedBus: Pick<IFilteredBus<TBus['namespace'], ExtractScopedBusSubjects<TBus>>, 'emit' | 'request'>;
  protected readonly globalBus: IMakaioBus;
  /** Filtered event bus for agent-specific (filtered by agentId) message handling. */
  private readonly filteredBus: Pick<IFilteredBus<TBus['namespace'], ExtractScopedBusSubjects<TBus>>, 'on' | 'once'>;
  /** Optional error handler callback. */
  protected readonly errorHandler?: (error: Error, terminate: boolean) => void;
  /** Deferred promise for interrupt coordination. */
  protected deferredInterrupt: DeferredPromise<void> | undefined;
  /**
   * Raw state emitter stays private so subclasses use updateProcessingState()
   * and the public subscription methods instead of coupling to Emittery internals.
   */
  private readonly emittery = new Emittery<EmitteryEvents>();
  /** Current processing state of the agent. */
  private processingState: ProcessingState = 'idle';
  /** Adapter identifier shared across instances of the same adapter type. */
  public readonly adapterId: string;
  /** Resolved timeout configuration with provenance tracking. */
  protected readonly timeouts: TrackedTimeoutConfig;
  protected lastResult: MessageResult | null = null;
  protected readonly config: TConfig & { adapterId: string };
  /** Model used for this agent (subclasses may update when SDK confirms actual model) */
  public model: string;
  /** ProviderConfig UUID used during agent creation, carried for runtime introspection */
  public providerConfigId?: string;
  /** Working directory for agent execution */
  public cwd: string;
  /** Current reasoning effort level, updated by changeReasoningInPlace. */
  public currentReasoningEffort: AIReasoningLevel | undefined;
  /**
   * Reasoning levels supported by the current model, forwarded from the config factory.
   * `undefined` when the model does not declare reasoning support.
   */
  public supportedReasoningLevels: BaseAgentConnectorConfig['supportedReasoningLevels'];
  protected readonly env: Record<string, string>;
  /** Monotonically-increasing turn counter for MCP ledger bookkeeping. */
  private _currentTurnNumber = 0;
  /** Pending canonical turn number staged by {@link setCanonicalTurnNumber}. */
  private _pendingCanonicalTurnNumber: number | undefined;
  /** Adapter type name for event identification. */
  protected readonly adapterName: string;
  /** Runtime system prompt from start/initialize options. */
  protected systemPrompt?: SystemPrompt;

  protected constructor(config: BaseAgentConnectorConfig<TBus> & { adapterId: string }) {
    const cwd = config.cwd ?? os.tmpdir();
    if (!fs.existsSync(cwd)) throw new DirectoryNotFoundError(cwd);
    this.agentId = config.agentId ?? crypto.randomUUID();
    this.scopedBus = config.bus;
    this.globalBus = config.globalBus ?? MakaioBus;
    this.filteredBus = config.bus.withFilter({
      agentId: this.agentId,
    });
    this.adapterId = config.adapterId;
    this.adapterName = config.adapterName;
    this.adapterSessionId = config.adapterSessionId;
    this.sessionId = config.sessionId;

    // Resolve timeouts from config (required)
    this.timeouts = config.timeouts ?? resolveTimeouts([]);

    this.errorHandler = config.errorHandler;
    this.model = config.model;
    this.providerConfigId = config.providerConfigId;
    this.cwd = cwd;
    this.currentReasoningEffort = config.reasoningEffort;
    this.supportedReasoningLevels = config.supportedReasoningLevels;
    this.config = config as TConfig & { adapterId: string };
    this.env = cleanEnvForAdapter(config?.env ?? process.env);
  }

  /**
   * Get the current processing state of the agent.
   * @returns The current processing state
   */
  public getProcessingState(): ProcessingState {
    return this.processingState;
  }

  /**
   * Handle pause after rejection or error.
   * Subclasses should clear pending messages as appropriate.
   * @param _reason - Reason for pause ('rejection' | 'error'); available for subclass overrides
   */
  protected handlePause(_reason: 'rejection' | 'error') {
    void this.updateProcessingState('paused');
  }

  /**
   * Store runtime system prompt for session creation.
   * Subclasses may override to apply SDK-specific side effects (e.g., Gemini's setSystemInstruction).
   * @param prompt - System prompt from start/initialize options
   */
  protected captureSystemPrompt(prompt: SystemPrompt | undefined): void {
    if (prompt === undefined) return;
    this.systemPrompt = prompt;
  }

  /**
   * Update the agent's processing state.
   * State transitions trigger events via emittery.
   * @param state - New processing state
   */
  protected async updateProcessingState(state: ProcessingState): Promise<void> {
    const stateUpdate = getProcessingStateUpdates(this.processingState, state);

    if (!stateUpdate) return;

    const { statesToEmit } = stateUpdate;

    this.processingState = state;
    for (const stateToEmit of statesToEmit) {
      await this.emittery.emit('processingStateChanged', stateToEmit);
    }
  }

  /**
   * Subscribe to processing state changes (idle ↔ processing transitions).
   * @param handler - Called with `{ isProcessing: boolean }` on each state change
   * @returns Unsubscribe function
   */
  public onProcessingStateChanged(
    handler: (payload: EmitteryEvents['processingStateChanged']) => Promise<void> | void,
  ) {
    return this.emittery.on('processingStateChanged', handler);
  }

  /**
   * Wait for a single processing state change matching an optional predicate.
   * @param predicate - Optional filter, e.g., `(e) => !e.isProcessing` for idle
   * @returns Promise resolving to `{ isProcessing: boolean }`
   */
  public async onceProcessingStateChanged(
    predicate?: (eventData: EmitteryEvents['processingStateChanged']) => boolean,
  ) {
    return this.emittery.once('processingStateChanged', predicate);
  }

  /**
   * Initialize the connector's SDK session without sending a message.
   * Must set adapterSessionId before returning.
   * Called by createAgent for idle agent setup.
   * Implementations MUST be idempotent (no-op if already initialized).
   * @param options - Optional start options (e.g., systemPrompt for Claude)
   */
  public abstract initialize(options?: ConnectorStartOptions): Promise<void>;

  /**
   * Start agent with initial message.
   * @param message - Normalized user message (role and content)
   * @param options - Optional start options (e.g., delivery mode)
   * @returns Session ID, agent ID, and message handle for tracking
   */
  public abstract start(message: NormalizedMessageInput, options?: ConnectorStartOptions): Promise<AgentStartResult>;

  /**
   * Send a message to the agent.
   * For initial message, use start() instead.
   * @param message - Normalized message content
   * @param options - Send options (e.g., delivery mode, message ID)
   * @returns Message handle for tracking
   */
  public abstract sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle>;

  /**
   * Abort the agent and cleanup resources (panic mode).
   * Triggers AbortController which may cause provider errors.
   * Use close() for graceful shutdown instead.
   */
  public abstract abort(): void;

  /**
   * Gracefully close the agent session.
   * Unlike abort(), this doesn't trigger AbortController errors.
   * Use this for normal shutdown; use abort() for emergency termination.
   */
  public abstract close(): Promise<void>;

  /**
   * Get session ID, waiting for provider to generate it if not yet available.
   * @returns Session ID from provider
   */
  public abstract getAdapterSessionId(): Promise<string>;

  /**
   * Provider-confirmed adapter session ID, or `undefined` when unconfirmed.
   * Default returns `this.adapterSessionId`; Claude connectors override to
   * defer until `system.init` confirms the provider-side session.
   * @returns Confirmed ID or `undefined`
   */
  public getConfirmedAdapterSessionId(): string | undefined {
    return this.adapterSessionId;
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   * @returns Last message result or null if no messages processed
   */
  public abstract complete(): Promise<MessageResult | null>;

  /**
   * Create a MessageHandle with standard initialization (messageId, adapterSessionId, onMessageSent).
   * @param message - Normalized user message
   * @param options - Optional message options (id, delivery mode, history, and turn context)
   * @returns Initialized MessageHandle instance
   */
  protected createMessageHandle(message: NormalizedMessageInput, options?: MessageHandleOptions): MessageHandle {
    const messageId = options?.messageId ?? crypto.randomUUID();
    const handle = new MessageHandle(
      messageId,
      message,
      options?.deliveryMode ?? 'enqueue',
      options?.messageHistory,
      options?.turnContext,
      options?.responseSchema,
      options?.internalRetry ?? false,
      options?.cacheStrategy,
      options?.requestCorrelation === undefined ? undefined : { ...options.requestCorrelation, messageId },
    );
    handle.adapterSessionId = this.adapterSessionId;
    // Suppress user_message.sent for internal retry turns — the retry is an
    // implementation detail and should not be surfaced as a new user message.
    if (!options?.internalRetry) {
      this.config.onMessageSent?.(handle);
    }
    return handle;
  }

  /** Signal MCP tools changed; connectors with direct-inject refresh override this. */
  public markToolRefreshPending(): void {
    // Default: no-op. Connectors that manage direct-inject MCP tools override this.
  }

  /**
   * Stage the canonical orchestrator-assigned turn number for consumption by the next
   * {@link consumeTurnNumber} call. The counter is monotonically increasing.
   * @param turnNumber - Canonical 1-based turn number from SessionOrchestrator
   * @throws RangeError when the value is invalid, regresses, or downgrades a staged value
   */
  public setCanonicalTurnNumber(turnNumber: number): void {
    if (!Number.isInteger(turnNumber) || turnNumber < 1) {
      throw new RangeError(`setCanonicalTurnNumber: expected positive integer, got ${turnNumber}`);
    }
    if (turnNumber <= this._currentTurnNumber) {
      throw new RangeError(`setCanonicalTurnNumber: ${turnNumber} ≤ current (${this._currentTurnNumber})`);
    }
    if (this._pendingCanonicalTurnNumber !== undefined && turnNumber < this._pendingCanonicalTurnNumber) {
      throw new RangeError(`setCanonicalTurnNumber: ${turnNumber} < pending (${this._pendingCanonicalTurnNumber})`);
    }
    this._pendingCanonicalTurnNumber = turnNumber;
  }

  /**
   * Advance to the next turn number, consuming any pending canonical value.
   * Orchestrator-staged values win; otherwise the local counter increments by one.
   * @returns The current turn number after advancement
   */
  protected consumeTurnNumber(): number {
    if (this._pendingCanonicalTurnNumber !== undefined) {
      this._currentTurnNumber = this._pendingCanonicalTurnNumber;
      this._pendingCanonicalTurnNumber = undefined;
      return this._currentTurnNumber;
    }
    this._currentTurnNumber += 1;
    return this._currentTurnNumber;
  }

  /**
   * Current turn number (read-only). Use {@link consumeTurnNumber} to advance.
   * @returns The current turn number
   */
  protected get currentTurnNumber(): number {
    return this._currentTurnNumber;
  }

  /**
   * Staged canonical turn number, or `undefined` if none was staged.
   * @returns The pending canonical turn number
   */
  protected get pendingTurnNumber(): number | undefined {
    return this._pendingCanonicalTurnNumber;
  }

  /**
   * Attempt to change the model without a connector swap.
   * Subclasses override when the SDK supports in-place model changes.
   * Base implementation returns false (swap required).
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.model` directly.
   * The caller (AIAgent.handleModelChange) owns the `this.model` field update after
   * a successful in-place change. Implementations only configure the SDK-internal model
   * (e.g., `query.setModel()`, `geminiConfig.setModel()`).
   * @param _newModel - The model identifier to switch to
   * @returns true if changed in-place, false if swap needed. Exceptions are caught by the
   * caller and treated as false (automatic swap fallback), so implementations need not guard.
   */
  public async changeModelInPlace(_newModel: string): Promise<boolean> {
    return false;
  }

  /**
   * Attempt to change the working directory without a connector swap.
   * Subclasses override when the adapter supports in-place cwd changes (e.g., stateless APIs).
   * Base implementation returns false (swap required).
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.cwd` directly.
   * The caller (AIAgent.handleCwdChange) owns the `this.cwd` field update after
   * a successful in-place change. Implementations only update SDK-internal state.
   * @param _newCwd - The working directory path to switch to
   * @returns true if changed in-place, false if swap needed. Exceptions are caught by the
   * caller and treated as false (automatic swap fallback), so implementations need not guard.
   */
  public async changeCwdInPlace(_newCwd: string): Promise<boolean> {
    return false;
  }

  /**
   * Attempt to change reasoning effort without swapping the connector.
   *
   * Override in subclasses that support in-place reasoning changes (e.g., adapters
   * that pass reasoning parameters per-request rather than at session-creation time).
   * The base implementation returns `false` so callers fall back to a connector swap.
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.currentReasoningEffort`
   * directly. The caller owns the `currentReasoningEffort` field update after a successful
   * in-place change. Implementations only configure the SDK-internal reasoning parameter.
   * @param _newLevel - The new reasoning effort level to apply
   * @returns `true` if the change was applied in-place, `false` if a connector swap is needed
   */
  public async changeReasoningInPlace(_newLevel: AIReasoningLevel): Promise<boolean> {
    return false;
  }

  /**
   * Interrupt the current message processing.
   * @returns Promise that resolves when interrupt is handled
   */
  public abstract interrupt(): Promise<void>;

  /**
   * Marks pending message as failed, calls error handler, resolves completion promise.
   * @param error - Error that occurred
   * @param terminate - Whether to abort the agent after handling error
   * @internal
   */
  public handleError(error: unknown, terminate = false): void {
    const err = error instanceof Error ? error : new Error(String(error));

    // Log sanitized error metadata — avoid leaking provider/user content
    // from err.message into logs. Full error is forwarded via errorHandler.
    console.warn(
      `[AIAgentConnector:handleError] pendingMessageHandle=${this.pendingMessageHandle?.messageId}, errorType=${err.name}, terminate=${terminate}`,
    );

    this.errorHandler?.(err, terminate);

    // Mark pending message as completed (with error) to unblock completion queue
    if (this.pendingMessageHandle) {
      this.pendingMessageHandle.markCompleted({
        outcome: 'error',
        error: err,
      });
      this.pendingMessageHandle = undefined;
      this.handlePause('error');
    }

    if (terminate) {
      this.abort();
    }
  }

  protected handleToolApprovalDenied(abort: 'not_requested' | 'not_supported' | 'handled', details?: string) {
    if (abort !== 'not_requested') {
      queueMicrotask(() => {
        this.handleError(new Error(`Tool use denied by approval handler: ${details}`), false);
      });
    }
  }

  public getAgentId() {
    return this.agentId;
  }

  public getAdapterName() {
    return this.adapterName;
  }

  /**
   * Get timeout value for a specific category.
   * @param category - Timeout category (initialization, acknowledgement, completion, toolApproval, eventWait)
   * @returns Timeout value in milliseconds
   */
  public getTimeoutMs(category: keyof typeof this.timeouts.values): number {
    return this.timeouts.values[category];
  }

  /**
   * Request tool approval via the scoped bus with auto-injected metadata.
   *
   * Wraps `scopedBus.request()` to automatically include connector identity
   * (adapterName, agentId, adapterId, adapterSessionId) in the payload.
   * @param subject - Subject definition for the tool approval request
   * @param payload - Request payload (metadata fields are forbidden and auto-injected)
   * @returns Promise resolving to the approval response
   */
  protected requestToolApproval<TSubject extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: TSubject,
    payload: Forbid<TSubject['$meta']['payload']['request'], ForbiddenKeys>,
  ): Promise<TSubject['$meta']['payload']['response']> {
    return this.scopedBus.request(subject, {
      ...payload,
      adapterName: this.adapterName,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterSessionId: this.adapterSessionId,
      sessionId: this.sessionId,
    } as UnknownRecord);
  }

  /**
   * Execute a tool approval request with the shared diagnostics wrapper.
   *
   * Handles the common `RequestError`/`NoHandlerError` path by logging a helpful
   * message via `handleError` and re-throwing so callers can decide whether to
   * surface the failure or fall back to a denial.
   * @param subject - Scoped subject definition for the tool approval request
   * @param payload - Payload that must not include adapter metadata
   * @returns Tool approval response payload
   */
  protected async requestToolApprovalWithHandling<TSubject extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: TSubject,
    payload: Forbid<TSubject['$meta']['payload']['request'], ForbiddenKeys>,
  ): Promise<TSubject['$meta']['payload']['response']> {
    return this.requestToolApproval(subject, payload).catch((error) => {
      let errorToHandle = error;
      if (error instanceof RequestError || error instanceof NoHandlerError) {
        errorToHandle = new Error(
          "Tool approval request failed, make sure that there's a handler registered: " + error.message,
        );
      }
      this.handleError(errorToHandle, false);
      throw error;
    });
  }

  /**
   * Emit an event via the scoped bus with auto-injected metadata.
   *
   * Wraps `scopedBus.emit()` to automatically include connector identity
   * (adapterName, agentId, adapterId, adapterSessionId) in the payload.
   * @param subject - Subject definition for the event
   * @param payload - Event payload (metadata fields are forbidden and auto-injected)
   * @returns Promise that resolves when the event is emitted
   */
  protected emit<TSubject extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: TSubject,
    payload: Forbid<TSubject['$meta']['payload'], ForbiddenKeys>,
  ): Promise<void> {
    return this.scopedBus.emit(subject, {
      ...payload,
      adapterName: this.adapterName,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterSessionId: this.adapterSessionId,
    } as UnknownRecord);
  }

  /**
   * Subscribe to events on the filtered bus (pre-filtered by agentId).
   *
   * Uses `filteredBus` which only delivers events matching this connector's agentId.
   * @param subject - Subject definition to subscribe to
   * @param handler - Event handler receiving the event context
   * @param options - Optional subscription options (e.g., priority)
   * @returns Unsubscribe function
   */
  public on<Subject extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
    options?: OnOptions,
  ) {
    return this.filteredBus.on(subject, handler, options);
  }

  /**
   * Wait for a single event on the filtered bus (pre-filtered by agentId).
   *
   * Uses `filteredBus` which only delivers events matching this connector's agentId.
   * @param subject - Subject definition to wait for
   * @param options - Optional options (e.g., predicate filter, timeout)
   * @returns Promise resolving to the event context
   */
  public once<Subject extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: Subject,
    options?: Parameters<IFilteredBus<TBus['namespace'], ExtractScopedBusSubjects<TBus>>['once']>[1],
  ) {
    return this.filteredBus.once(subject, options);
  }

  protected logLowLevelEvent(_event: unknown): void {
    // Low-level event logging is reserved for explicit debug tooling, not console output.
  }
}
