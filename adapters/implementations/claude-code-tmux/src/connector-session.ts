import {
  UserMessageQueue,
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

    await turn.markStepFinished();

    const handle = turn.getMessageHandle();
    const result: MessageResult = {
      outcome: 'completed',
      result: { message: lastAssistantMessage },
    };

    try {
      handle.markCompleted(result);
      this.config.onTurnComplete(handle, result);
      await this.config.emitTurnCompleted({ message: lastAssistantMessage });
    } finally {
      await this.finishActiveTurn(turn);
    }
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
    const handle = turn.getMessageHandle();
    const result: MessageResult = { outcome: 'error', error };

    try {
      handle.markCompleted(result);
      this.config.onTurnComplete(handle, result);
    } finally {
      await this.finishActiveTurn(turn);
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
   * Handle a PreToolUse hook event.
   * @param toolName - Name of the tool being invoked.
   * @param toolUseId - Claude Code-native tool use identifier.
   * @param toolInput - Raw tool input from Claude Code.
   */
  public async handlePreToolUse(toolName: string, toolUseId: string, toolInput: unknown): Promise<void> {
    await this.activeTurn?.markStepStarted();
    await this.config.emitToolUseStarted({ toolName, toolUseId, toolInput });
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
    await this.activeTurn?.markStepFinished();
    await this.config.emitToolUseFinished({ toolName, toolUseId, toolResult, isError });
  }
}
