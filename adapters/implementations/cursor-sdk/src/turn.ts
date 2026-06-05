import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle, PauseResult } from '@makaio/ai-adapters-core';
import type { StreamSessionTurnState } from '@makaio/ai-adapters-stream-session';
import { CursorSdkSubjects } from './namespaces/index.js';
import type { CursorSdkBus } from './namespaces/index.js';

/** Callback invoked after a live turn accepts immediate-mode pause. */
type OnTurnPaused = (turn: CursorSdkTurn) => Promise<void> | void;

/**
 * Turn state machine for the Cursor SDK adapter.
 *
 * Cursor SDK manages its own agentic loop internally via `agent.send()`, so
 * this turn class has no AbortController — Cursor's run cancellation is the
 * cancellation primitive. The connector calls the run's abort mechanism in `pause()`.
 *
 * State flow (procedural — no true pause/resume):
 * idle → turn_started → step_started → step_finished → turn_finished
 *
 * On immediate: abort current turn, merge content, start new turn.
 */
export class CursorSdkTurn extends ProceduralConnectorTurn<StreamSessionTurnState, CursorSdkBus> {
  /**
   * Create a new Cursor SDK connector turn.
   * @param bus - Scoped bus for emitting turn lifecycle events.
   * @param adapterId - Unique adapter instance identifier.
   * @param adapterName - Adapter type name (e.g., 'cursor-sdk').
   * @param agentId - Agent identifier for event attribution.
   * @param messageHandle - Message handle for this turn.
   * @param onPaused - Optional callback used to cancel the Cursor run owned by this turn.
   */
  public constructor(
    bus: CursorSdkBus,
    adapterId: string,
    adapterName: string,
    agentId: string,
    messageHandle: MessageHandle,
    private readonly onPaused?: OnTurnPaused,
  ) {
    super(
      {
        bus,
        adapterId,
        adapterName,
        agentId,
        messageHandle,
        turnSubjects: CursorSdkSubjects.turn,
      },
      'idle',
    );
  }

  /**
   * Expose the message handle for this turn.
   *
   * `ProceduralConnectorTurn.activeMessageHandle` is protected. This public
   * accessor allows `CursorConnectorSession` to finalize the handle without
   * requiring `CursorConnectorSession` to extend the turn class.
   * @returns The message handle associated with this turn.
   */
  public get messageHandle(): MessageHandle {
    return this.activeMessageHandle;
  }

  /**
   * Pause this turn and cancel its matching Cursor run.
   * @returns Pause result from the procedural turn state machine.
   */
  public override async pause(): Promise<PauseResult<StreamSessionTurnState>> {
    const result = await super.pause();
    if (!result.turnEnded) {
      await this.onPaused?.(this);
    }
    return result;
  }
}
