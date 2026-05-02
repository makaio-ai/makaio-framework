import { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { MessageHandle } from '@makaio/ai-adapters-core';
import {
  GitHubCopilotConnectorSubjects,
  type GitHubCopilotConnectorBus,
  type CopilotTurnState,
  type CopilotSessionEvent,
} from './namespaces/index.js';

/**
 * Turn state machine for GitHub Copilot SDK.
 *
 * Tracks state transitions for a single user message:
 * - Maps SDK events to state transitions
 * - Tracks paused state for immediate mode
 * - No true pause/resume - SDK handles abort via mode:'immediate'
 *
 * State flow:
 * idle to turn_started to step_started to step_finished to turn_finished
 *
 * On immediate: pause old turn, send with mode:'immediate', SDK handles abort.
 */
export class CopilotConnectorTurn extends ProceduralConnectorTurn<CopilotTurnState, GitHubCopilotConnectorBus> {
  public constructor(
    bus: GitHubCopilotConnectorBus,
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
        turnSubjects: GitHubCopilotConnectorSubjects.turn,
      },
      'idle',
    );
  }

  /**
   * Handle SDK event and update turn state.
   * Called by Session's event handler.
   * @param event - Copilot SDK event
   */
  public async handleSdkEvent(event: CopilotSessionEvent): Promise<void> {
    if (this.aborted) return;

    switch (event.type) {
      case 'user.message':
        // Already in turn_started from start()
        break;
      case 'assistant.turn_start':
        // Don't transition backwards from turn_finished — multi-turn SDK events
        // after turn_end are handled by session.idle, not by reopening the state machine.
        // Without this guard the connector re-enters step_started and never reaches idle.
        if (this.state !== 'turn_finished') {
          await this.transitionTo('step_started');
        }
        break;
      case 'assistant.message':
        await this.transitionTo('step_finished');
        break;
      case 'assistant.turn_end':
        await this.transitionTo('turn_finished');
        break;
    }
  }

  /**
   * Mark turn as finished.
   * Called explicitly when SDK doesn't emit assistant.turn_end, or on session.idle
   * to ensure connector transitions to idle state.
   * @param force - If true, emit turn_finished event even if already in that state
   */
  public override async markTurnFinished(force = false): Promise<void> {
    if (this.state !== 'turn_finished') {
      await this.transitionTo('turn_finished');
    } else if (force) {
      // Already in turn_finished, but force re-emit for connector to see message is processed
      await this.emitStateChange('turn_finished', 'turn_finished');
    }
  }
}
