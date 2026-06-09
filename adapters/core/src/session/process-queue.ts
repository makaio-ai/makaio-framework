import type { MessageHandle } from '../message-handle/message-handle.js';
import type { PauseResult } from '../connector/base-connector-turn.js';
import type { UserMessageQueue } from './user-message-queue.js';

/**
 * Minimal turn interface required by processQueue orchestration.
 *
 * Any turn implementation (Claude, Gemini, OpenAI, Copilot) that exposes
 * these methods can participate in the shared processQueue flow.
 */
export interface QueueableTurn {
  canAcceptImmediate(): boolean;
  isCompleted(): boolean;
  getMessageHandle(): MessageHandle;
  pause(): Promise<PauseResult>;
}

/**
 * Result of processing an immediate message merge.
 *
 * Returned by the `extractMergeContent` callback so that adapters
 * can collect adapter-specific content (e.g., Gemini collects non-text parts).
 * The `mergedContent` array is always present; `extra` is an opaque bag
 * for adapter-specific data that flows through to `startNewTurn`.
 */
export interface MergeResult {
  /** Text content collected from superseded/merged messages */
  mergedContent: string[];
  /** Adapter-specific merge data (e.g., non-text parts for Gemini) */
  extra?: unknown;
}

/**
 * Callbacks for adapter-specific behavior during queue processing.
 * @typeParam TExtra - Type of adapter-specific extra merge data
 */
export interface ProcessQueueCallbacks<TExtra = unknown> {
  /**
   * Get the current turn, if any.
   * @returns The current turn or undefined
   */
  getCurrentTurn: () => QueueableTurn | undefined;

  /**
   * Extract text content from a message handle for merge.
   * Default: `handle.message.message as string`
   * @param handle - The message handle to extract content from
   * @returns The text content
   */
  extractContent?: (handle: MessageHandle) => string;

  /**
   * Called after merge content is collected from superseded/enqueued messages.
   * Allows adapters to collect additional content (e.g., Gemini's non-text parts).
   *
   * If not provided, only text content is collected using `extractContent`.
   * @param currentHandle - The in-flight message handle being superseded (or undefined)
   * @param enqueuedHandles - The enqueued handles being merged
   * @returns Extra merge data to pass through to startNewTurn
   */
  collectMergeExtra?: (currentHandle: MessageHandle | undefined, enqueuedHandles: MessageHandle[]) => TExtra;

  /**
   * Hook called after merge is collected but before starting the new turn.
   * Used by Claude to create a fresh query instance.
   */
  onBeforeImmediateTurn?: () => Promise<void>;

  /**
   * Start a new turn with the given message and optional merge data.
   * @param handle - The message handle to process
   * @param mergedContent - Text content from superseded/merged messages
   * @param extra - Adapter-specific extra merge data
   */
  startNewTurn: (handle: MessageHandle, mergedContent?: string[], extra?: TExtra) => Promise<void>;
}

/**
 * Shared processQueue orchestration for all session implementations.
 *
 * Handles the complete immediate-mode flow:
 * 1. Detect immediate message while a turn is active
 * 2. Pause the active turn
 * 3. Supersede the in-flight message and drain enqueued messages
 * 4. Collect merged content from all superseded/merged messages
 * 5. Start a new turn with the immediate message and merged context
 *
 * Also handles the normal queue flow:
 * - Late immediate rejection (immediate arrives after turn finishes)
 * - Normal enqueue/replace message processing
 *
 * Returns `true` when a new turn was started, `false` otherwise.
 * Callers can use this to decide whether to transition to idle when
 * the queue drains without starting a new turn (e.g., all-rejection case).
 * @param queue - The user message queue to process
 * @param callbacks - Adapter-specific callbacks
 * @returns True if a new turn was started, false otherwise
 * @typeParam TExtra - Type of adapter-specific extra merge data
 */
export async function processQueueMessages<TExtra = unknown>(
  queue: UserMessageQueue,
  callbacks: ProcessQueueCallbacks<TExtra>,
): Promise<boolean> {
  const currentTurn = callbacks.getCurrentTurn();
  const extractContent = callbacks.extractContent ?? defaultExtractContent;

  // --- Immediate message handling while turn is active ---
  if (currentTurn?.canAcceptImmediate()) {
    const immediateMsg = queue.findImmediate();
    if (immediateMsg) {
      queue.removeImmediate(immediateMsg);

      const pauseResult = await currentTurn.pause();

      if (!pauseResult.turnEnded) {
        // Successfully paused - merge and restart
        const currentHandle = currentTurn.getMessageHandle();
        const enqueuedHandles = queue.drainEnqueued();

        const mergedContent: string[] = [];

        // Include superseded (in-flight) message's content
        if (currentHandle && !currentHandle.isProcessed) {
          mergedContent.push(extractContent(currentHandle));
          currentHandle.supersededBy = immediateMsg.messageId;
          currentHandle.markCompleted({
            outcome: 'superseded',
            supersededBy: immediateMsg.messageId,
          });
        }

        // Mark enqueued messages as merged and collect their content
        for (const handle of enqueuedHandles) {
          mergedContent.push(extractContent(handle));
          handle.supersededBy = immediateMsg.messageId;
          handle.markCompleted({
            outcome: 'merged',
            mergedInto: immediateMsg.messageId,
          });
        }

        // Collect adapter-specific extra merge data
        const extra = callbacks.collectMergeExtra?.(currentHandle, enqueuedHandles);

        // Hook for pre-turn setup (e.g., Claude creates fresh query)
        await callbacks.onBeforeImmediateTurn?.();

        // Start new turn with the immediate message and merged context
        await callbacks.startNewTurn(immediateMsg, mergedContent, extra);
        return true;
      } else {
        // Turn ended - immediate missed the window, reject it
        immediateMsg.markCompleted({ outcome: 'rejected' });
      }
    }
  }

  // --- Normal queue processing ---
  const nextMsg = queue.peek();
  const canStartQueuedTurn =
    !currentTurn ||
    currentTurn.isCompleted() ||
    (nextMsg?.internalRetry === true && currentTurn.getMessageHandle().isProcessed);
  if (canStartQueuedTurn) {
    if (nextMsg) {
      // Immediate mode is only "late" when it missed an active turn window.
      if (nextMsg.deliveryMode === 'immediate' && currentTurn?.isCompleted()) {
        queue.dequeue();
        nextMsg.markCompleted({ outcome: 'rejected' });
        // Continue processing to handle any remaining enqueued messages
        return processQueueMessages(queue, callbacks);
      }
      // Process enqueue/replace messages normally
      queue.dequeue();
      await callbacks.startNewTurn(nextMsg);
      return true;
    }
  }

  return false;
}

/**
 * Default content extraction: reads `message.message` as string.
 * @param handle - The message handle
 * @returns The message text content
 */
function defaultExtractContent(handle: MessageHandle): string {
  return handle.message.message as string;
}
