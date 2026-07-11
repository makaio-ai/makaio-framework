/* eslint max-lines: ["error", { "max": 515 }] */
import {
  Turn,
  GeminiEventType,
  type ServerGeminiStreamEvent,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
} from '@google/gemini-cli-core';
import {
  BaseConnectorSession,
  UserMessageQueue,
  markCompletedWithFinalResult,
  processQueueMessages,
  serializeTurnContext,
  formatContextBlocksAsText,
  type MessageHandle,
} from '@makaio/ai-adapters-core';
import { GeminiConnectorTurn } from './turn.js';
import { convertMessageHistory } from './utils/convertMessageHistory.js';
import { getChunkType } from './utils/turn-processor.js';
import { executeToolCalls } from './utils/execute-tool-calls.js';
import { extractTextFromMessage } from './utils/extractTextFromMessage.js';
import { extractNonTextParts } from './utils/extractNonTextParts.js';
import { buildRequestParts } from './utils/buildRequestParts.js';
import { GeminiSessionConfig } from './types/index.js';
import { RateLimitError, AuthenticationError, ModelUnavailableError, QuotaExceededError } from '@makaio/core';
import { geminiRateLimiter } from './rate-limiter.js';

type GeminiPart = ToolCallResponseInfo['responseParts'][number];

/** Default delay (ms) when rate-limit response doesn't specify retry-after. */
const DEFAULT_RATE_LIMIT_DELAY = 3000;

/** Maximum rate-limit retries per turn before propagating the error. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Extracted error details from an unknown SDK error value. */
type ErrorInfo = { message: string; status?: number };

/**
 * Parse a numeric HTTP status from numbers or numeric strings.
 * @param rawStatus - Candidate status value from SDK payloads
 * @returns Parsed integer status, or undefined when unusable
 */
function parseStatus(rawStatus: unknown): number | undefined {
  if (typeof rawStatus === 'number' && Number.isInteger(rawStatus)) {
    return rawStatus;
  }
  if (typeof rawStatus === 'string' && rawStatus.trim() !== '') {
    const parsed = Number(rawStatus);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}
/**
 * Preserve structured error detail instead of collapsing objects to "[object Object]".
 * @param value - Unknown SDK error field value
 * @returns String preserving JSON-serializable structure when possible
 */
function stringifyErrorValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
/**
 * Extract a message and optional HTTP status from an unknown SDK error value.
 * @param error - The raw error value (may be an Error instance, structured object, or primitive)
 * @returns Extracted message string and optional numeric status
 */
function extractErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return { message: error.message, status: parseStatus((error as Error & { status?: unknown }).status) };
  }
  if (typeof error === 'object' && error !== null) {
    const message =
      'message' in error ? stringifyErrorValue((error as { message: unknown }).message) : stringifyErrorValue(error);
    const status = parseStatus('status' in error ? (error as { status: unknown }).status : undefined);
    return { message, status };
  }
  return { message: String(error) };
}
/**
 * Classify error message from Gemini SDK into appropriate MakaioError subclass.
 * @param message - Error message from the SDK
 * @param status - Optional HTTP status code from the error
 * @returns MakaioError subclass instance or generic Error
 */
function classifyGeminiError(message: string, status?: number): Error {
  // Check HTTP status codes first for definitive classification
  if (status === 401 || status === 403) {
    return new AuthenticationError(message);
  }
  if (status === 404 && message.toLowerCase().includes('model')) {
    return new ModelUnavailableError(message);
  }
  if (status === 429) {
    // Distinguish between rate limit (temporary) and quota exceeded (limit reached)
    if (message.includes('quota')) {
      return new QuotaExceededError(message);
    }
    return new RateLimitError(message);
  }
  // Fall back to message content matching
  if (message.includes('exhausted your capacity') || message.toLowerCase().includes('rate limit')) {
    return new RateLimitError(message);
  }
  if (message.includes('quota')) {
    return new QuotaExceededError(message);
  }
  if (message.toLowerCase().includes('authentication') || message.toLowerCase().includes('unauthorized')) {
    return new AuthenticationError(message);
  }
  if (message.toLowerCase().includes('model') && (message.includes('not found') || message.includes('unavailable'))) {
    return new ModelUnavailableError(message);
  }

  // Unclassified error - return generic Error (no errorCategory)
  return new Error(message);
}

/**
 * Parse the retry delay hint from a Gemini rate-limit error message.
 * Example: "Your quota will reset after 1s." → 1000
 * @param message - Error message containing a retry delay hint
 * @returns Delay in milliseconds, or undefined if no hint was found
 */
function parseRetryDelay(message: string): number | undefined {
  const match = message.match(/reset after (\d+)s/);
  return match ? parseInt(match[1], 10) * 1000 : undefined;
}

/**
 * Session for Gemini SDK lifecycle management.
 * Manages GeminiChat and Turn instances across multiple user messages.
 * Handles immediate mode via abort+restart (no true pause). Abort via AbortController.
 */
export class GeminiConnectorSession extends BaseConnectorSession<GeminiSessionConfig> {
  protected declare currentTurn?: GeminiConnectorTurn;
  private lastTurnContent?: string;

  public constructor(config: GeminiSessionConfig) {
    super(config);
    this.sessionId = config.geminiConfig.getSessionId();
  }

  /**
   * Process messages from the queue.
   * Creates new turn or handles immediate injection via abort+restart.
   * @param queue - User message queue to process
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    await processQueueMessages<GeminiPart[] | undefined>(queue, {
      getCurrentTurn: () => this.currentTurn,
      extractContent: (handle) => extractTextFromMessage(handle.message),
      collectMergeExtra: (currentHandle, enqueuedHandles) => {
        const mergedNonTextParts: GeminiPart[] = [];
        if (currentHandle && !currentHandle.isProcessed) {
          mergedNonTextParts.push(...extractNonTextParts(currentHandle.message));
        }
        for (const h of enqueuedHandles) {
          mergedNonTextParts.push(...extractNonTextParts(h.message));
        }
        return mergedNonTextParts.length ? mergedNonTextParts : undefined;
      },
      startNewTurn: (handle, mergedContent, extra) => this.startNewTurn(handle, mergedContent?.filter(Boolean), extra),
    });
  }

  /**
   * Start a new turn with the given message.
   * @param handle - Message handle to process
   * @param mergedContent - Optional text content from superseded/merged messages (for immediate mode)
   * @param mergedNonTextParts - Optional non-text parts (images, documents) from superseded/merged messages
   */
  private async startNewTurn(
    handle: MessageHandle,
    mergedContent?: string[],
    mergedNonTextParts?: GeminiPart[],
  ): Promise<void> {
    this.config.onTurnStart?.(handle);
    this.setHistory(handle);

    // Capture turn in local variable to avoid race conditions - immediate arrivals may
    // overwrite this.currentTurn, but the captured reference flows through runTurn/processTurnEvents
    const turn = new GeminiConnectorTurn(
      this.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
    );
    this.currentTurn = turn;
    this.lastTurnContent = undefined;
    handle.markAcknowledged();

    // Run turn asynchronously with captured turn reference.
    // Turn finalization (markTurnFinished) is in `finally` to guarantee the turn state machine
    // always reaches a terminal state — the reference claude-code adapter achieves this via
    // event-driven turns; procedural adapters must enforce the invariant explicitly.
    queueMicrotask(async () => {
      try {
        await this.runTurn(turn, handle, mergedContent, mergedNonTextParts);

        if (!handle.isProcessed) {
          const result = {
            outcome: 'completed' as const,
            result: { message: this.lastTurnContent || '(Empty response)' },
          };
          await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);

          await this.config.emitSdkEvent({
            type: 'session.completed',
            message: this.lastTurnContent || '(Empty response)',
          });
        }
      } catch (error) {
        // Aborted for immediate mode — the replacement turn takes over
        if (turn.isPaused()) {
          return;
        }

        console.error('[GeminiSession] Turn error:', error);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const errorResult = {
          outcome: 'error' as const,
          error: normalizedError,
        };
        if (!handle.isProcessed) {
          await markCompletedWithFinalResult(handle, errorResult, this.config.onTurnComplete);
        }
        this.config.handleError(normalizedError, false);
      } finally {
        // Guarantee turn finalization: emit turn_finished so the connector transitions
        // through processing_finished → idle (or processes the next queued message).
        // Skipped when paused for immediate mode — the replacement turn owns finalization.
        if (!turn.isPaused()) {
          await turn.markTurnFinished();
          if (this.currentTurn === turn) {
            this.currentTurn = undefined;
          }
        }
      }
    });
  }

  /**
   * Set history on GeminiChat from message handle.
   *
   * Only injects history when the handle carries explicit messageHistory (e.g., after
   * connector swap / rehydration with isFirstTurn). Normal follow-up messages have no
   * messageHistory — the SDK's native conversation history is preserved by doing nothing.
   * @param handle - Message handle containing messageHistory
   */
  private setHistory(handle: MessageHandle): void {
    if (handle.messageHistory && handle.messageHistory.length > 0) {
      const geminiHistory = convertMessageHistory(handle.messageHistory);
      this.config.geminiChat.setHistory(geminiHistory);
    }
  }

  /**
   * Roll back GeminiChat history to the length captured before a request attempt.
   *
   * The SDK may fail before appending to history (e.g. transport/rate-limit failures),
   * so retries must only truncate when the history actually grew.
   * @param previousLength - History length captured before the failed attempt
   */
  private popLastHistoryEntry(previousLength: number): void {
    const history = this.config.geminiChat.getHistory();
    if (history.length > previousLength) {
      this.config.geminiChat.setHistory(history.slice(0, previousLength));
    }
  }

  /**
   * Run a turn for the given message.
   * @param turn - The turn instance to run (captured at start, not dereferenced from this.currentTurn)
   * @param handle - Message to process
   * @param mergedContent - Optional text content from superseded/merged messages (for immediate mode)
   * @param mergedNonTextParts - Optional non-text parts (images, documents) from superseded/merged messages
   */
  // eslint-disable-next-line max-lines-per-function
  private async runTurn(
    turn: GeminiConnectorTurn,
    handle: MessageHandle,
    mergedContent?: string[],
    mergedNonTextParts?: GeminiPart[],
  ): Promise<void> {
    await turn.start();

    const userMessage = extractTextFromMessage(handle.message);
    const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
    const effectiveMessage = contextText ? `${contextText}\n\n${userMessage}` : userMessage;
    let requestParts = buildRequestParts(effectiveMessage, mergedContent, mergedNonTextParts);
    let aggregatedContent = '';
    let shouldEmitTurnStart = true;
    let emptyResponseRetries = 0;
    let rateLimitRetries = 0;
    const abortSignal = turn.getAbortSignal();

    while (!abortSignal.aborted) {
      const historyLengthBefore = this.config.geminiChat.getHistory().length;
      const promptId = crypto.randomUUID();
      const sdkTurn = new Turn(this.config.geminiChat, promptId);

      let turnResult: Awaited<ReturnType<typeof this.processTurnEvents>>;
      try {
        turnResult = await geminiRateLimiter.add(
          async () => {
            const events = sdkTurn.run({ model: this.config.geminiConfig.getModel() }, requestParts, abortSignal);
            return this.processTurnEvents(turn, events, { emitTurnStart: shouldEmitTurnStart });
          },
          { priority: 0 },
        );
      } catch (error) {
        // Retry rate-limit errors with the delay hinted by the API response
        if (error instanceof RateLimitError && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++;
          const delay = parseRetryDelay(error.message) ?? DEFAULT_RATE_LIMIT_DELAY;
          console.warn(
            `[GeminiSession] Rate limit hit, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          this.popLastHistoryEntry(historyLengthBefore);
          continue;
        }
        // Non-retryable or retries exhausted: emit session.error for rate-limit, re-throw
        if (error instanceof RateLimitError) {
          await this.config.emitSdkEvent({ type: 'session.error', error: error.message });
        }
        throw error;
      }

      const { messageContent, toolCalls, encounteredInvalidStream, lastChunkType, reasoning } = turnResult;
      rateLimitRetries = 0;

      if (messageContent) {
        aggregatedContent += messageContent;
      }

      // Emit step_finished
      if (lastChunkType) {
        await turn.markStepFinished();
      }

      // If no tool calls, turn is ending
      if (!toolCalls.length) {
        // Retry empty responses: invalid streams or post-tool (quota pressure yields 0 candidates)
        if (!messageContent && (encounteredInvalidStream || !shouldEmitTurnStart)) {
          if (emptyResponseRetries >= 2) {
            break;
          }
          emptyResponseRetries += 1;
          this.popLastHistoryEntry(historyLengthBefore);
          continue;
        }
        break;
      }

      const { responseParts } = await executeToolCalls(toolCalls, {
        bus: this.config.globalBus,
        geminiConfig: this.config.geminiConfig,
        geminiChat: this.config.geminiChat,
        turnAbortController: { signal: abortSignal, abort: () => {} } as AbortController,
        emitSdkEvent: this.config.emitSdkEvent,
        handleError: this.config.handleError,
        requestToolApproval: this.config.requestToolApproval,
        adapterId: this.config.adapterId,
        adapterName: this.config.adapterName,
        agentId: this.config.agentId,
        sessionId: this.sessionId,
        turnId: handle.messageId,
        reasoning,
        registryToolNames: this.config.registryToolNames,
        toolLedger: this.config.toolLedger,
        getCurrentTurnNumber: this.config.getCurrentTurnNumber,
      });
      if (!responseParts.length) break;
      requestParts = responseParts;
      shouldEmitTurnStart = false;
    }
    this.lastTurnContent = aggregatedContent;
  }

  /**
   * Process Turn events, emit SDK events, track state, and return accumulated results.
   * @param turn - The turn instance to use for state transitions (captured at start, not dereferenced)
   * @param events - Async generator of SDK events
   * @param options - Processing options
   * @returns Accumulated message content, tool calls, stream validity, last chunk type, and reasoning
   */
  // eslint-disable-next-line max-lines-per-function
  private async processTurnEvents(
    turn: GeminiConnectorTurn,
    events: AsyncGenerator<ServerGeminiStreamEvent>,
    options: { emitTurnStart?: boolean } = {},
  ): Promise<{
    messageContent: string;
    toolCalls: ToolCallRequestInfo[];
    encounteredInvalidStream: boolean;
    lastChunkType: 'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | undefined;
    reasoning: string | undefined;
  }> {
    const toolCalls: ToolCallRequestInfo[] = [];
    let turnStarted = !(options.emitTurnStart ?? true);
    let lastChunkType: 'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | undefined;
    let messageContent = '';
    let accumulatedReasoning = '';
    let encounteredInvalidStream = false;

    for await (const event of events) {
      if (turn.isPaused()) break;
      if (!turnStarted) turnStarted = true;

      const eventChunkType = getChunkType(event);
      if (eventChunkType && !lastChunkType) {
        await turn.markStepStarted();
        lastChunkType = eventChunkType;
      }

      if (event.type === GeminiEventType.ToolCallRequest) {
        toolCalls.push(event.value);
        continue;
      }

      await this.config.emitSdkEvent({ type: 'sdk.raw', raw: event });

      switch (event.type) {
        case GeminiEventType.Content:
          messageContent += event.value;
          await this.config.emitSdkEvent({ type: 'agent.message.chunk', content: { type: 'text', text: event.value } });
          break;
        case GeminiEventType.Thought:
          accumulatedReasoning += `${accumulatedReasoning.length > 0 ? '\n' : ''}${event.value.description}`;
          await this.config.emitSdkEvent({
            type: 'agent.thought.chunk',
            content: { type: 'text', text: event.value.description },
          });
          break;
        case GeminiEventType.Finished:
          await this.config.emitSdkEvent({
            type: 'session.finished',
            model: this.config.model,
            reason: event.value.reason,
            usageMetadata: event.value.usageMetadata,
          });
          break;
        case GeminiEventType.Error: {
          const { message: errorMessage, status } = extractErrorInfo(event.value.error);
          const classifiedError = classifyGeminiError(errorMessage, status);

          // Rate-limit errors: throw typed error WITHOUT emitting session.error.
          // runTurn retries these; session.error is emitted only after retries exhausted.
          if (classifiedError instanceof RateLimitError) {
            throw classifiedError;
          }

          // For all other errors, emit session.error then throw
          await this.config.emitSdkEvent({
            type: 'session.error',
            error: errorMessage,
            status,
          });
          throw classifiedError;
        }
        case GeminiEventType.InvalidStream:
          encounteredInvalidStream = true;
          break;
        case GeminiEventType.AgentExecutionStopped:
          console.warn('[GeminiSession] Agent execution stopped:', event.value.reason);
          break;
        case GeminiEventType.AgentExecutionBlocked:
          console.warn('[GeminiSession] Agent execution blocked:', event.value.reason);
          break;
      }
    }
    return {
      messageContent,
      toolCalls,
      encounteredInvalidStream,
      lastChunkType,
      reasoning: accumulatedReasoning || undefined,
    };
  }

  /**
   * Get current turn for state inspection.
   * @returns The current turn instance, or undefined if no turn is active
   */
  public getCurrentTurn(): GeminiConnectorTurn | undefined {
    return this.currentTurn;
  }
}
