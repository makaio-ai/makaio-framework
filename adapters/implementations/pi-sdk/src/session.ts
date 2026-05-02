/* eslint max-lines: ["error", { "max": 800, "skipBlankLines": true, "skipComments": true }] */
import {
  BaseConnectorSession,
  UserMessageQueue,
  processQueueMessages,
  serializeTurnContext,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  formatMessageHistoryAsTranscript,
  type MessageHandle,
  type MessageResult,
} from '@makaio/ai-adapters-core';
import type { AgentSessionEvent, AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import type { SystemPrompt, ToolExecutionContextOverrides } from '@makaio/contracts';
import { PiConnectorTurn } from './turn.js';
import { PiSdkSubjects } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import type { RequestToolApprovalFn } from './tool-handling.js';
import { createPiBeforeToolCallHook } from './tool-handling.js';
import type { PiThinkingLevel } from './types/index.js';

/**
 * Configuration for PiConnectorSession.
 *
 * Combines the adapter identity fields required by BaseConnectorSession with
 * Pi-SDK-specific lifecycle callbacks, tool approval, and runtime state.
 */
export interface PiConnectorSessionConfig {
  /** Scoped bus for emitting turn lifecycle events to the agent layer. */
  bus: PiSdkBus;
  /** Unique adapter instance identifier. */
  adapterId: string;
  /** Adapter type name (always 'pi-sdk'). */
  adapterName: string;
  /** Agent identifier for event attribution. */
  agentId: string;
  /** Working directory for Pi SDK project-local context. */
  cwd: string;
  /** Resolved model identifier passed to Pi SDK (e.g., 'claude-sonnet-4-6'). */
  model: string;
  /** Runtime environment variables (unused by Pi, carried for ConnectorSessionConfig compat). */
  env: Record<string, string>;
  /**
   * Optional system prompt injected at session creation via DefaultResourceLoader.
   * When set, overrides Pi's default system prompt. When absent, Pi uses its own.
   */
  systemPrompt?: SystemPrompt;
  /**
   * Bound tool approval callback from the connector's requestToolApproval method.
   * The Pi SDK's beforeToolCall hook routes approval requests through this callback.
   */
  requestToolApproval: RequestToolApprovalFn;
  /**
   * Callback invoked when a new turn starts.
   * Used by the connector to set pendingMessageHandle for lifecycle tracking.
   * @param handle - The message handle for the turn being started
   */
  onTurnStart?: (handle: MessageHandle) => void;
  /**
   * Callback invoked when a turn completes (success or error).
   * Used by the connector to clear pendingMessageHandle and record lastResult.
   * @param handle - The message handle for the completed turn
   * @param result - The final message result
   */
  onTurnComplete?: (handle: MessageHandle, result: MessageResult) => void;
  /**
   * Factory to create the Pi AgentSession on first use.
   * Injected by the connector so the session class remains testable
   * without bootstrapping the full Pi SDK infrastructure.
   * @returns Promise resolving to the initialized AgentSession
   */
  createPiSession: () => Promise<AgentSession>;
  /**
   * Names of custom tools passed to `createAgentSession({ customTools })`.
   * Used to seed the custom tool tracking set so the first `updateCustomTools()`
   * call can correctly distinguish our tools from Pi's native tools.
   */
  initialCustomToolNames?: string[];
}

/**
 * Session implementation for the Pi SDK adapter.
 *
 * Wraps Pi's `AgentSession` lifecycle and routes its event stream to the
 * scoped bus. Manages a single active `PiConnectorTurn` at a time.
 *
 * Lifecycle:
 * 1. `initialize()` — calls `createPiSession()` and wires the beforeToolCall hook
 * 2. `startConsumption()` — subscribes to Pi SDK events, routes to scoped bus
 * 3. `processQueue()` — orchestrates the message queue with abort on immediate
 * 4. `startNewTurn()` — creates a turn, fires `runPrompt()` detached
 * 5. `completeTurn()` — idempotent finalization; marks handle before `turn_finished`
 * 6. `dispose()` — unsubscribes and disposes the Pi session
 *
 * Two-path turn completion:
 * Both `agent_end` (event) and `prompt()` resolution call `completeTurn()`.
 * The `completedTurns` WeakSet guards against double-finalization.
 */
export class PiConnectorSession extends BaseConnectorSession<PiConnectorSessionConfig> {
  /** The underlying Pi SDK session instance, set after initialize(). */
  private piSession?: AgentSession;

  /** Unsubscribe function returned by piSession.subscribe(). */
  private piUnsubscribe?: () => void;

  /**
   * Names of custom tools currently installed by this session.
   * Used by `updateCustomTools` to replace only our tools in `state.tools`
   * without wiping Pi's native tools.
   */
  private customToolNames = new Set<string>();

  /**
   * The active PiConnectorTurn for state inspection and lifecycle events.
   * Set at turn start, cleared at turn finalization.
   */
  private activeTurn?: PiConnectorTurn;

  /**
   * Per-turn idempotency guard for completeTurn.
   *
   * Set to the turn instance after first completion. Both the agent_end event
   * path and the prompt() resolution path compare against this to prevent
   * double-finalization. Unlike a boolean flag, this is turn-scoped: a stale
   * runPrompt from a previous turn cannot steal the guard from a new turn.
   */
  private readonly completedTurns = new WeakSet<PiConnectorTurn>();

  /**
   * Whether the first step has started for the current turn.
   *
   * Tracks whether `turn.markStepStarted()` has been called to avoid redundant
   * step-start transitions when multiple assistant messages arrive in sequence.
   */
  private stepStarted = false;

  /**
   * Turn-scoped assistant text.
   *
   * Pi can still deliver events from a superseded or externally aborted prompt
   * after a replacement turn has reset session-level fields. Keep text keyed by
   * turn so stale events cannot emit the replacement turn's content.
   */
  private readonly assistantTextByTurn = new WeakMap<PiConnectorTurn, string>();

  /** Turn-scoped fatal error captured from provider stopReason or hard approval denial. */
  private readonly turnErrors = new WeakMap<PiConnectorTurn, Error>();

  /** Approval-rewritten inputs for custom registry tools, keyed by Pi tool call ID. */
  private readonly approvedToolInputs = new Map<string, Record<string, unknown>>();

  /** Metadata injected into every bus emission so the filtered bus matches by agentId. */
  private readonly busMetadata: { agentId: string; adapterId: string; adapterName: string };

  /**
   * Create a new Pi SDK connector session.
   * @param config - Session configuration including bus, credentials, and Pi session factory
   */
  public constructor(config: PiConnectorSessionConfig) {
    super(config);
    this.busMetadata = {
      agentId: config.agentId,
      adapterId: config.adapterId,
      adapterName: config.adapterName,
    };
  }

  /**
   * Emit an event on the scoped bus with auto-injected connector metadata.
   *
   * The agent layer subscribes via a filtered bus keyed on agentId. Raw bus
   * emissions would be invisible to those subscriptions; this wrapper ensures
   * every emission carries the required identity fields.
   * @param subject - Scoped subject definition to emit on
   * @param payload - Event payload (metadata is merged automatically)
   * @returns Promise resolving when the event is delivered
   */
  private emitEvent<S extends Parameters<PiSdkBus['emit']>[0]>(
    subject: S,
    payload: Parameters<PiSdkBus['emit']>[1],
  ): Promise<void> {
    return this.config.bus.emit(subject, { ...payload, ...this.busMetadata } as Parameters<PiSdkBus['emit']>[1]);
  }

  /**
   * Initialize the Pi SDK session.
   *
   * Creates the Pi `AgentSession` via the factory, assigns the Makaio
   * `beforeToolCall` hook to intercept all tool calls for approval routing,
   * and then starts event consumption.
   */
  public async initialize(): Promise<void> {
    if (this.piSession) return; // Idempotent

    this.piSession = await this.config.createPiSession();
    this.sessionId = this.piSession.sessionId;

    if (this.config.initialCustomToolNames) {
      this.customToolNames = new Set(this.config.initialCustomToolNames);
    }

    // Replace Pi's default beforeToolCall hook with Makaio's approval bridge.
    // We REPLACE rather than chain because Makaio takes over tool approval entirely.
    this.piSession.agent.beforeToolCall = createPiBeforeToolCallHook(this.config.requestToolApproval, {
      onApprovedInputUpdate: (toolCallId, toolName, updatedInput) => {
        if (!this.customToolNames.has(toolName)) return false;
        this.approvedToolInputs.set(toolCallId, updatedInput);
        return true;
      },
      onAbortRequested: (toolName) => {
        const turn = this.activeTurn;
        if (turn) {
          this.turnErrors.set(turn, new Error(`Tool use denied by approval handler: ${toolName}`));
        }
        void this.piSession?.abort();
      },
    });

    this.startConsumption();
  }

  /**
   * Subscribe to Pi SDK session events and route them to the scoped bus.
   *
   * Called immediately after the Pi session is created. The unsubscribe
   * function is stored for cleanup during `close()` or `dispose()`.
   */
  private startConsumption(): void {
    if (!this.piSession) return;

    this.piUnsubscribe = this.piSession.subscribe((event: AgentSessionEvent) => {
      // Capture active turn synchronously so deferred handlePiEvent
      // doesn't pick up a replacement turn set by startNewTurn.
      const turnSnapshot = this.activeTurn;
      const handleSnapshot = this.activeTurn?.messageHandle;
      void this.handlePiEvent(event, turnSnapshot, handleSnapshot).catch((error: unknown) => {
        console.error('[PiConnectorSession] Failed to handle Pi session event:', error);
      });
    });
  }

  /**
   * Route a Pi SDK event to the appropriate scoped bus subjects.
   *
   * Always emits the raw event to `sdk.event` for observability. Delegates
   * to sub-handlers by event category to stay within the per-function line limit.
   * @param event - Raw event from Pi SDK's session.subscribe()
   */

  private async handlePiEvent(
    event: AgentSessionEvent,
    turnSnapshot?: PiConnectorTurn,
    handleSnapshot?: MessageHandle,
  ): Promise<void> {
    // Always emit raw event for observability / debugging (fire-and-forget:
    // high-frequency text_delta tokens must not block the semantic handler chain)
    void this.emitEvent(PiSdkSubjects.sdk.event, event as { type: string }).catch((error: unknown) => {
      console.error('[PiConnectorSession] Failed to emit raw sdk.event:', error);
    });

    switch (event.type) {
      case 'message_update':
        await this.handleMessageUpdate(event.assistantMessageEvent, turnSnapshot);
        break;
      case 'message_end':
        await this.handleMessageEnd(event, turnSnapshot);
        break;
      case 'tool_execution_start':
        await this.emitEvent(PiSdkSubjects.tool_started, {
          eventType: 'tool_started',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: this.normalizeToolArgs(event.args),
        });
        break;
      case 'tool_execution_end':
        await this.emitEvent(PiSdkSubjects.tool_completed, {
          eventType: 'tool_completed',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      case 'agent_start':
        await this.emitEvent(PiSdkSubjects.agent_started, { eventType: 'agent_started' });
        break;
      case 'agent_end':
        await this.handleAgentEnd(event, turnSnapshot, handleSnapshot);
        break;
      case 'compaction_start':
        await this.emitEvent(PiSdkSubjects.compaction_started, {
          eventType: 'compaction_started',
        });
        break;
      case 'compaction_end':
        await this.emitEvent(PiSdkSubjects.compaction_ended, {
          eventType: 'compaction_ended',
        });
        break;
      case 'auto_retry_start':
        await this.emitEvent(PiSdkSubjects.auto_retry_started, {
          eventType: 'auto_retry_started',
        });
        break;
      case 'auto_retry_end':
        await this.emitEvent(PiSdkSubjects.auto_retry_ended, {
          eventType: 'auto_retry_ended',
        });
        break;
      case 'queue_update':
        await this.emitEvent(PiSdkSubjects.queue_update, { eventType: 'queue_update' });
        break;
    }
  }

  /**
   * Handle message_update events from Pi SDK.
   *
   * Routes streaming deltas and end events to typed bus subjects. Advances
   * the turn state to step_started on first content (text or thinking delta).
   * @param ame - The AssistantMessageEvent from Pi's message_update payload
   * @param turnSnapshot - The active turn at event emission time
   */
  private async handleMessageUpdate(
    ame: Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent'],
    turnSnapshot?: PiConnectorTurn,
  ): Promise<void> {
    if (!this.shouldAcceptTurnEvent(turnSnapshot)) return;
    if (ame.type === 'text_delta') {
      await this.emitEvent(PiSdkSubjects.text_delta, {
        eventType: 'text_delta',
        delta: ame.delta,
      });
      await this.advanceToStepStarted();
    } else if (ame.type === 'text_end') {
      this.appendTurnAssistantText(turnSnapshot, ame.content);
      await this.emitEvent(PiSdkSubjects.text_complete, {
        eventType: 'text_complete',
        text: ame.content,
      });
    } else if (ame.type === 'thinking_delta') {
      await this.emitEvent(PiSdkSubjects.thinking_delta, {
        eventType: 'thinking_delta',
        delta: ame.delta,
      });
      await this.advanceToStepStarted();
    } else if (ame.type === 'thinking_end') {
      await this.emitEvent(PiSdkSubjects.thinking_complete, {
        eventType: 'thinking_complete',
        text: ame.content,
      });
    }
  }

  /**
   * Handle message_end events from Pi SDK.
   *
   * Emits the full message payload and advances the turn step state to finished.
   * @param event - The message_end event from Pi's event stream
   * @param turnSnapshot - The active turn at event emission time
   */
  private async handleMessageEnd(
    event: Extract<AgentSessionEvent, { type: 'message_end' }>,
    turnSnapshot?: PiConnectorTurn,
  ): Promise<void> {
    if (!this.shouldAcceptTurnEvent(turnSnapshot)) return;

    await this.emitEvent(PiSdkSubjects.message_complete, {
      eventType: 'message_complete',
      message: event.message,
    });

    // Extract usage and errors from assistant messages
    if ('role' in event.message && event.message.role === 'assistant') {
      const assistantMsg = event.message;
      if ('usage' in assistantMsg && assistantMsg.usage) {
        await this.emitEvent(PiSdkSubjects.usage, {
          eventType: 'usage',
          usage: assistantMsg.usage,
        });
      }
      if ('stopReason' in assistantMsg && assistantMsg.stopReason === 'error') {
        const errorMessage =
          'errorMessage' in assistantMsg ? String(assistantMsg.errorMessage) : 'Unknown Pi SDK error';
        this.turnErrors.set(turnSnapshot, new Error(errorMessage));
        await this.emitEvent(PiSdkSubjects.error, {
          eventType: 'error',
          error: { message: errorMessage, stopReason: 'error' },
        });
      }
    }

    await this.advanceToStepFinished(turnSnapshot);
  }

  /**
   * Handle agent_end events from Pi SDK.
   *
   * Uses the turn/handle snapshots captured synchronously by the subscriber
   * so that deferred execution doesn't pick up a replacement turn that was
   * set by startNewTurn between event emission and handler execution.
   * @param event - The agent_end event from Pi's event stream
   * @param turnSnapshot - The active turn at event emission time
   * @param handleSnapshot - The active handle at event emission time
   */
  private async handleAgentEnd(
    event: Extract<AgentSessionEvent, { type: 'agent_end' }>,
    turnSnapshot?: PiConnectorTurn,
    handleSnapshot?: MessageHandle,
  ): Promise<void> {
    if (!this.shouldAcceptTurnEvent(turnSnapshot) || !handleSnapshot) return;
    const text = this.getTurnAssistantText(turnSnapshot);
    await this.emitEvent(PiSdkSubjects.agent_complete, {
      eventType: 'agent_complete',
      messages: event.messages as unknown[],
      text,
    });
    await this.completeTurn(turnSnapshot, handleSnapshot, this.buildCompletionResult(turnSnapshot, text));
  }

  /**
   * Decide whether a Pi SDK event still belongs to an active, accepted turn.
   * @param turn - Turn captured synchronously when Pi emitted the event
   * @returns Whether user-visible event handling should continue
   */
  private shouldAcceptTurnEvent(turn: PiConnectorTurn | undefined): turn is PiConnectorTurn {
    return turn !== undefined && !turn.isPaused();
  }

  /**
   * Normalize Pi tool args to the framework's record shape.
   * @param value - Raw Pi SDK tool arguments
   * @returns Record arguments when available
   */
  private normalizeToolArgs(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  /**
   * Append assistant text to a turn-scoped accumulator.
   * @param turn - Current accepted turn
   * @param text - Text block to append
   */
  private appendTurnAssistantText(turn: PiConnectorTurn, text: string): void {
    this.assistantTextByTurn.set(turn, `${this.assistantTextByTurn.get(turn) ?? ''}${text}`);
  }

  /**
   * Read accumulated assistant text for a specific turn.
   * @param turn - Turn to read
   * @returns Accumulated assistant text
   */
  private getTurnAssistantText(turn: PiConnectorTurn): string {
    return this.assistantTextByTurn.get(turn) ?? '';
  }

  /**
   * Advance the current turn to step_started (idempotent).
   * Called on first content arrival (text_delta or thinking_delta).
   */
  private async advanceToStepStarted(): Promise<void> {
    if (this.stepStarted || !this.activeTurn) return;
    this.stepStarted = true;
    await this.activeTurn.markStepStarted();
  }

  /**
   * Advance the current turn to step_finished when a step was in progress.
   * Called on message_end for assistant messages.
   * @param turn - The turn that owns the message_end event
   */
  private async advanceToStepFinished(turn: PiConnectorTurn): Promise<void> {
    if (this.activeTurn !== turn || !this.stepStarted) return;
    this.stepStarted = false;
    await turn.markStepFinished();
  }

  /**
   * Process messages from the queue.
   *
   * Delegates to the shared `processQueueMessages` orchestration.
   * On immediate mode, calls `piSession.abort()` before starting the new turn
   * so that Pi's internal loop terminates cleanly.
   * @param queue - User message queue to process
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    await processQueueMessages(queue, {
      getCurrentTurn: () => this.activeTurn,
      onBeforeImmediateTurn: async () => {
        await this.piSession?.abort();
      },
      startNewTurn: (handle, mergedContent) => this.startNewTurn(handle, mergedContent),
    });
  }

  /**
   * Get the current active turn for state inspection.
   *
   * Called by `ProceduralAgentConnector.acceptsImmediate()` to determine
   * whether the current turn can accept an immediate message.
   * @returns The current PiConnectorTurn, or undefined if no turn is active
   */
  public getCurrentTurn(): PiConnectorTurn | undefined {
    return this.activeTurn;
  }

  /**
   * Start a new turn with the given message handle.
   *
   * Builds the prompt text from the handle's message, turn context, and any
   * merged content from superseded messages. Creates a PiConnectorTurn and
   * fires `runPrompt()` as a detached microtask so that processQueue returns
   * immediately (Pi's prompt() is blocking — it runs the full agentic loop).
   * @param handle - Message handle to process
   * @param mergedContent - Optional text from superseded/merged immediate messages
   */
  private async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    this.config.onTurnStart?.(handle);

    const turn = new PiConnectorTurn(
      this.config.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
    );
    this.activeTurn = turn;
    this.currentTurn = turn;
    this.stepStarted = false;
    this.approvedToolInputs.clear();
    this.assistantTextByTurn.set(turn, '');
    handle.adapterSessionId = this.sessionId;
    handle.markAcknowledged();
    await turn.start();

    const promptText = this.buildPromptText(handle, mergedContent);

    queueMicrotask(() => {
      void this.runPrompt(turn, handle, promptText);
    });
  }

  /**
   * Build the full prompt text string from a message handle.
   *
   * Combines:
   * 1. Serialized turn context blocks (e.g., injected context from pre-turn hooks)
   * 2. The primary user message text
   * 3. Merged content from superseded immediate messages
   * @param handle - Message handle containing the message and optional turn context
   * @param mergedContent - Text from superseded/merged messages (immediate mode)
   * @returns Full prompt text for Pi's session.prompt()
   */
  private buildPromptText(handle: MessageHandle, mergedContent?: string[]): string {
    const parts: string[] = [];

    if (handle.messageHistory?.length) {
      parts.push(formatContextBlockAsText('message_history', formatMessageHistoryAsTranscript(handle.messageHistory)));
    }

    if (handle.turnContext) {
      const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
      if (contextText) parts.push(contextText);
    }

    const userText = (handle.message.message as string | undefined) ?? '';
    if (userText) parts.push(userText);

    if (mergedContent?.length) parts.push(mergedContent.join('\n\n'));

    return parts.join('\n\n');
  }

  /**
   * Run a Pi SDK prompt and complete the turn on resolution.
   *
   * `session.prompt()` is a blocking call that resolves only after the full
   * agentic loop (including all tool calls) finishes. Both this resolution path
   * and the `agent_end` event path call `completeTurn()` — the `completedTurns`
   * WeakSet ensures only one takes effect.
   *
   * Per Pi SDK design: errors are delivered as messages with `stopReason: 'error'`
   * and `prompt()` still resolves (not rejects). A rejected promise indicates a
   * crash, not a model error.
   * @param turn - The turn instance for this prompt run
   * @param handle - Message handle tracking lifecycle
   * @param text - Fully assembled prompt text
   */
  private async runPrompt(turn: PiConnectorTurn, handle: MessageHandle, text: string): Promise<void> {
    try {
      await this.piSession!.prompt(text);
      await this.completeTurn(turn, handle, this.buildCompletionResult(turn, this.getTurnAssistantText(turn)));
    } catch (error) {
      if (turn.isPaused()) {
        // Paused for immediate mode — the replacement turn owns finalization
        return;
      }
      const errorResult: MessageResult = {
        outcome: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
      await this.completeTurn(turn, handle, errorResult);
    }
  }

  /**
   * Complete the current turn (idempotent).
   *
   * Called from both the `agent_end` event path and the `prompt()` resolution
   * path. The `completedTurns` WeakSet prevents double-finalization and safely
   * handles delayed completions from previous turns even after a new turn starts.
   *
   * Ordering guarantee:
   * 1. `turn.markTurnFinished()` emits `turn_finished` bus event (agent layer subscribes)
   * 2. `handle.markCompleted()` notifies downstream waiters the turn is done
   * @param turn - The turn instance being finalized
   * @param handle - The message handle for this turn
   * @param result - The message result to record on the handle
   */
  private async completeTurn(turn: PiConnectorTurn, handle: MessageHandle, result: MessageResult): Promise<void> {
    if (this.completedTurns.has(turn)) return;
    this.completedTurns.add(turn);

    if (result.outcome === 'completed' && !this.getTurnAssistantText(turn) && !this.stepStarted) {
      console.warn(
        '[PiConnectorSession] Turn completed with no assistant content — ' +
          'provider may be unreachable or credentials invalid.',
      );
    }

    // Mark the handle complete and notify the connector BEFORE emitting
    // turn_finished. turn_finished triggers the processing-state → idle
    // transition; complete() polls for idle and returns lastResult, so the
    // result must already be set by that point.
    if (!handle.isProcessed) {
      handle.markCompleted(result);
      this.config.onTurnComplete?.(handle, result);
    }

    if (!turn.isPaused()) {
      await turn.markTurnFinished();
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (this.currentTurn === turn) {
        this.currentTurn = undefined;
      }
    }
  }

  /**
   * Abort the session.
   *
   * Overrides BaseConnectorSession.abort() to also call Pi's session.abort(),
   * which signals the in-process agentic loop to stop at the next opportunity.
   */
  public override async abort(): Promise<void> {
    await super.abort();
    await this.piSession?.abort();
  }

  /**
   * Dispose the Pi SDK session and clean up subscriptions.
   *
   * Unsubscribes from the Pi event stream before disposing the session to
   * prevent event handling on a dead session. This is the immediate listener
   * cleanup path; connector shutdown uses `close()` so active Pi work is
   * stopped first.
   */
  public dispose(): void {
    this.piUnsubscribe?.();
    this.piUnsubscribe = undefined;
    this.piSession?.dispose();
  }

  /**
   * Close the session for normal connector shutdown.
   *
   * Pi's `dispose()` only removes listeners; it does not stop active provider
   * work. Close therefore detaches listeners first, pauses the framework turn,
   * and then asks the Pi SDK to stop in-flight work without routing shutdown
   * through the connector's public panic-mode `abort()` path.
   */
  public async close(): Promise<void> {
    this.piUnsubscribe?.();
    this.piUnsubscribe = undefined;
    await this.currentTurn?.pause();
    try {
      await this.piSession?.abort();
    } catch (error) {
      console.warn('[PiConnectorSession] Pi abort failed during close:', error);
    }
    this.piSession?.dispose();
  }

  /**
   * Get the Pi session ID (set after initialize()).
   *
   * Exposed as a public accessor so the connector can read it without
   * depending on BaseConnectorSession's protected `sessionId` field.
   * @returns The Pi session UUID, or undefined before initialize() completes
   */
  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Get the active turn execution context for registry tool calls.
   *
   * Registry tools execute through handlers created at session initialization,
   * so the handler must ask the session for the current message handle when the
   * SDK invokes a tool. This keeps turnContext and turnId aligned with the live
   * prompt instead of the initialization-time adapter snapshot.
   * @returns Current turn ID and turnContext, or an empty object outside a turn
   */
  public getToolExecutionTurnContext(): Pick<ToolExecutionContextOverrides, 'turnId' | 'turnContext'> {
    const handle = this.activeTurn?.messageHandle;
    return {
      ...(handle?.messageId !== undefined && { turnId: handle.messageId }),
      ...(handle?.turnContext !== undefined && { turnContext: handle.turnContext }),
    };
  }

  /**
   * Consume approval-rewritten input for a custom registry tool call.
   * @param toolCallId - Pi tool call identifier
   * @returns Rewritten input when approval supplied one
   */
  public consumeApprovedToolInput(toolCallId: string): Record<string, unknown> | undefined {
    const input = this.approvedToolInputs.get(toolCallId);
    this.approvedToolInputs.delete(toolCallId);
    return input;
  }

  /**
   * Build the turn result from turn-scoped terminal state.
   * @param turn - Turn being completed
   * @param text - Accumulated assistant text for successful turns
   * @returns MessageResult for handle completion
   */
  private buildCompletionResult(turn: PiConnectorTurn, text: string): MessageResult {
    const error = this.turnErrors.get(turn);
    if (error) {
      return { outcome: 'error', error };
    }
    return {
      outcome: 'completed',
      result: { message: text },
    };
  }

  /**
   * Change the active Pi SDK model in-place.
   *
   * Delegates to `piSession.setModel()`, which Pi SDK supports natively.
   * A no-op when the Pi session has not been initialized yet.
   * @param model - The resolved Pi SDK Model object to switch to
   */
  public async setModelOnPiSession(model: Model<never>): Promise<void> {
    await this.piSession?.setModel(model);
  }

  /**
   * Change the active Pi SDK thinking level in-place.
   * @param level - Pi thinking level to apply to subsequent model calls
   */
  public setThinkingLevelOnPiSession(level: PiThinkingLevel): void {
    this.piSession?.setThinkingLevel(level);
  }

  /**
   * Replace the Pi agent's custom tools at runtime.
   *
   * Pi's `Agent.state.tools` setter copies the provided array, making the new
   * tools available to the very next `prompt()` call. Native tools (read, bash,
   * etc.) are managed by Pi separately and are unaffected.
   * @param tools - ToolDefinition[] from `fetchToolsForPi()`
   */
  public updateCustomTools(tools: ToolDefinition[]): void {
    if (!this.piSession) return;

    // state.tools replaces ALL tools (native + custom). Preserve Pi's native
    // tools by filtering out our previously-installed custom tools, then
    // appending the new set.
    const previousCustomNames = this.customToolNames;
    const nativeTools = this.piSession.agent.state.tools.filter((t) => !previousCustomNames.has(t.name));

    this.customToolNames = new Set(tools.map((t) => t.name));
    // The cast is structurally safe: ToolDefinition is a superset of AgentTool,
    // and our execute handlers ignore the extra ExtensionContext parameter.
    this.piSession.agent.state.tools = [...nativeTools, ...(tools as AgentTool[])];
  }
}
