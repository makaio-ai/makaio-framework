/* eslint max-lines: ["error", { "max": 500 }] */
import { CopilotSession, type SessionEvent } from '@github/copilot-sdk';
import {
  BaseConnectorSession,
  UserMessageQueue,
  formatMessageHistoryAsTranscript,
  markCompletedWithFinalResult,
  processQueueMessages,
  rejectQueuedHandles,
  serializeTurnContext,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  type MessageHandle,
} from '@makaio/ai-adapters-core';
import { CopilotConnectorTurn } from './turn.js';
import { type CopilotSessionEvent, type AssistantMessageEvent } from './namespaces/index.js';
import { normalizedMessageToPrompt } from './utils/normalizedMessageToPrompt.js';
import { CopilotSessionConfig } from './types';
import { initializeCopilotSdkSession } from './sdk-session-initialization.js';

/** Default delay (ms) when rate-limit response doesn't specify retry-after. */
const DEFAULT_RATE_LIMIT_DELAY = 3000;

/** Maximum rate-limit retries per turn before propagating the error. */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Inactivity timeout (ms) for stuck SDK turns.
 * If the SDK fires assistant.turn_start but produces no content events within
 * this window, the session force-finalizes the turn to prevent infinite hangs.
 */
const INACTIVITY_TIMEOUT_MS = 60_000;

/**
 * SDK event types that indicate real progress (content, tool activity, turn lifecycle).
 * Non-content events like session.usage_info, pending_messages.modified, assistant.intent,
 * and assistant.usage are metadata-only and do NOT reset the inactivity timer.
 */
const CONTENT_EVENT_TYPES = new Set([
  'assistant.message',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.turn_end',
  'tool.user_requested',
  'tool.execution_start',
  'tool.execution_complete',
  'session.idle',
]);

/**
 * Check whether an error message indicates a retryable rate-limit error.
 * @param message - Error message from the SDK
 * @returns True if the error is a retryable rate-limit error
 */
function isRetryableError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests');
}

/**
 * Parse the retry delay hint from an error message.
 * Example: "Retry-After: 5" → 5000
 * @param message - Error message containing a retry delay hint
 * @returns Delay in milliseconds, or undefined if no hint was found
 */
function parseRetryDelay(message: string): number | undefined {
  const match = message.match(/retry[- ]after[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) * 1000 : undefined;
}

/**
 * Session for GitHub Copilot SDK lifecycle management.
 *
 * Wraps SDK Session and manages Turn instances for each user message:
 * - Creates SDK Session on first use
 * - Creates Turn instances per message
 * - Handles immediate mode via SDK's native mode:'immediate'
 * - Processes message queue with merge support
 *
 * SDK events are callback-based; messages use `session.send()` with immediate
 * or enqueue mode.
 */
export class CopilotConnectorSession extends BaseConnectorSession<CopilotSessionConfig> {
  private sdkSession?: CopilotSession;
  protected declare currentTurn?: CopilotConnectorTurn;
  private lastAssistantMessage?: AssistantMessageEvent;
  /** Set when SDK emits 'abort' — the next session.idle is the abort's idle, not a completion. */
  private pendingAbort = false;
  /** Track retryable errors for retry logic in handleSessionIdleForTurn */
  private rateLimitRetries = 0;
  private lastRetryableError?: string;
  private lastSendPrompt?: string;
  private lastSendMode?: 'immediate' | 'enqueue';
  /** Timer handle for stuck-turn inactivity watchdog. */
  private inactivityTimer?: ReturnType<typeof setTimeout>;
  public constructor(config: CopilotSessionConfig) {
    super(config);
  }
  /**
   * Initialize the SDK Session.
   * Called lazily on first message. The session persists across turns —
   * immediate mode uses the SDK's native mode:'immediate' rather than recreating.
   */
  public async initialize(): Promise<void> {
    if (this.sdkSession) return;
    this.sdkSession = await initializeCopilotSdkSession({
      client: this.config.client,
      sessionConfig: this.config.sessionConfig,
      isClosing: () => this.closing,
    });
    this.sessionId = this.sdkSession.sessionId;

    this.sdkSession.on((event: SessionEvent) => {
      void this.processEvent(event as CopilotSessionEvent).catch((error) => {
        console.error('[CopilotSession] Event processing error:', error);
        this.config.handleError(error instanceof Error ? error : new Error(String(error)), false);
      });
    });
  }
  /**
   * Process messages from the queue.
   * Creates new turn or handles immediate injection via SDK's mode:'immediate'.
   * @param queue - UserMessageQueue with messages to process
   * @returns Promise that resolves when queue processing is complete
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    if (this.closing) {
      rejectQueuedHandles(queue);
      return;
    }
    await processQueueMessages(queue, {
      getCurrentTurn: () => this.currentTurn,
      startNewTurn: (handle, mergedContent) => this.startNewTurn(handle, mergedContent),
    });
  }

  /**
   * Start a new turn with the given message.
   * @param handle - Message handle to process
   * @param mergedContent - Optional content from superseded/merged messages
   * @returns `false` when terminal close completed the handle before SDK send
   */
  private async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void | false> {
    if (!this.sdkSession) {
      await this.initialize();
    }

    // Notify connector that turn is starting
    this.config.onTurnStart?.(handle);

    // Create turn
    this.currentTurn = new CopilotConnectorTurn(
      this.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
    );

    // Reset state (including retry tracking)
    this.lastAssistantMessage = undefined;
    this.rateLimitRetries = 0;
    this.lastRetryableError = undefined;

    // Build prompt: innermost → outermost is user text → turnContext → merged_context → message_history
    let prompt = normalizedMessageToPrompt(handle.message);

    // Prepend turnContext (closest to user text)
    const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
    if (contextText) {
      prompt = `${contextText}\n\n${prompt}`;
    }

    // Prepend merged content if present (for immediate mode)
    if (mergedContent && mergedContent.length > 0) {
      prompt = `${formatContextBlockAsText('merged_context', mergedContent.join('\n'))}\n\n${prompt}`;
    }

    // Prepend message history (outermost wrapper)
    if (handle.messageHistory && handle.messageHistory.length > 0) {
      const historyTranscript = formatMessageHistoryAsTranscript(handle.messageHistory);
      prompt = `${formatContextBlockAsText('message_history', historyTranscript)}\n\n${prompt}`;
    }

    // Store send params for retry
    this.lastSendPrompt = prompt;
    this.lastSendMode = handle.deliveryMode === 'immediate' ? 'immediate' : 'enqueue';
    // Start turn state machine
    await this.currentTurn.start();
    if (this.completeHandleIfClosing(handle)) return false;
    // Send message asynchronously
    queueMicrotask(async () => {
      // Guard: Don't send if turn was superseded/paused before microtask ran
      if (this.currentTurn?.isPaused() || handle.isProcessed) return;

      try {
        await this.sdkSession!.send({
          prompt,
          mode: this.lastSendMode,
        });
        handle.markAcknowledged();
      } catch (error) {
        // Check if paused (immediate mode superseded this turn)
        if (this.currentTurn?.isPaused()) return;
        const errorResult = {
          outcome: 'error' as const,
          error: error instanceof Error ? error.message : String(error),
        };
        if (!handle.isProcessed) {
          await markCompletedWithFinalResult(handle, errorResult, this.config.onTurnComplete);
        }
        this.config.handleError(error instanceof Error ? error : new Error(String(error)), false);

        // CRITICAL: Emit turn_finished so connector updates state and drains queue
        await this.currentTurn?.markTurnFinished();
      }
    });
  }

  /**
   * Track session-level state from SDK events (messages, aborts, errors).
   * Extracted from processEvent to keep complexity manageable.
   * @param event - Copilot SDK event
   * @param turn - The turn active when the event was received
   */
  private trackEventState(event: CopilotSessionEvent, turn: CopilotConnectorTurn | undefined): void {
    // Reset inactivity watchdog on any content event
    if (CONTENT_EVENT_TYPES.has(event.type)) {
      this.clearInactivityTimer();
    }

    // Track assistant message for completion result
    if (event.type === 'assistant.message') {
      this.lastAssistantMessage = event;
    }

    // Track abort events — the next session.idle is the abort's idle, not a completion.
    // The SDK emits abort when mode:'immediate' cancels the in-flight turn.
    if (event.type === 'abort') {
      this.pendingAbort = true;
    }

    // Track retryable errors (session.error fires BEFORE session.idle)
    if (event.type === 'session.error') {
      const errorMessage = event.data?.message || String(event.data || '');
      if (isRetryableError(errorMessage)) {
        this.lastRetryableError = errorMessage;
      } else {
        this.lastRetryableError = undefined;
      }
    }

    // Handle message acknowledgment BEFORE state transitions
    if (event.type === 'user.message' && turn) {
      turn.markAcknowledged();
    }
  }

  /**
   * Process SDK event - update turn state and track completion.
   * @param event - Copilot SDK event
   */
  private async processEvent(event: CopilotSessionEvent): Promise<void> {
    // Capture current turn BEFORE event processing might trigger a new turn
    // CRITICAL: Must capture before handleSdkEvent which can trigger turn_finished
    // bus event that starts a new turn
    const turnAtEventStart = this.currentTurn;

    // Emit raw SDK event
    await this.config.emitSdkEvent(event);

    // Track session-level state (messages, aborts, errors, acknowledgments)
    this.trackEventState(event, turnAtEventStart);

    // NOTE: Do NOT complete message on assistant.turn_end - SDK can have multiple turns
    // per message (e.g., turn 0: report_intent, turn 1: file write). Completion happens
    // on session.idle when ALL turns are done.

    // Let turn handle state transitions (may emit turn_finished which triggers new turn)
    if (turnAtEventStart && !turnAtEventStart.isPaused()) {
      await turnAtEventStart.handleSdkEvent(event);
    }

    // Start inactivity watchdog when SDK begins a new sub-turn.
    // If the sub-turn produces content, the timer is cancelled above.
    // If it goes silent (only session.usage_info), the timer force-finalizes.
    if (event.type === 'assistant.turn_start' && turnAtEventStart && !turnAtEventStart.isPaused()) {
      this.startInactivityTimer(turnAtEventStart);
    }

    // Handle session.idle as fallback for completion (if turn_end didn't fire)
    if (event.type === 'session.idle') {
      await this.handleSessionIdleForTurn(turnAtEventStart);
    }
  }

  /**
   * Handle session.idle event - complete turn and emit turn_finished.
   * Uses the turn reference captured at event start to avoid race conditions.
   * @param turn - The turn that was active when session.idle fired
   */
  private async handleSessionIdleForTurn(turn: CopilotConnectorTurn | undefined): Promise<void> {
    if (!turn || turn.isPaused()) return;

    // Consume the abort-related idle: SDK emits abort → session.idle when
    // mode:'immediate' cancels in-flight processing. This idle is NOT a completion.
    if (this.pendingAbort) {
      this.pendingAbort = false;
      return;
    }

    const handle = turn.getMessageHandle();
    const turnState = turn.getState();

    // Bail if turn never started
    if (turnState === 'idle') return;

    // Turn is in 'turn_started' (no content received yet) - check for retryable error
    if (turnState === 'turn_started') {
      // If we have a retryable error AND retries remaining: retry the send
      if (this.lastRetryableError && this.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        this.rateLimitRetries++;
        const delay = parseRetryDelay(this.lastRetryableError) ?? DEFAULT_RATE_LIMIT_DELAY;
        console.warn(
          `[CopilotSession] Rate limit hit, retry ${this.rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`,
        );

        // Wait for retry delay
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Clear error flag before retry
        this.lastRetryableError = undefined;

        // Re-send the message (turn stays in turn_started, waiting for SDK events)
        try {
          await this.sdkSession!.send({
            prompt: this.lastSendPrompt!,
            mode: this.lastSendMode!,
          });
          // Return without finalizing - the turn continues waiting for SDK events
          return;
        } catch (error) {
          // Retry send failed - fall through to error finalization
          console.error('[CopilotSession] Retry send failed:', error);
        }
      }

      // Non-retryable error OR retries exhausted: mark error and finalize
      if (!handle.isProcessed) {
        const errorResult = {
          outcome: 'error' as const,
          error: this.lastRetryableError || 'Turn failed to start',
        };
        await markCompletedWithFinalResult(handle, errorResult, this.config.onTurnComplete);
        this.config.handleError(new Error(errorResult.error), false);
      }
      await turn.markTurnFinished(true);
      return;
    }

    // Turn progressed past turn_started - complete successfully
    if (!handle.isProcessed) {
      const result = {
        outcome: 'completed' as const,
        result: { message: this.lastAssistantMessage?.data?.content },
      };
      await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);
      // Reset retry state on success
      this.rateLimitRetries = 0;
      this.lastRetryableError = undefined;
    }
    // CRITICAL: Always emit turn_finished on session.idle to ensure connector transitions to idle.
    // The turn might already be in turn_finished state (from assistant.turn_end), but we need
    // to re-emit so the connector's handler sees the message is now processed and goes to idle.
    await turn.markTurnFinished(true);
  }

  /**
   * Start an inactivity watchdog for a turn.
   *
   * The Copilot SDK sometimes starts a follow-up sub-turn (assistant.turn_start)
   * after tool execution that never produces content or a turn_end, leaving the
   * connector stuck. This timer force-finalizes the turn if no content events
   * arrive within INACTIVITY_TIMEOUT_MS.
   * @param turn - The turn to monitor for inactivity
   */
  private startInactivityTimer(turn: CopilotConnectorTurn): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      void this.forceFinalizeInactiveTurn(turn);
    }, INACTIVITY_TIMEOUT_MS);
  }

  /**
   * Force-finalize a turn whose SDK stream stopped producing progress events.
   * @param turn - The inactive turn to finalize
   */
  private async forceFinalizeInactiveTurn(turn: CopilotConnectorTurn): Promise<void> {
    this.inactivityTimer = undefined;

    // Only act if this turn is still current and active
    if (this.currentTurn !== turn || turn.isPaused()) return;

    const handle = turn.getMessageHandle();
    if (handle.isProcessed) return;

    console.warn('[CopilotSession] Inactivity timeout — force-finalizing stuck turn');

    // If content was received before the stall, complete successfully with partial content.
    // If no content at all, surface as error so consumers can distinguish timeout from empty response.
    const hasContent = !!this.lastAssistantMessage?.data?.content;
    const result = hasContent
      ? {
          outcome: 'completed' as const,
          result: { message: this.lastAssistantMessage!.data!.content },
        }
      : {
          outcome: 'error' as const,
          error: `Inactivity timeout after ${INACTIVITY_TIMEOUT_MS / 1000}s — no content received`,
        };
    if (result.outcome === 'error') {
      this.config.handleError(new Error(result.error), false);
    }
    await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);

    await turn.markTurnFinished(true);
  }

  /**
   * Cancel the inactivity watchdog timer if active.
   */
  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
  }

  /**
   * Abort the current message without ending the reusable session.
   *
   * SDK rejection propagates so teardown can report an unaccounted abort;
   * interrupt callers handle that failure at their own boundary.
   * @throws When the SDK rejects the abort.
   */
  public async abort(): Promise<void> {
    this.clearInactivityTimer();
    await this.currentTurn?.pause();

    // Call SDK abort to cancel in-flight request
    await this.sdkSession?.abort();
  }

  /**
   * Permanently prevent new queue work during connector shutdown.
   * @param queue - Connector queue whose unstarted handles must be completed
   */
  public beginClose(queue?: UserMessageQueue): void {
    this.closing = true;
    if (queue) rejectQueuedHandles(queue);
  }

  /**
   * Destroy the session and release resources.
   * The handle is dropped even if the SDK rejects, while the rejection propagates
   * so teardown can report the unaccounted release.
   * @throws When the SDK rejects the destroy.
   */
  public async destroy(): Promise<void> {
    this.clearInactivityTimer();
    const sdkSession = this.sdkSession;
    if (!sdkSession) return;
    this.sdkSession = undefined;
    await sdkSession.destroy();
  }

  /**
   * Get the session ID.
   * @returns The session ID from the SDK
   */
  public async getAdapterSessionId(): Promise<string> {
    if (!this.sessionId && this.sdkSession) {
      this.sessionId = this.sdkSession.sessionId;
    }
    return this.sessionId!;
  }

  /**
   * Get current turn for state inspection.
   * @returns Current turn or undefined if no active turn
   */
  public getCurrentTurn(): CopilotConnectorTurn | undefined {
    return this.currentTurn;
  }

  /** @throws Always - use processQueue instead */
  public async sendMessage(): Promise<void> {
    throw new Error('Use processQueue instead');
  }
}
