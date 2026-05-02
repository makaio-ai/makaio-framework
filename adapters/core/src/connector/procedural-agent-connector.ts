import { AIAgentConnector, type BaseAgentConnectorConfig } from './agent-connector.js';
import type { ScopedBus } from '@makaio/bus-core';
import type { HandlerForSubjectDefinition, ScopedSubjectDefinition } from '@makaio/core';
import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';
import type { AgentStartResult, ConnectorSendMessageOptions, ConnectorStartOptions } from '../agent/types.js';
import type { QueueableTurn } from '../session/process-queue.js';
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
   */
  protected wireSessionEvents(): void {
    if (this.turnEventsWired) return;
    this.turnEventsWired = true;

    const subjects = this.getTurnSubjects();
    const wireConfig = this.getWireSessionConfig();

    // Type helper: turn subjects are event subjects whose handlers ignore the context
    // parameter. Since ScopedSubjectDefinition<TBus['namespace']> is abstract at the
    // generic level, HandlerForSubjectDefinition resolves to `never`. We narrow via
    // a safe cast — all turn subjects use TurnStateChangedSchema (event, not request).
    type TurnHandler = HandlerForSubjectDefinition<(typeof subjects)['turn_started']>;

    this.on(subjects.turn_started, (async () => {
      try {
        await wireConfig?.onTurnStarted?.();
      } catch (error) {
        // Hook failure must not block the state machine — log and continue
        console.error('[ProceduralAgentConnector] onTurnStarted hook failed:', error);
      }
      await this.updateProcessingState('turn_started');
    }) as TurnHandler);

    this.on(subjects.step_started, (async () => {
      await this.updateProcessingState('step_started');
    }) as TurnHandler);

    this.on(subjects.step_finished, (async () => {
      await this.updateProcessingState('step_finished');

      // Process queue on step_finished for immediate messages
      const session = this.getSession();
      const queue = this.getSessionQueue();
      if (session && !queue.isEmpty()) {
        await session.processQueue(queue);
      }
    }) as TurnHandler);

    this.on(subjects.turn_finished, (async () => {
      await this.updateProcessingState('turn_finished');

      const drainQueue = async () => {
        await this.updateProcessingState('processing_finished');
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
    }) as TurnHandler);
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

    const session = await this.ensureSession();
    const queue = this.getSessionQueue();

    queue.enqueue(first);
    first.adapterSessionId = this.adapterSessionId;

    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
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
