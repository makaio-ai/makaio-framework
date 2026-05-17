/**
 * Turn state machine for the Claude Code tmux adapter.
 *
 * Extends ProceduralConnectorTurn with the tmux adapter's namespace subjects.
 * State transitions are driven by hook events:
 *
 * ```
 * idle → turn_started    (after send-keys + Enter)
 *      → step_started    (PreToolUse hook)
 *      → step_finished   (PostToolUse hook)
 *      → turn_finished   (Stop hook)
 * ```
 *
 * Interrupts are coordinated through ESC plus a short settling window:
 * `pause()` sends ESC, consumes a Stop hook as an early acknowledgement when
 * Claude emits one, and otherwise resolves after Claude has had time to return
 * to an input-safe prompt.
 * @packageDocumentation
 */

import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle, PauseResult } from '@makaio/ai-adapters-core';
import type { StreamSessionTurnState } from '@makaio/ai-adapters-stream-session';
import { ClaudeCodeTmuxConnectorSubjects, type ClaudeCodeTmuxConnectorBus } from './namespace/index.js';

/**
 * Turn implementation for the Claude Code tmux adapter.
 *
 * No additional SDK-specific behavior needed — the base class provides
 * start/markStepStarted/markStepFinished/markTurnFinished and
 * pause/resume/isPaused. The connector drives transitions by calling
 * these methods from hook event callbacks.
 */
export class TmuxConnectorTurn extends ProceduralConnectorTurn<StreamSessionTurnState, ClaudeCodeTmuxConnectorBus> {
  private interrupt: InterruptRequest | undefined;
  private interrupted = false;

  public constructor(
    bus: ClaudeCodeTmuxConnectorBus,
    adapterId: string,
    adapterName: string,
    agentId: string,
    messageHandle: MessageHandle,
    private readonly requestInterrupt: () => void,
    private readonly interruptSettleMs: number,
    private readonly onInterruptSettledWithoutStop: () => void,
  ) {
    super(
      {
        bus,
        adapterId,
        adapterName,
        agentId,
        messageHandle,
        turnSubjects: ClaudeCodeTmuxConnectorSubjects.turn,
      },
      'idle',
    );
  }

  /**
   * Interrupt a live Claude Code turn by sending ESC and waiting until Claude
   * is prompt-safe. Some Claude Code versions do not emit Stop for ESC, so the
   * settling timeout is part of the adapter contract rather than an error path.
   * @returns Pause result indicating whether the turn was already finished.
   */
  public override async pause(): Promise<PauseResult<StreamSessionTurnState>> {
    if (this.isCompleted()) {
      return { stateBeforePause: this.getState(), turnEnded: true };
    }
    if (this.interrupt) {
      return this.interrupt.promise;
    }

    const stateBeforePause = this.getState();
    this.aborted = true;
    this.interrupted = true;
    this.requestInterrupt();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveInterrupt: () => void = () => {};
    const promise = new Promise<PauseResult<StreamSessionTurnState>>((resolve) => {
      timeout = setTimeout(() => {
        this.interrupt = undefined;
        this.onInterruptSettledWithoutStop();
        resolve({ stateBeforePause, turnEnded: false });
      }, this.interruptSettleMs);

      resolveInterrupt = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.interrupt = undefined;
        resolve({ stateBeforePause, turnEnded: false });
      };
    });
    this.interrupt = { promise, resolve: resolveInterrupt };

    return promise;
  }

  /**
   * Resolve a pending interrupt request from the Stop hook.
   * @returns True when the Stop hook was consumed as interrupt confirmation.
   */
  public acknowledgeInterrupt(): boolean {
    const interrupt = this.interrupt;
    if (!interrupt) {
      return false;
    }
    interrupt.resolve();
    return true;
  }

  /**
   * Check whether a Stop hook for this turn should be ignored.
   * @returns True once this turn has been interrupted and superseded.
   */
  public shouldIgnoreStop(): boolean {
    return this.interrupted;
  }

  /**
   * Check whether this turn has been interrupted.
   * @returns True after ESC has been sent for this turn.
   */
  public override isPaused(): boolean {
    return this.interrupted;
  }

  /**
   * Immediate-mode replacement is supported by interrupting the live tmux turn.
   * @returns True while the turn is active and not already interrupting.
   */
  public override canAcceptImmediate(): boolean {
    return !this.isCompleted() && !this.interrupted && this.interrupt === undefined;
  }
}

interface InterruptRequest {
  readonly promise: Promise<PauseResult<StreamSessionTurnState>>;
  readonly resolve: () => void;
}
