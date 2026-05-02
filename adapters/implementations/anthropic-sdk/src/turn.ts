import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle } from '@makaio/ai-adapters-core';
import { AnthropicSdkConnectorSubjects, type AnthropicSdkConnectorBus } from './namespaces/index.js';
import type { StreamSessionTurnState } from '@makaio/ai-adapters-stream-session';

/**
 * Turn state machine for the Anthropic SDK adapter.
 *
 * Tracks state transitions for a single user message.
 * Unlike Claude Code, the Anthropic SDK adapter has no true pause/resume —
 * we abort and restart the request with merged content instead.
 *
 * State flow:
 * idle → turn_started → step_started → step_finished → turn_finished
 *
 * On immediate: abort current turn, merge content, start new turn.
 */
export class AnthropicSdkConnectorTurn extends ProceduralConnectorTurn<
  StreamSessionTurnState,
  AnthropicSdkConnectorBus
> {
  private abortController: AbortController;

  public constructor(
    bus: AnthropicSdkConnectorBus,
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
        turnSubjects: AnthropicSdkConnectorSubjects.turn,
      },
      'idle',
    );
    this.abortController = new AbortController();
  }

  /**
   * Get the AbortSignal for this turn.
   * Pass to the Anthropic client stream for cancellation.
   * @returns The abort signal for this turn
   */
  public getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Pause (abort) at next opportunity.
   * The Anthropic SDK adapter does not support true pause — caller restarts
   * with merged content when a replacement turn arrives.
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
