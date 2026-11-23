// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 580 }] */
import { NoHandlerError, OnOptions, RequestError } from '@makaio/bus-core';
import type { EmitSubject, IFilteredBus, IMakaioBus, ScopedBus } from '@makaio/bus-core';
import {
  DirectoryNotFoundError,
  type HandlerForSubjectDefinition,
  type CallContext,
  type ScopedSubjectDefinition,
} from '@makaio/core';
import type { SystemPrompt, AIReasoningLevel, ConnectorTeardownResult } from '@makaio/contracts';
import type {
  AgentStartResult,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  EmitteryEvents,
  BaseAgentConnectorConfig,
  ExtractScopedBusSubjects,
  Forbid,
  ForbiddenKeys,
} from '../agent/types.js';
export type { BaseAgentConnectorConfig };
import { cleanEnvForAdapter } from '../utils/index.js';
import { DeferredPromise } from '@makaio/utils';
import Emittery from 'emittery';
import { getProcessingStateUpdates } from '../utils/getProcessingStateUpdates.js';
import {
  type MessageHandle,
  type MessageHandleOptions,
  type MessageResult,
  type ProcessingState,
} from '../message-handle/index.js';
import { buildMessageHandle } from '../message-handle/message-handle.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';
import * as process from 'node:process';
import * as fs from 'node:fs';
import os from 'node:os';
import { TurnNumberLedger } from './turn-number-ledger.js';
import type { UnknownRecord } from 'type-fest';
import { resolveTimeouts, type TrackedTimeoutConfig } from '@makaio/utils';

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
  /** Monotonic turn-number bookkeeping for the MCP tool ledger. */
  private readonly turnNumbers = new TurnNumberLedger();
  /** Adapter type name for event identification. */
  protected readonly adapterName: string;
  /** Runtime system prompt from start/initialize options. */
  protected systemPrompt?: SystemPrompt;

  protected constructor(config: BaseAgentConnectorConfig<TBus> & { adapterId: string }) {
    const cwd = config.cwd ?? os.tmpdir();
    if (!fs.existsSync(cwd)) throw new DirectoryNotFoundError(cwd);
    this.agentId = config.agentId ?? crypto.randomUUID();
    this.scopedBus = config.bus;
    this.globalBus = config.globalBus;
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
   * Subclasses may override to apply SDK-specific side effects (e.g., forwarding it to the SDK's system-instruction setter).
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
  public abstract initialize(options: ConnectorStartOptions): Promise<void>;

  /**
   * Start agent with initial message.
   * @param message - Normalized user message (role and content)
   * @param options - Optional start options (e.g., delivery mode)
   * @returns Session ID, agent ID, and message handle for tracking
   */
  public abstract start(message: NormalizedMessageInput, options: ConnectorStartOptions): Promise<AgentStartResult>;

  /**
   * Send a message to the agent.
   * For initial message, use start() instead.
   * @param message - Normalized message content
   * @param options - Send options (e.g., delivery mode, message ID)
   * @returns Message handle for tracking
   */
  public abstract sendMessage(
    message: NormalizedMessageInput,
    options: ConnectorSendMessageOptions,
  ): Promise<MessageHandle>;

  /**
   * Abort the agent and cleanup resources (panic mode).
   * Triggers AbortController which may cause provider errors.
   * Use close() for graceful shutdown instead.
   * @param call - Call of the operation that aborts this connector
   */
  public abstract abort(call: CallContext): void;

  /**
   * Tear this connector down and report what was observed; unlike `abort()` this
   * triggers no AbortController errors. **Return the class you can prove** — `TeardownEvidenceSchema` says what each
   * asserts, and only *local* evidence counts: a third-party `dispose`, a wrapper type or the absence of a thrown
   * error prove no provider-side end. Unobservable ⇒ `detached` with a `detail`;
   * an unaccounted failed stage ⇒ `unknown`, named. Throwing also means `unknown`.
   * @param call - Call of the teardown that closes this connector
   * @returns What this runtime observed about the end of its resources
   */
  public abstract close(call: CallContext): Promise<ConnectorTeardownResult>;

  /**
   * Get session ID, waiting for provider to generate it if not yet available.
   * @param call - Call of the operation that needs the session ID
   * @returns Session ID from provider
   */
  public abstract getAdapterSessionId(call: CallContext): Promise<string>;

  /**
   * The provider session ID this connector is currently authoritative on, or
   * `undefined` when it has none. "Confirmed" means safe to report, not echoed
   * back by the provider: a seeded ID qualifies when the provider adopts it, and
   * Claude connectors withhold it only while a fork awaits `system.init`. For
   * "did the provider commit to it" see {@link movesProviderSessionOnSuppressedResume}.
   * Samplers (payload enrichment, rotation guards) must not read this accessor
   * directly — resolve through `providerCommittedAdapterSessionId` in
   * `agent/agent-adapter-session-movement.ts`, which withholds an armed resume
   * target that an in-flight dispatch may still abandon.
   * @returns Currently authoritative provider session ID, or `undefined`
   */
  public getConfirmedAdapterSessionId(): string | undefined {
    return this.adapterSessionId;
  }

  /**
   * Whether a dispatch that declines native resume would make this connector
   * abandon its armed resume target for a fresh provider session.
   * Narrow honesty query for the movement seam (contract in
   * `agent/agent-adapter-session-movement.ts`): the executor must know before
   * dispatching so the session row stops advertising the abandoned target.
   * Default `false`; connectors that rotate must override.
   * @returns `true` when declining native resume rotates the provider session
   */
  public movesProviderSessionOnSuppressedResume(): boolean {
    return false;
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   * @returns Last message result or null if no messages processed
   */
  public abstract complete(): Promise<MessageResult | null>;

  /**
   * Create a MessageHandle with standard initialization (messageId, adapterSessionId, onMessageSent).
   * @param message - Normalized user message
   * @param options - Message options (call, id, delivery mode, history, and turn context)
   * @returns Initialized MessageHandle instance
   */
  protected createMessageHandle(message: NormalizedMessageInput, options: MessageHandleOptions): MessageHandle {
    return buildMessageHandle(message, options, this.adapterSessionId, this.config.onMessageSent);
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
    this.turnNumbers.stage(turnNumber);
  }

  /**
   * Advance to the next turn number, consuming any pending canonical value.
   * Orchestrator-staged values win; otherwise the local counter increments by one.
   * @returns The current turn number after advancement
   */
  protected consumeTurnNumber(): number {
    return this.turnNumbers.consume();
  }

  /**
   * Current turn number (read-only). Use {@link consumeTurnNumber} to advance.
   * @returns The current turn number
   */
  protected get currentTurnNumber(): number {
    return this.turnNumbers.current;
  }

  /**
   * Staged canonical turn number, or `undefined` if none was staged.
   * @returns The pending canonical turn number
   */
  protected get pendingTurnNumber(): number | undefined {
    return this.turnNumbers.pending;
  }

  /**
   * Attempt to change the model without a connector swap.
   * Subclasses override when the SDK supports in-place model changes.
   * Base implementation returns false (swap required).
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.model` directly.
   * The caller (AIAgent.handleModelChange) owns the `this.model` field update after
   * a successful in-place change. Implementations only configure the SDK-internal model
   * (e.g., `query.setModel()`).
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
   * @param call - Call of the operation that interrupts this connector
   * @returns Promise that resolves when interrupt is handled
   */
  public abstract interrupt(call: CallContext): Promise<void>;

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
    const pending = this.pendingMessageHandle;
    if (this.pendingMessageHandle) {
      this.pendingMessageHandle.markCompleted({
        outcome: 'error',
        error: err,
      });
      this.pendingMessageHandle = undefined;
      this.handlePause('error');
    }

    if (terminate) {
      // A terminating error inside a turn aborts under that turn's call; outside any turn the
      // connector observes the provider failure as its own origin.
      this.abort(pending?.call ?? this.globalBus.own('observer'));
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
   * @param call - Call context of the turn that needs the approval
   * @param subject - Subject definition for the tool approval request
   * @param payload - Request payload (metadata fields are forbidden and auto-injected)
   * @returns Promise resolving to the approval response
   */
  protected requestToolApproval<TSubject extends ScopedSubjectDefinition<TBus['namespace']>>(
    call: CallContext,
    subject: TSubject,
    payload: Forbid<TSubject['$meta']['payload']['request'], ForbiddenKeys>,
  ): Promise<TSubject['$meta']['payload']['response']> {
    return this.scopedBus.request<TSubject>(call, subject, {
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
   * @param call - Call context of the turn that needs the approval
   * @param subject - Scoped subject definition for the tool approval request
   * @param payload - Payload that must not include adapter metadata
   * @returns Tool approval response payload
   */
  protected async requestToolApprovalWithHandling<TSubject extends ScopedSubjectDefinition<TBus['namespace']>>(
    call: CallContext,
    subject: TSubject,
    payload: Forbid<TSubject['$meta']['payload']['request'], ForbiddenKeys>,
  ): Promise<TSubject['$meta']['payload']['response']> {
    return this.requestToolApproval<TSubject>(call, subject, payload).catch((error) => {
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
   * Emit an event a call caused (start, turn state, completion) via the scoped bus,
   * with auto-injected connector identity (adapterName, agentId, adapterId, adapterSessionId).
   * @param call - Call context of the call that caused the event
   * @param subject - Subject definition for the event
   * @param payload - Event payload (metadata fields are forbidden and auto-injected)
   * @returns Promise that resolves when the event is emitted
   */
  protected emit<S extends ScopedSubjectDefinition<TBus['namespace']>>(
    call: CallContext,
    subject: EmitSubject<S>,
    payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
  ): Promise<void> {
    return this.scopedBus.emit<S>(call, subject, {
      ...payload,
      adapterName: this.adapterName,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterSessionId: this.adapterSessionId,
    } as S['$meta']['payload']);
  }

  /**
   * Emit an observation no call caused (session-wide or SDK-reported event), sent with the
   * carrier bus's `observer` context.
   * @param subject - Subject definition for the event
   * @param payload - Event payload (metadata fields are forbidden and auto-injected)
   * @returns Promise that resolves when the event is emitted
   */
  protected emitObserved<S extends ScopedSubjectDefinition<TBus['namespace']>>(
    subject: EmitSubject<S>,
    payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
  ): Promise<void> {
    return this.emit<S>(this.globalBus.own('observer'), subject, payload);
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
