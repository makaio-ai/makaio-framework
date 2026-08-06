import { AIAgentConnector, type BaseAgentConnectorConfig } from './agent-connector.js';
import type { ScopedBus } from '@makaio/bus-core';
import type { HandlerForSubjectDefinition, ScopedSubjectDefinition } from '@makaio/core';
import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';
import type { AgentStartResult, ConnectorSendMessageOptions, ConnectorStartOptions } from '../agent/types.js';
import { rejectQueuedHandles, SESSION_CLOSED_QUEUE_ERROR, type QueueableTurn } from '../session/process-queue.js';
import type { UserMessageQueue } from '../session/user-message-queue.js';

/**
 * Minimal session interface required by ProceduralAgentConnector.
 *
 * Any session implementation (OpenAI, Copilot, Gemini) that exposes
 * these methods can be used with ProceduralAgentConnector's default
 * wireSessionEvents / processUserMessages / acceptsImmediate.
 */
export interface ProceduralConnectorSession {
  /** Process messages from the queue. */
  processQueue(queue: UserMessageQueue): Promise<void>;
  /** Get the current turn for state inspection. */
  getCurrentTurn(): QueueableTurn | undefined;
}

/**
 * Turn subject references for wireSessionEvents.
 *
 * Each adapter provides its namespace-specific subjects. The subjects
 * must accept TurnStateChangedPayload (or compatible shape).
 * @typeParam TNamespace - The bus namespace string for subject typing
 */
export interface WireSessionSubjects<TNamespace extends string = string> {
  turn_started: ScopedSubjectDefinition<TNamespace>;
  step_started: ScopedSubjectDefinition<TNamespace>;
  step_finished: ScopedSubjectDefinition<TNamespace>;
  turn_finished: ScopedSubjectDefinition<TNamespace>;
}

/**
 * Configuration for ProceduralAgentConnector's wireSessionEvents behavior.
 *
 * The `onTurnStarted` and `onTurnFinished` hooks allow adapters to inject
 * logic at turn boundaries. By default both are no-ops.
 */
export interface WireSessionConfig {
  /**
   * Called when a new turn starts (turn_started bus event).
   *
   * Executes before the default `updateProcessingState('turn_started')` so
   * the connector state machine is always updated regardless of this hook.
   *
   * Supports async so that turn-start operations with I/O — such as a pending
   * MCP tool refresh via the bus — can complete before the API call is made.
   * In-memory operations (recordInjection, consumeTurnNumber) are not affected
   * by the async signature.
   */
  onTurnStarted?: () => Promise<void> | void;
  /**
   * Custom handler for turn_finished events.
   *
   * When provided, replaces the default turn_finished behavior entirely.
   * The handler receives a callback to process the queue, which it should
   * call when the message is considered complete and the queue should drain.
   * @param drainQueue - Callback that processes the queue or goes idle
   */
  onTurnFinished?: (drainQueue: () => Promise<void>) => Promise<void>;
}

/**
 * Abstract base class for procedural (non-event-driven) agent connectors.
 *
 * Procedural adapters (OpenAI, Copilot, Gemini) share common patterns:
 * - wireSessionEvents: subscribe to turn lifecycle events and update processing state
 * - processUserMessages: initialize session, enqueue, transition to active, process queue
 * - complete: poll processing state until idle/paused
 * - start: delegate to sendMessage and return AgentStartResult
 * - acceptsImmediate: delegate to session's current turn
 *
 * Subclasses must implement:
 * - `getSession()` / `ensureSession()` for session access and lazy initialization
 * - `getSessionQueue()` for the adapter's UserMessageQueue instance
 * - `getTurnSubjects()` for namespace-specific turn subjects
 * - `sendMessage()`, `abort()`, `close()`, `interrupt()`, `getAdapterSessionId()`
 *
 * Subclasses may override:
 * - `getWireSessionConfig()` for custom turn_finished behavior (e.g., Copilot multi-turn)
 * @typeParam TBus - Scoped bus type for adapter namespace
 * @typeParam TConfig - Configuration type extending BaseAgentConnectorConfig
 */
export abstract class ProceduralAgentConnector<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> extends AIAgentConnector<TBus, TConfig> {
  /** Whether turn event wiring has been setup. */
  private turnEventsWired = false;
  /**
   * Terminal lifecycle latch. Once a connector starts closing, initialization
   * that resumes later must not install fresh turn handlers.
   */
  private turnEventLifecycleClosed = false;
  /**
   * Unsubscribe functions for the turn subscriptions {@link wireSessionEvents}
   * installed.
   *
   * Held here, at the wiring, because that is the only place that knows what was
   * subscribed. A subclass owns *when* its connector ends; it cannot own the
   * undoing of subscriptions it never registered — and every connector on this base
   * needs them undone, whatever class its teardown reports: a subscription outliving
   * its connector keeps that connector reachable from the bus, so a later generation
   * on the same agent id delivers turn events into an object that already closed.
   */
  private turnEventCleanups: Array<() => void> = [];
  /** Turn handlers that already started and must settle before provider teardown. */
  private activeTurnEventHandlers = new Set<Promise<void>>();

  /**
   * Get the adapter's session instance (may be undefined if not yet initialized).
   * @returns The session or undefined
   */
  protected abstract getSession(): ProceduralConnectorSession | undefined;

  /**
   * Initialize and return the adapter's session.
   * Must be idempotent (no-op if already initialized).
   * @returns The initialized session
   */
  protected abstract ensureSession(): Promise<ProceduralConnectorSession>;

  /**
   * Get the adapter's UserMessageQueue instance.
   * @returns The message queue
   */
  protected abstract getSessionQueue(): UserMessageQueue;

  /**
   * Get the adapter's namespace-specific turn subjects for wireSessionEvents.
   * @returns Turn subject definitions
   */
  protected abstract getTurnSubjects(): WireSessionSubjects<TBus['namespace']>;

  /**
   * Get optional wire session configuration for custom turn_finished behavior.
   * Override in subclasses that need non-standard turn_finished handling
   * (e.g., Copilot multi-turn message completion).
   * @returns Wire session configuration, or undefined for default behavior
   */
  protected getWireSessionConfig(): WireSessionConfig | undefined {
    return undefined;
  }

  /**
   * Wire Session turn events to Connector state updates.
   *
   * Session emits typed events, Connector subscribes and updates processing state.
   * This maintains separation of concerns - Session does not know about Connector state.
   *
   * Default turn_finished behavior: transition through processing_finished to idle,
   * or drain the queue if messages are pending. Override via `getWireSessionConfig()`.
   *
   * Every subscription's unsubscribe function is retained so
   * {@link unwireSessionEvents} can undo the whole set; a connector that closes
   * without undoing them stays reachable from the bus for the rest of the process.
   */
  protected wireSessionEvents(): void {
    if (this.turnEventLifecycleClosed || this.turnEventsWired) return;
    this.turnEventsWired = true;

    const subjects = this.getTurnSubjects();
    const wireConfig = this.getWireSessionConfig();

    // Type helper: turn subjects are event subjects whose handlers ignore the context
    // parameter. Since ScopedSubjectDefinition<TBus['namespace']> is abstract at the
    // generic level, HandlerForSubjectDefinition resolves to `never`. We narrow via
    // a safe cast — all turn subjects use TurnStateChangedSchema (event, not request).
    type TurnHandler = HandlerForSubjectDefinition<(typeof subjects)['turn_started']>;

    /**
     * Subscribe one turn subject and keep the way back out.
     *
     * One place that registers, so one place that remembers: a call site that
     * subscribed without retaining its cleanup would leak silently, and the cast
     * the type helper above explains is needed once rather than per subject.
     * @param subject - Turn subject to subscribe to
     * @param handler - What to run when it fires
     */
    const subscribe = (subject: ScopedSubjectDefinition<TBus['namespace']>, handler: () => Promise<void>): void => {
      this.turnEventCleanups.push(this.on(subject, (() => this.dispatchTurnEvent(handler)) as TurnHandler));
    };

    subscribe(subjects.turn_started, async () => {
      try {
        await wireConfig?.onTurnStarted?.();
      } catch (error) {
        // Hook failure must not block the state machine — log and continue
        console.error('[ProceduralAgentConnector] onTurnStarted hook failed:', error);
      }
      if (this.turnEventLifecycleClosed) return;
      await this.updateProcessingState('turn_started');
    });

    subscribe(subjects.step_started, async () => {
      await this.updateProcessingState('step_started');
    });

    subscribe(subjects.step_finished, async () => {
      await this.updateProcessingState('step_finished');
      if (this.turnEventLifecycleClosed) return;

      // Process queue on step_finished for immediate messages
      const session = this.getSession();
      const queue = this.getSessionQueue();
      if (session && !queue.isEmpty()) {
        await session.processQueue(queue);
      }
    });

    subscribe(subjects.turn_finished, async () => {
      await this.updateProcessingState('turn_finished');

      const drainQueue = async () => {
        if (this.turnEventLifecycleClosed) return;
        await this.updateProcessingState('processing_finished');
        if (this.turnEventLifecycleClosed) return;
        const session = this.getSession();
        const queue = this.getSessionQueue();
        if (session && !queue.isEmpty()) {
          await session.processQueue(queue);
        } else {
          await this.updateProcessingState('idle');
        }
      };

      if (wireConfig?.onTurnFinished) {
        await wireConfig.onTurnFinished(drainQueue);
      } else {
        await drainQueue();
      }
    });
  }

  /**
   * Run a turn handler only while this connector owns its lifecycle.
   *
   * The bus snapshots handlers before it begins invoking them, so unsubscribe
   * alone cannot stop a snapshotted callback. This second terminal check rejects
   * that callback when it eventually starts, while the active set lets close
   * wait for callbacks that started before the terminal latch.
   * @param handler - Turn callback registered with the scoped bus
   */
  private async dispatchTurnEvent(handler: () => Promise<void>): Promise<void> {
    if (this.turnEventLifecycleClosed) return;

    const activeHandler = handler();
    this.activeTurnEventHandlers.add(activeHandler);
    try {
      await activeHandler;
    } finally {
      this.activeTurnEventHandlers.delete(activeHandler);
    }
  }

  /**
   * Cancel every turn subscription {@link wireSessionEvents} installed.
   *
   * **What makes a connector's end total.** §2.2's `released` is the claim that no
   * callback can arrive afterwards, and a turn subscription is precisely a way for
   * one to: the bus keeps the closed connector alive, and a later connector
   * generation on the same agent id emits into the filtered bus both of them are
   * subscribed to, so the dead one advances its own state machine and touches a
   * session it already dropped. That is the same defect for a connector reporting
   * `detached` — it merely has a weaker claim to overstate.
   *
   * Idempotent. The separate terminal lifecycle latch decides whether wiring may
   * be installed again; close paths set that latch before calling this cleanup.
   */
  protected unwireSessionEvents(): void {
    for (const cleanup of this.turnEventCleanups) {
      cleanup();
    }
    this.turnEventCleanups = [];
    this.turnEventsWired = false;
  }

  /**
   * Permanently prevent turn wiring and remove any handlers already installed.
   *
   * Close implementations call this before awaiting provider teardown so an
   * initialization that was already in flight cannot re-wire afterwards.
   */
  protected async closeTurnEventLifecycle(): Promise<void> {
    this.turnEventLifecycleClosed = true;
    this.unwireSessionEvents();
    await Promise.allSettled(this.activeTurnEventHandlers);
  }

  /**
   * Whether connector initialization lost the terminal close race.
   * @returns `true` once close permanently claimed the wiring lifecycle
   */
  protected get isTurnEventLifecycleClosed(): boolean {
    return this.turnEventLifecycleClosed;
  }

  /**
   * Process queued user messages by delegating to Session.
   *
   * Shared flow:
   * 1. Initialize session if not yet created
   * 2. Enqueue the message
   * 3. Set adapterSessionId on handle
   * 4. Transition to active if currently idle/paused
   * 5. Process queue via session
   * @param messageHandles - Array of message handles to process
   * @returns Set of message handles that were processed
   */
  protected async processUserMessages(messageHandles: MessageHandle[]): Promise<Set<MessageHandle>> {
    const [first] = messageHandles;

    let session: ProceduralConnectorSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      const sessionError = error instanceof Error ? error : new Error(String(error));
      if (!first.isProcessed) {
        first.markCompleted({ outcome: 'error', error: sessionError });
      }
      throw sessionError;
    }
    if (this.turnEventLifecycleClosed) {
      first.markCompleted({
        outcome: 'error',
        error: new Error(SESSION_CLOSED_QUEUE_ERROR),
      });
      throw new Error(`[${this.config.adapterName}] Cannot send through a closed connector`);
    }
    const queue = this.getSessionQueue();

    queue.enqueue(first);
    first.adapterSessionId = this.adapterSessionId;

    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
    }
    if (this.turnEventLifecycleClosed) {
      rejectQueuedHandles(queue);
      throw new Error(`[${this.config.adapterName}] Cannot send through a closed connector`);
    }

    await session.processQueue(queue);
    return new Set([first]);
  }

  /**
   * Initialize the connector's SDK session without sending a message.
   * Must set adapterSessionId before returning.
   * Called by createAgent for idle agent setup.
   * Implementations MUST be idempotent (no-op if already initialized).
   * @param options - Optional start options (e.g., systemPrompt)
   */
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    if (this.getSession()) return; // Idempotent
    this.captureSystemPrompt(options?.systemPrompt);
    await this.ensureSession();
  }

  /**
   * Start session with initial message.
   * @param message - The initial message to send
   * @param options - Optional send message options
   * @returns The agent start result with session ID and message handle
   */
  public async start(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<AgentStartResult> {
    this.captureSystemPrompt(options?.systemPrompt);
    const messageHandle = await this.sendMessage(message, options);
    return {
      adapterSessionId: await this.getAdapterSessionId(),
      messageHandle,
      agentId: this.agentId,
    };
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   * @returns Last message result or null if no messages processed
   */
  public async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * Returns true if current turn can accept immediate messages.
   * @returns True if turn can accept immediate, false otherwise
   */
  protected acceptsImmediate(): boolean {
    return this.getSession()?.getCurrentTurn()?.canAcceptImmediate() ?? false;
  }
}
