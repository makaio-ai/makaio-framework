import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle } from '@makaio/ai-adapters-core';
import { OpenAINodeConnectorSubjects, type OpenAINodeConnectorBus } from './namespaces/index.js';
import type { StreamSessionTurnState as OpenAITurnState } from '@makaio/ai-adapters-stream-session';

/**
 * Turn state machine for OpenAI SDK.
 *
 * Tracks state transitions for a single user message.
 * Unlike Claude, OpenAI has no true pause/resume - we abort and restart.
 *
 * State flow:
 * idle to turn_started to step_started to step_finished to turn_finished
 *
 * On immediate: abort current turn, merge content, start new turn.
 */
export class OpenAIConnectorTurn extends ProceduralConnectorTurn<OpenAITurnState, OpenAINodeConnectorBus> {
  private abortController: AbortController;

  public constructor(
    bus: OpenAINodeConnectorBus,
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
        turnSubjects: OpenAINodeConnectorSubjects.turn,
      },
      'idle',
    );
    this.abortController = new AbortController();
  }

  /**
   * Get the AbortSignal for this turn.
   * Pass to OpenAI client for cancellation.
   * @returns The abort signal for this turn
   */
  public getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Pause (abort) at next opportunity.
   * OpenAI doesn't support true pause - we abort and caller restarts with
   * merged content.
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
