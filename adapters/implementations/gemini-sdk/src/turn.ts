import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle } from '@makaio/ai-adapters-core';
import { GeminiConnectorSubjects, type GeminiConnectorBus, type GeminiTurnState } from './namespaces/index.js';

/**
 * Turn state machine for Gemini SDK.
 *
 * Wraps SDK's Turn.run() generator and tracks state transitions.
 * Unlike Claude, Gemini has no true pause/resume - we abort and restart.
 *
 * State flow:
 * idle to turn_started to step_started to step_finished to turn_finished
 *
 * On immediate: abort current turn, merge content, start new turn.
 */
export class GeminiConnectorTurn extends ProceduralConnectorTurn<GeminiTurnState, GeminiConnectorBus> {
  private abortController: AbortController;

  public constructor(
    bus: GeminiConnectorBus,
    adapterId: string,
    adapterName: string,
    agentId: string,
    messageHandle: MessageHandle,
  ) {
    super(
      {
        bus,
        adapterId,
        adapterName,
        agentId,
        messageHandle,
        turnSubjects: GeminiConnectorSubjects.turn,
      },
      'idle',
    );
    this.abortController = new AbortController();
  }

  /**
   * Get the AbortSignal for this turn.
   * Pass to Turn.run() for cancellation.
   * @returns The AbortSignal for this turn
   */
  public getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Pause (abort) at next opportunity.
   * Gemini doesn't support true pause - we abort and caller restarts with merged content.
   * @returns Pause result indicating turn state
   */
  public override async pause(): ReturnType<ProceduralConnectorTurn['pause']> {
    const result = await super.pause();
    if (!result.turnEnded) {
      this.abortController.abort();
    }
    return result;
  }
}
