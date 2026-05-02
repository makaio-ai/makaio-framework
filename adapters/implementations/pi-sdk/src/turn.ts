import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle } from '@makaio/ai-adapters-core';
import { PiSdkSubjects } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import type { StreamSessionTurnState } from '@makaio/ai-adapters-stream-session';

/**
 * Turn state machine for the Pi SDK adapter.
 *
 * Pi SDK manages its own agentic loop internally via `session.prompt()`, so
 * this turn class has no AbortController — Pi's `session.abort()` is the
 * cancellation primitive. The connector calls `session.abort()` in `pause()`.
 *
 * State flow (procedural — no true pause/resume):
 * idle → turn_started → step_started → step_finished → turn_finished
 *
 * On immediate: abort current turn, merge content, start new turn via `session.abort()`.
 * @typeParam TState - Turn state type (defaults to StreamSessionTurnState)
 * @typeParam TBus - Scoped bus type for the Pi SDK adapter
 */
export class PiConnectorTurn extends ProceduralConnectorTurn<StreamSessionTurnState, PiSdkBus> {
  /**
   * Create a new Pi SDK connector turn.
   * @param bus - Scoped bus for emitting turn lifecycle events
   * @param adapterId - Unique adapter instance identifier
   * @param adapterName - Adapter type name (e.g., 'pi-sdk')
   * @param agentId - Agent identifier for event attribution
   * @param messageHandle - Message handle for this turn
   */
  public constructor(
    bus: PiSdkBus,
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
        turnSubjects: PiSdkSubjects.turn,
      },
      'idle',
    );
  }

  /**
   * Expose the message handle for this turn.
   *
   * `ProceduralConnectorTurn.activeMessageHandle` is protected. This public
   * accessor allows `PiConnectorSession` to finalize the handle without requiring
   * `PiConnectorSession` to extend the turn class.
   * @returns The message handle associated with this turn
   */
  public get messageHandle(): MessageHandle {
    return this.activeMessageHandle;
  }
}
