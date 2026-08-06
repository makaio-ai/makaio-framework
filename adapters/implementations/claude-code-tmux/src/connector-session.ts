import {
  UserMessageQueue,
  markCompletedWithFinalResult,
  processQueueMessages,
  type MessageHandle,
  type MessageResult,
} from '@makaio/ai-adapters-core';
import { TmuxConnectorTurn } from './turn.js';
import { buildMessageText } from './utils/prompt.js';
import type { TmuxConnectorSessionConfig } from './types.js';

/**
 * Manages the active turn and queue processing for one Claude Code tmux session.
 */
export class TmuxConnectorSession {
  private readonly config: TmuxConnectorSessionConfig;
  private activeTurn: TmuxConnectorTurn | undefined;
  /** Tool calls retain their originating turn across immediate supersession. */
  private readonly toolCallTurns = new Map<string, TmuxConnectorTurn>();
  /**
   * Guards against late Stop hooks racing with a freshly started turn.
   *
   * Invariant: after an ESC-without-Stop (interrupt settling), the previous
   * turn's Stop hook from Claude Code may arrive after the new turn has already
   * been sent. If that late Stop were processed normally it would complete the
   * new turn prematurely. This flag suppresses all Stop events from the time an
   * interrupt-settle begins until `UserPromptSubmit` fires, which confirms that
   * Claude Code has accepted the new prompt and is ready for the next turn's
   * lifecycle.
   */
  private suppressStopUntilPromptSubmit = false;

  /**
   * Finalisation currently in flight, keyed by the turn it is finalising.
   *
   * `isCompleted()` only becomes true inside the finalisation, after its first
   * await, so a guard placed before that await leaves a window in which two
   * finalisers can both pass it. The tmux connector reaches that window on an
   * ordinary race: a teardown finalises the active turn while the retained
   * process-exit listener finalises the same turn for the same reason. Recording
   * the in-flight promise closes the window — the second caller joins the first
   * instead of completing one message handle twice.
   */
  private activeTurnFinalization: { readonly turn: TmuxConnectorTurn; readonly settled: Promise<void> } | undefined;

  /**
   * Create a TmuxConnectorSession bound to a connector instance.
   * @param config - Bundled session dependencies and callbacks.
   */
  public constructor(config: TmuxConnectorSessionConfig) {
    this.config = config;
  }

  /**
   * Get the currently active turn, if any.
   * @returns The active turn or `undefined` when idle.
   */
  public getCurrentTurn(): TmuxConnectorTurn | undefined {
    return this.activeTurn;
  }

  /**
   * Process the message queue through shared queue orchestration.
   * @param queue - The connector's user message queue.
   * @returns `true` when a new turn was started.
   */
  public async processQueue(queue: UserMessageQueue): Promise<boolean> {
    return processQueueMessages(queue, {
      getCurrentTurn: () => this.activeTurn,
      onBeforeImmediateTurn: async () => {
        await this.config.tmuxSession.waitForInputReady();
        const beforeClear = this.config.tmuxSession.captureVisible();
        this.config.tmuxSession.clearInput();
        await this.config.tmuxSession.waitForVisibleChange(beforeClear);
      },
      startNewTurn: async (handle, mergedContent) => {
        await this.startTurn(handle, mergedContent);
      },
    });
  }

  /**
   * Start a new turn and send its prompt to Claude Code.
   * @param handle - Message handle for the new turn.
   * @param mergedContent - Optional superseded/merged content.
   */
  private async startTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    const turn = new TmuxConnectorTurn(
      this.config.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
      () => this.config.tmuxSession.sendEscape(),
      this.config.interruptSettleMs,
      () => {
        this.suppressStopUntilPromptSubmit = true;
      },
    );

    this.activeTurn = turn;
    try {
      this.config.onTurnStart(handle);
      await turn.start();
      await this.config.tmuxSession.sendMessage(buildMessageText(handle, mergedContent));
    } catch (error) {
      await this.handleTurnError(error);
      throw error;
    }
  }

  /**
   * Complete the active turn from a Claude Code Stop hook.
   * @param lastAssistantMessage - Final assistant response text.
   */
  public async handleTurnFinished(lastAssistantMessage: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.isCompleted() || turn.acknowledgeInterrupt() || turn.shouldIgnoreStop()) return;
    if (this.suppressStopUntilPromptSubmit) return;

    await this.finalizeTurnOnce(turn, async () => {
      await turn.markStepFinished();

      const handle = turn.getMessageHandle();
      const result: MessageResult = {
        outcome: 'completed',
        result: { message: lastAssistantMessage },
      };

      try {
        await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);
        await this.config.emitTurnCompleted({ message: lastAssistantMessage });
      } finally {
        await this.finishActiveTurn(turn);
      }
    });
  }

  /**
   * Mark the active message acknowledged when Claude accepts the prompt.
   */
  public async handleUserPromptSubmit(): Promise<void> {
    this.suppressStopUntilPromptSubmit = false;
    this.activeTurn?.getMessageHandle().markAcknowledged(true);
    await this.activeTurn?.markStepStarted();
  }

  /**
   * Complete the active turn with an error.
   * @param errorLike - Error value that caused the turn to fail.
   */
  public async handleTurnError(errorLike: unknown): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.isCompleted()) return;

    const error = errorLike instanceof Error ? errorLike : new Error(String(errorLike));

    await this.finalizeTurnOnce(turn, async () => {
      const handle = turn.getMessageHandle();
      const result: MessageResult = { outcome: 'error', error };

      try {
        await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);
      } finally {
        this.clearAbandonedToolCalls(turn);
        await this.finishActiveTurn(turn);
      }
    });
  }

  /**
   * Run a turn's finalisation at most once, joining one already in flight.
   *
   * A turn is finalised by whichever cause reaches it first, and every later
   * cause observes that finalisation rather than performing a second one. This
   * is what makes the completion guard sufficient: the guard rejects callers
   * that arrive after the finalisation settled, and this joins the callers that
   * arrive while it is still running.
   * @param turn - Turn being finalised.
   * @param finalize - Finalisation to run when this caller arrived first.
   */
  private async finalizeTurnOnce(turn: TmuxConnectorTurn, finalize: () => Promise<void>): Promise<void> {
    const inFlight = this.activeTurnFinalization;
    if (inFlight?.turn === turn) {
      await inFlight.settled;
      return;
    }

    // `finalize()` runs synchronously up to its first await, so no other caller
    // can observe the gap between starting it and recording it.
    const settled = finalize();
    this.activeTurnFinalization = { turn, settled };
    try {
      await settled;
    } finally {
      if (this.activeTurnFinalization?.turn === turn) {
        this.activeTurnFinalization = undefined;
      }
    }
  }

  /**
   * Detach the active turn and reset Stop-suppression state exactly once.
   * @param turn - Turn being finalized.
   */
  private async finishActiveTurn(turn: TmuxConnectorTurn): Promise<void> {
    await turn.markTurnFinished();
    if (this.activeTurn === turn) {
      this.activeTurn = undefined;
    }
    this.suppressStopUntilPromptSubmit = false;
  }

  /**
   * Remove tool origins for a terminal error that cannot receive a post-tool hook.
   * @param turn - Terminal turn whose outstanding tool calls are abandoned.
   */
  private clearAbandonedToolCalls(turn: TmuxConnectorTurn): void {
    for (const [toolUseId, owner] of this.toolCallTurns) {
      if (owner === turn) this.toolCallTurns.delete(toolUseId);
    }
  }

  /**
   * Handle a PreToolUse hook event.
   * @param toolName - Name of the tool being invoked.
   * @param toolUseId - Claude Code-native tool use identifier.
   * @param toolInput - Raw tool input from Claude Code.
   */
  public async handlePreToolUse(toolName: string, toolUseId: string, toolInput: unknown): Promise<void> {
    const activeTurn = this.activeTurn;
    const messageId = activeTurn?.getMessageHandle()?.messageId;
    if (activeTurn === undefined || messageId === undefined) return;
    this.toolCallTurns.set(toolUseId, activeTurn);
    await activeTurn.markStepStarted();
    await this.config.emitToolUseStarted({ messageId, toolName, toolUseId, toolInput });
  }

  /**
   * Handle a PostToolUse hook event.
   * @param toolName - Name of the tool that completed.
   * @param toolUseId - Claude Code-native tool use identifier.
   * @param toolResult - Raw tool result or error from Claude Code.
   * @param isError - Whether Claude Code reported the tool call as failed.
   */
  public async handlePostToolUse(
    toolName: string,
    toolUseId: string,
    toolResult: unknown,
    isError?: boolean,
  ): Promise<void> {
    const originatingTurn = this.toolCallTurns.get(toolUseId);
    const messageId = originatingTurn?.getMessageHandle()?.messageId;
    if (originatingTurn === undefined || messageId === undefined) return;
    this.toolCallTurns.delete(toolUseId);
    await originatingTurn.markStepFinished();
    await this.config.emitToolUseFinished({ messageId, toolName, toolUseId, toolResult, isError });
  }
}
