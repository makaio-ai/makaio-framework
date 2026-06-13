import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type TurnInitiator } from '@makaio/contracts';
import { TurnStorageSubjects } from './turns/index.js';
import { Turn } from './entities/turn.js';
import { TurnUsageAccumulator, type AgentUsageEvent } from './turn-usage-accumulator.js';
import { findTurnByAgent } from './session-orchestrator-helpers.js';

/**
 * Result of a completed turn.
 */
export interface TurnCompletionResult {
  /** Whether all agents completed successfully. */
  success: boolean;
  /** Error messages from agents that failed. */
  errors: string[];
}

/**
 * Callback invoked when a turn completes (all agents finished).
 * @param turn - The completed turn
 * @param result - Success/error status with error messages
 */
export type TurnCompleteCallback = (turn: Turn, result: TurnCompletionResult) => Promise<void>;

/**
 * Composable turn lifecycle manager.
 *
 * Owns all stateful turn tracking: active turns, usage accumulation,
 * completion guards, and buffered-usage-during-completion. Both the
 * framework `SessionOrchestrator` and host-provided orchestrators create their
 * own instance.
 *
 * Storage calls use `bus.requestOptional` so the manager degrades
 * gracefully in ephemeral mode (no storage handlers registered). When
 * `TurnStorageSubjects.create` is unhandled, synthetic IDs are generated
 * locally. When `TurnStorageSubjects.complete` is unhandled, the turn is
 * still cleared from memory and `session.turn.completed` is emitted.
 */
export class SessionTurnManager {
  /** Active turns keyed by sessionId (one turn per session). */
  private readonly activeTurns = new Map<string, Turn>();

  /** Per-session usage accumulators, parallel to activeTurns. */
  private readonly usageAccumulators = new Map<string, TurnUsageAccumulator>();

  /** Sessions currently persisting turn completion (prevents concurrent writes). */
  private readonly completingSessions = new Set<string>();

  /** Usage events received while completion persistence is in-flight. */
  private readonly bufferedUsageDuringCompletion = new Map<string, AgentUsageEvent[]>();

  /**
   * Synthetic turn number counters for ephemeral mode (no storage handlers).
   * Keyed by sessionId, incremented on each turn creation.
   *
   * Intentionally never pruned: turn numbers must be monotonically increasing
   * across all turns in a session. Pruning after a turn completes would reset
   * the counter and cause duplicate turn numbers if the session continues.
   */
  private readonly syntheticTurnCounters = new Map<string, number>();

  /** Bus subscription cleanup functions. */
  private readonly cleanups: Array<() => void> = [];

  /**
   * @param bus - Event bus used for storage RPCs and event emission
   */
  public constructor(private readonly bus: IMakaioBus) {}

  // ---------------------------------------------------------------------------
  // Turn creation
  // ---------------------------------------------------------------------------

  /**
   * Create a new turn, tracking it as active.
   *
   * Calls `TurnStorageSubjects.create` via `requestOptional`. If no storage
   * handler is registered (ephemeral mode), generates a synthetic UUID turn ID
   * and a per-session incrementing turn number.
   * @param sessionId - Session the turn belongs to
   * @param agentIds - Agents participating in this turn
   * @param initiator - Turn origin metadata (user, plugin, system)
   * @param turnId - Optional pre-assigned turn ID (passed through to storage)
   * @returns The newly created and activated Turn entity
   */
  public async createTurn(
    sessionId: string,
    agentIds: string[],
    initiator?: TurnInitiator,
    turnId?: string,
  ): Promise<Turn> {
    const createResult = await this.bus.requestOptional(TurnStorageSubjects.create, {
      sessionId,
      ...(turnId !== undefined && { turnId }),
      ...(initiator !== undefined && { initiator }),
    });

    let resolvedTurnId: string;
    let resolvedTurnNumber: number;

    if (createResult.handled) {
      resolvedTurnId = createResult.data.turn.turnId;
      resolvedTurnNumber = createResult.data.turn.turnNumber;
    } else {
      // Ephemeral mode: generate synthetic IDs locally.
      resolvedTurnId = turnId ?? crypto.randomUUID();
      const nextCounter = (this.syntheticTurnCounters.get(sessionId) ?? 0) + 1;
      this.syntheticTurnCounters.set(sessionId, nextCounter);
      resolvedTurnNumber = nextCounter;
    }

    const turn = new Turn({
      sessionId,
      agentIds,
      turnId: resolvedTurnId,
      turnNumber: resolvedTurnNumber,
      initiator,
    });

    this.activeTurns.set(sessionId, turn);
    this.usageAccumulators.set(sessionId, new TurnUsageAccumulator());

    return turn;
  }

  // ---------------------------------------------------------------------------
  // Completion handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register bus listeners for `agent.usage` and `agent.complete` events.
   *
   * Must be called once during initialisation. The `onTurnComplete` callback
   * is invoked when all agents in a turn have finished (success or error);
   * typically the orchestrator passes its own `completeTurn` method.
   * @param onTurnComplete - Callback invoked when all agents in a turn finish
   */
  public registerCompletionHandlers(onTurnComplete: TurnCompleteCallback): void {
    // Accumulate usage events into the active turn's accumulator.
    // agent.usage is fire-and-forget, so we use bus.on (not request).
    this.cleanups.push(
      this.bus.on(
        AgentSubjects.usage,
        /**
         * Accumulate token usage for the active turn associated with this event.
         *
         * Correlation is via `turnId` to avoid misattributing late usage events.
         * @param ctx - Event context containing agent identity and token counts
         */
        (ctx) => {
          const { agentId, turnId: usageTurnId, inputTokens, outputTokens } = ctx.payload;

          if (!usageTurnId) {
            console.warn(`[SessionTurnManager] Dropping usage event without turnId (agentId=${agentId}).`);
            return;
          }

          const turn = this.findActiveTurnByTurnId(usageTurnId);
          if (!turn) {
            console.warn(`[SessionTurnManager] Dropping usage for inactive turn ${usageTurnId} (agentId=${agentId}).`);
            return;
          }
          if (!turn.hasAgent(agentId)) {
            console.warn(
              `[SessionTurnManager] Dropping usage for turn ${usageTurnId}: agent ${agentId} is not part of the turn.`,
            );
            return;
          }

          if (this.completingSessions.has(turn.sessionId)) {
            this.bufferUsageDuringCompletion(turn.sessionId, { agentId, inputTokens, outputTokens });
            return;
          }

          this.usageAccumulators.get(turn.sessionId)?.add({ agentId, inputTokens, outputTokens });
        },
      ),
    );

    // Handle agent.complete (all terminal outcomes including errors).
    this.cleanups.push(
      this.bus.on(
        AgentSubjects.complete,
        /**
         * Handle terminal completion events for an agent in a turn.
         * @param ctx - Event context containing agentId, outcome, and optional error
         */
        async (ctx) => {
          const { agentId, outcome, error } = ctx.payload;
          // All non-error terminal outcomes count as successful completion at the
          // orchestration level. This includes omitted/legacy outcome values.
          const success = outcome !== 'error';
          await this.handleAgentCompletion(agentId, success, success ? undefined : error, onTurnComplete);
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Turn completion
  // ---------------------------------------------------------------------------

  /**
   * Complete a turn: persist via storage, emit `session.turn.completed`, clear state.
   *
   * A concurrent-completion guard prevents duplicate writes when two agent
   * completions race. The second call is a no-op.
   *
   * Usage is snapshotted before the storage call. Any usage events that arrive
   * while persistence is in-flight are buffered and merged into a second
   * `TurnStorageSubjects.complete` call. State is cleared only after durable
   * persistence succeeds; if persistence fails, the state remains intact so
   * completion can be retried.
   * @param turn - The turn to complete
   * @param result - Turn result (success status and error messages)
   */
  public async completeTurn(turn: Turn, result: TurnCompletionResult): Promise<void> {
    if (this.completingSessions.has(turn.sessionId)) {
      return;
    }
    this.completingSessions.add(turn.sessionId);

    const usageAccumulator = this.usageAccumulators.get(turn.sessionId);
    const usage = usageAccumulator?.snapshot();

    try {
      await this.bus.requestOptional(TurnStorageSubjects.complete, {
        turnId: turn.turnId,
        status: result.success ? 'completed' : 'error',
        error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
        ...(usage !== undefined && { usage }),
      });

      const bufferedUsage = this.bufferedUsageDuringCompletion.get(turn.sessionId) ?? [];
      if (bufferedUsage.length > 0) {
        for (const usageEvent of bufferedUsage) {
          usageAccumulator?.add(usageEvent);
        }
        this.bufferedUsageDuringCompletion.delete(turn.sessionId);

        const mergedUsage = usageAccumulator?.snapshot();
        await this.bus.requestOptional(TurnStorageSubjects.complete, {
          turnId: turn.turnId,
          status: result.success ? 'completed' : 'error',
          error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
          ...(mergedUsage !== undefined && { usage: mergedUsage }),
        });
      }
    } catch (error) {
      // Keep active turn + accumulator state intact so completion can be retried.
      // Remove the completing guard so a retry can re-enter.
      this.completingSessions.delete(turn.sessionId);
      console.error(`[SessionTurnManager] Failed to persist completion for turn ${turn.turnId}:`, error);
      throw error;
    }

    // Clear in-memory turn state only after durable completion succeeds.
    // The completing guard is cleared last so that any late usage events
    // arriving after state cleanup are not buffered into a now-gone accumulator.
    usageAccumulator?.clear();
    this.activeTurns.delete(turn.sessionId);
    this.usageAccumulators.delete(turn.sessionId);
    this.completingSessions.delete(turn.sessionId);

    await this.bus.emit(SessionSubjects.turn.completed, {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      success: result.success,
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
      initiator: turn.initiator,
    });
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get the active turn for a session, if any.
   * @param sessionId - Session identifier
   * @returns Active turn, or `undefined` if no turn is in progress
   */
  public getActiveTurn(sessionId: string): Turn | undefined {
    return this.activeTurns.get(sessionId);
  }

  /**
   * Expose the active turns map for handlers that need direct access.
   *
   * Used by `registerAttachHandler` which tracks turns started via
   * `session.agent.attach` (with an `initialMessage`) in the shared map so
   * that the completion handler can detect when the attached turn finishes.
   * @returns Reference to the internal active turns map
   */
  public getActiveTurnsMap(): Map<string, Turn> {
    return this.activeTurns;
  }

  /**
   * Find an active turn by turn ID (scans all sessions).
   *
   * Used to correlate `agent.usage` events that carry a `turnId` rather
   * than a `sessionId`.
   * @param turnId - Turn identifier from an agent event payload
   * @returns Matching active turn, or `undefined` if not found
   */
  public findActiveTurnByTurnId(turnId: string): Turn | undefined {
    for (const turn of this.activeTurns.values()) {
      if (turn.turnId === turnId) {
        return turn;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Cancel all bus subscriptions and clear all in-memory state.
   *
   * Call when the owning orchestrator is destroyed.
   */
  public destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.activeTurns.clear();
    this.usageAccumulators.clear();
    this.completingSessions.clear();
    this.bufferedUsageDuringCompletion.clear();
    this.syntheticTurnCounters.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle an agent completing (success or error).
   *
   * Marks the agent on the turn, emits `user_message.completed` for each
   * message in the turn, then calls `onTurnComplete` when all agents are done.
   * @param agentId - The agent that completed
   * @param success - Whether the agent completed successfully
   * @param error - Error message if the agent failed
   * @param onTurnComplete - Callback to invoke when the turn is complete
   */
  private async handleAgentCompletion(
    agentId: string,
    success: boolean,
    error: string | undefined,
    onTurnComplete: TurnCompleteCallback,
  ): Promise<void> {
    const turn = findTurnByAgent(this.activeTurns, agentId);
    if (!turn) return; // Agent not part of any active turn.

    const stateChange = success
      ? turn.markAgentCompleted(agentId)
      : turn.markAgentErrored(agentId, error ?? 'Unknown error');

    // Emit user_message.completed for all messages this agent was processing.
    for (const messageId of turn.messageIds) {
      await this.bus.emit(SessionSubjects.user_message.completed, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        messageId,
        agentId,
        outcome: success ? 'completed' : 'error',
        error,
      });
    }

    if (stateChange.turnComplete) {
      await onTurnComplete(turn, stateChange.result);
    }
  }

  /**
   * Buffer a usage event that arrived while turn completion persistence is in-flight.
   * @param sessionId - Session whose turn is currently completing
   * @param usageEvent - Usage event to defer until after persistence
   */
  private bufferUsageDuringCompletion(sessionId: string, usageEvent: AgentUsageEvent): void {
    const buffered = this.bufferedUsageDuringCompletion.get(sessionId) ?? [];
    buffered.push(usageEvent);
    this.bufferedUsageDuringCompletion.set(sessionId, buffered);
  }
}
