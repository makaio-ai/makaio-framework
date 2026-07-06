import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type TurnInitiator, type TurnUsage } from '@makaio/contracts';
import { TurnStorageSubjects } from './turns/index.js';
import { MessageStorageSubjects } from './messages/namespace.js';
import { Turn } from './entities/turn.js';
import { TurnUsageAccumulator, type AgentUsageEvent } from './turn-usage-accumulator.js';
import { findTurnByAgent } from './session-orchestrator-helpers.js';
import { appendSessionLifecycleEvent } from './session-lifecycle-events.js';

/**
 * Upper bound (ms) for the persist-before-emit barrier in {@link SessionTurnManager.completeTurn}.
 *
 * The barrier waits for `storage:message.stored` confirmations of the turn's
 * assistant messages before emitting `session.turn.completed`. The timeout is
 * mandatory — the barrier must never hang: SessionBridge legitimately persists
 * nothing when an agent produced zero blocks and no error, and it swallows
 * write errors, so a `storage:message.stored` event may never fire for an
 * agent. After this bound the event is emitted regardless.
 */
export const TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS = 1500;

/**
 * Maximum number of turns tracked in the assistant-persistence counter.
 *
 * Bounds memory for `storage:message.stored` events that arrive for turns this
 * manager never completes (e.g. import-path persistence): the oldest entry is
 * evicted FIFO once the cap is reached.
 */
const ASSISTANT_PERSISTENCE_COUNTER_CAP = 1024;

/** Durable error code for a new turn whose first user message could not be stored. */
export const USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR = 'user-message-persistence-failed';

/**
 * Pending barrier waiter for a completing turn.
 */
interface AssistantPersistenceWaiter {
  /** Number of stored assistant messages that resolves the barrier. */
  expected: number;
  /** Settle the barrier: clears the timeout, removes the waiter, resolves the promise. */
  settle: () => void;
}

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
 *
 * **Persist-before-emit barrier:** `session.turn.completed` promises the
 * four-point consumer contract, including messages being queryable via
 * `storage:message.getByTurn`. Message persistence (SessionBridge) and turn
 * completion both react to `agent.complete`, and the bus runs event handlers
 * in parallel — so before emitting, `completeTurn` awaits
 * `storage:message.stored` confirmations for the turn's assistant messages
 * (bus-mediated: the manager holds no reference to SessionBridge). The wait
 * is bounded by {@link TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS} and skipped
 * entirely in ephemeral mode.
 */
export class SessionTurnManager {
  /** Active turns keyed by sessionId (one turn per session). */
  private readonly activeTurns = new Map<string, Turn>();

  /** Per-turn usage accumulators, keyed by turnId. */
  private readonly usageAccumulators = new Map<string, TurnUsageAccumulator>();

  /** Turns currently persisting completion (prevents concurrent writes). */
  private readonly completingTurnIds = new Set<string>();

  /** Completing turns retained for usage correlation after active routing is cleared. */
  private readonly completingTurns = new Map<string, Turn>();

  /** Pending terminal completions keyed by turnId; value records whether turn storage handled the transition. */
  private readonly pendingTerminalCompletions = new Map<string, boolean>();

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

  /**
   * Stored assistant messages per turnId, counted from `storage:message.stored`.
   *
   * Populated continuously (from construction) so messages persisted before
   * `completeTurn` runs are counted. FIFO-capped at
   * {@link ASSISTANT_PERSISTENCE_COUNTER_CAP}; a turn's entry is deleted when
   * its completion emits, so late `stored` events for an already-emitted turn
   * merely recreate a short-lived entry that the cap eventually evicts.
   */
  private readonly assistantStoredCounts = new Map<string, number>();

  /** Pending persist-before-emit barrier waiters, keyed by turnId. */
  private readonly assistantPersistenceWaiters = new Map<string, AssistantPersistenceWaiter>();

  /** Bus subscription cleanup functions. */
  private readonly cleanups: Array<() => void> = [];

  /**
   * @param bus - Event bus used for storage RPCs and event emission
   */
  public constructor(private readonly bus: IMakaioBus) {
    this.registerAssistantPersistenceCounter();
  }

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
    this.usageAccumulators.set(turn.turnId, new TurnUsageAccumulator());

    return turn;
  }

  /**
   * Discard active in-memory state for a turn that failed before routing began.
   *
   * Use when no durable turn row needs a terminal status transition.
   * @param turn - Newly created active turn to discard
   */
  public discardActiveTurn(turn: Turn): void {
    if (!this.clearActiveRoutingTurn(turn)) {
      return;
    }
    this.usageAccumulators.delete(turn.turnId);
    this.assistantStoredCounts.delete(turn.turnId);
  }

  /**
   * Mark an unclaimed newly created turn as failed and discard its active in-memory state.
   *
   * This preserves the durable turn lifecycle invariant when setup fails after
   * `storage:turn.create` has already assigned a turn number.
   * @param turn - Newly created active turn whose setup failed before any message claimed it
   * @param error - Durable error code to store on the terminal turn
   */
  public async failActiveTurnSetup(turn: Turn, error: string): Promise<void> {
    const active = this.activeTurns.get(turn.sessionId);
    if (active?.turnId !== turn.turnId) {
      return;
    }
    if (turn.messageIds.length > 0 || turn.hasPendingMessageAppends) {
      return;
    }

    try {
      await this.bus.requestOptional(TurnStorageSubjects.complete, {
        turnId: turn.turnId,
        status: 'error',
        expectedStatus: 'active',
        error,
      });
    } catch (completionError) {
      console.error(`[SessionTurnManager] Failed to mark setup-failed turn ${turn.turnId} as error:`, completionError);
    }

    this.discardActiveTurn(turn);
  }

  /**
   * Remove a turn from the active routing index when it is no longer routable.
   * @param turn - Turn to remove when it still owns the session slot
   * @returns Whether the turn owned and cleared the active routing slot
   */
  private clearActiveRoutingTurn(turn: Turn): boolean {
    const active = this.activeTurns.get(turn.sessionId);
    if (active?.turnId !== turn.turnId) {
      return false;
    }
    this.activeTurns.delete(turn.sessionId);
    return true;
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

          const turn = this.findTurnForUsage(usageTurnId);
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

          if (this.completingTurnIds.has(turn.turnId)) {
            this.bufferUsageDuringCompletion(turn.turnId, { agentId, inputTokens, outputTokens });
            return;
          }

          this.usageAccumulators.get(turn.turnId)?.add({ agentId, inputTokens, outputTokens });
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
          const { agentId, outcome, error, turnId } = ctx.payload;
          // All non-error terminal outcomes count as successful completion at the
          // orchestration level. This includes omitted/legacy outcome values.
          const success = outcome !== 'error';
          await this.handleAgentCompletion(agentId, success, success ? undefined : error, onTurnComplete, turnId);
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
   *
   * Before the event fires, the persist-before-emit barrier waits for the
   * turn's assistant messages to be stored (see class docs), then a
   * `turn.completed` lifecycle row is appended to `session_events` — so both
   * message rows and the lifecycle row are durable before consumers observe
   * `session.turn.completed`.
   * @param turn - The turn to complete
   * @param result - Turn result (success status and error messages)
   */
  public async completeTurn(turn: Turn, result: TurnCompletionResult): Promise<void> {
    if (this.completingTurnIds.has(turn.turnId)) {
      return;
    }
    this.completingTurnIds.add(turn.turnId);
    this.completingTurns.set(turn.turnId, turn);

    const usageAccumulator = this.usageAccumulators.get(turn.turnId);
    let completedUsage = usageAccumulator?.snapshot();

    let turnStorageHandled = this.pendingTerminalCompletions.get(turn.turnId) ?? false;
    try {
      if (!this.pendingTerminalCompletions.has(turn.turnId)) {
        const completion = await this.persistTurnCompletion(turn, result, completedUsage, 'active');
        turnStorageHandled = completion.handled;
        if (!completion.transitioned) {
          this.clearActiveRoutingTurn(turn);
          this.clearCompletionState(turn, usageAccumulator);
          return;
        }
        this.pendingTerminalCompletions.set(turn.turnId, turnStorageHandled);
        completedUsage = await this.flushBufferedUsageDuringCompletion(turn, result, usageAccumulator, completedUsage);
      }
    } catch (error) {
      // Keep active turn + accumulator state intact so completion can be retried.
      // Remove the completing guard so a retry can re-enter.
      this.completingTurnIds.delete(turn.turnId);
      this.completingTurns.delete(turn.turnId);
      console.error(`[SessionTurnManager] Failed to persist completion for turn ${turn.turnId}:`, error);
      throw error;
    }

    // At this point the durable turn row is terminal. It must no longer be
    // returned as active routing state while assistant-message persistence and
    // lifecycle emission finish.
    this.clearActiveRoutingTurn(turn);
    let lifecycleAppended = false;
    try {
      // Persist-before-emit barrier. Skipped entirely in ephemeral mode: turn
      // and message storage are registered together (sessionStoragePackage), so
      // unhandled turn storage implies unhandled message storage and there is
      // nothing to wait for (zero added latency).
      if (turnStorageHandled) {
        await this.awaitAssistantPersistence(turn);
      }
      completedUsage = await this.flushBufferedUsageDuringCompletion(turn, result, usageAccumulator, completedUsage);
      const completedPayload = {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        success: result.success,
        error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
        ...(completedUsage !== undefined && { usage: completedUsage }),
        initiator: turn.initiator,
        ingestionMarker: 'live' as const,
      };

      // Lifecycle row persists before consumers see the event (persist-before-emit).
      await appendSessionLifecycleEvent(this.bus, {
        type: 'turn.completed',
        sessionId: turn.sessionId,
        eventId: `turn.completed:${turn.turnId}`,
        payload: completedPayload,
      });
      lifecycleAppended = true;

      await this.bus.emit(SessionSubjects.turn.completed, completedPayload);
    } catch (error) {
      if (lifecycleAppended) {
        this.clearCompletionState(turn, usageAccumulator);
      } else {
        this.completingTurnIds.delete(turn.turnId);
      }
      throw error;
    }

    // Clear remaining in-memory completion state only after durable completion
    // and emission succeed.
    // The completing guard is cleared last so that late usage events after state
    // cleanup are not buffered into a now-gone accumulator.
    this.clearCompletionState(turn, usageAccumulator);
  }

  /**
   * Clear in-memory state retained only while a turn completion is in progress.
   * @param turn - Turn whose completion state should be removed
   * @param usageAccumulator - Optional accumulator retained for late usage merges
   */
  private clearCompletionState(turn: Turn, usageAccumulator: TurnUsageAccumulator | undefined): void {
    usageAccumulator?.clear();
    this.usageAccumulators.delete(turn.turnId);
    this.bufferedUsageDuringCompletion.delete(turn.turnId);
    this.assistantStoredCounts.delete(turn.turnId);
    this.completingTurns.delete(turn.turnId);
    this.completingTurnIds.delete(turn.turnId);
    this.pendingTerminalCompletions.delete(turn.turnId);
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
    this.completingTurnIds.clear();
    this.completingTurns.clear();
    this.pendingTerminalCompletions.clear();
    this.bufferedUsageDuringCompletion.clear();
    this.syntheticTurnCounters.clear();
    // Settle pending barrier waiters so in-flight completeTurn calls resolve.
    for (const waiter of [...this.assistantPersistenceWaiters.values()]) {
      waiter.settle();
    }
    this.assistantPersistenceWaiters.clear();
    this.assistantStoredCounts.clear();
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
   * @param completionTurnId - Turn identifier supplied by the adapter completion event
   */
  private async handleAgentCompletion(
    agentId: string,
    success: boolean,
    error: string | undefined,
    onTurnComplete: TurnCompleteCallback,
    completionTurnId: string | undefined,
  ): Promise<void> {
    const turn = completionTurnId
      ? this.findTurnForCompletion(completionTurnId)
      : this.findTurnForUncorrelatedCompletion(agentId);
    if (!turn) return; // Agent not part of any active turn.
    if (!turn.hasAgent(agentId)) return;
    if (this.hasTerminalOutcome(turn, agentId)) return;

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
   * @param turnId - Turn whose completion is currently being persisted
   * @param usageEvent - Usage event to defer until after persistence
   */
  private bufferUsageDuringCompletion(turnId: string, usageEvent: AgentUsageEvent): void {
    const buffered = this.bufferedUsageDuringCompletion.get(turnId) ?? [];
    buffered.push(usageEvent);
    this.bufferedUsageDuringCompletion.set(turnId, buffered);
  }

  /**
   * Find a turn that may still accept usage by turnId.
   * @param turnId - Turn identifier from an agent usage event
   * @returns Active or completing turn, if usage can still be recorded
   */
  private findTurnForUsage(turnId: string): Turn | undefined {
    return this.findActiveTurnByTurnId(turnId) ?? this.completingTurns.get(turnId);
  }

  /**
   * Find a turn that may still accept agent completion by turnId.
   * @param turnId - Turn identifier from an agent completion event
   * @returns Active or completing turn, if completion can still be correlated
   */
  private findTurnForCompletion(turnId: string): Turn | undefined {
    return this.findActiveTurnByTurnId(turnId) ?? this.completingTurns.get(turnId);
  }

  /**
   * Find the active turn for a legacy completion event without turnId.
   * @param agentId - Agent ID from the completion event.
   * @returns Active turn to mutate, or undefined when the event is ambiguous.
   */
  private findTurnForUncorrelatedCompletion(agentId: string): Turn | undefined {
    for (const turn of this.completingTurns.values()) {
      if (turn.hasAgent(agentId)) {
        // Managed agents emit turnId on terminal events. If a legacy event lacks
        // turnId while an older turn for the same agent is still completing, the
        // event cannot be attributed safely to the new active turn.
        return undefined;
      }
    }
    return findTurnByAgent(this.activeTurns, agentId);
  }

  /**
   * Check whether a terminal outcome has already been recorded for an agent.
   * @param turn - Turn being completed.
   * @param agentId - Agent ID from the terminal event.
   * @returns Whether the agent already has a terminal outcome on the turn.
   */
  private hasTerminalOutcome(turn: Turn, agentId: string): boolean {
    return turn.completedAgents.has(agentId) || turn.erroredAgents.has(agentId);
  }

  /**
   * Persist a turn's terminal status and optional usage snapshot.
   * @param turn - Turn being completed
   * @param result - Completion result to persist
   * @param usage - Usage snapshot to include, when available
   * @param expectedStatus - Optional status guard for the first terminal transition
   * @returns Whether turn storage handled the request and terminalized the turn
   */
  private async persistTurnCompletion(
    turn: Turn,
    result: TurnCompletionResult,
    usage: TurnUsage | undefined,
    expectedStatus?: 'active',
  ): Promise<{ handled: boolean; transitioned: boolean }> {
    const completeResult = await this.bus.requestOptional(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: result.success ? 'completed' : 'error',
      ...(expectedStatus !== undefined && { expectedStatus }),
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
      ...(usage !== undefined && { usage }),
    });
    return {
      handled: completeResult.handled,
      transitioned: completeResult.handled ? completeResult.data.transitioned : true,
    };
  }

  /**
   * Merge buffered usage and persist the updated snapshot.
   * @param turn - Turn whose buffered usage should be merged
   * @param result - Completion result for the turn
   * @param usageAccumulator - Usage accumulator captured by the completing turn
   * @param currentUsage - Current completed usage snapshot
   * @returns Updated usage snapshot
   */
  private async flushBufferedUsageDuringCompletion(
    turn: Turn,
    result: TurnCompletionResult,
    usageAccumulator: TurnUsageAccumulator | undefined,
    currentUsage: TurnUsage | undefined,
  ): Promise<TurnUsage | undefined> {
    const bufferedUsage = this.bufferedUsageDuringCompletion.get(turn.turnId) ?? [];
    if (bufferedUsage.length === 0) {
      return currentUsage;
    }

    for (const usageEvent of bufferedUsage) {
      usageAccumulator?.add(usageEvent);
    }
    this.bufferedUsageDuringCompletion.delete(turn.turnId);

    const mergedUsage = usageAccumulator?.snapshot() ?? currentUsage;
    try {
      await this.persistTurnCompletion(turn, result, mergedUsage);
    } catch (error) {
      console.warn(`[SessionTurnManager] Failed to persist buffered usage for turn ${turn.turnId}:`, error);
    }
    return mergedUsage;
  }

  /**
   * Subscribe to `storage:message.stored` and count stored assistant messages
   * per turnId, resolving any pending barrier waiter on each increment.
   *
   * Registered from the constructor (not `registerCompletionHandlers`) so the
   * barrier also works for callers that drive `completeTurn` directly without
   * wiring the agent-event handlers.
   */
  private registerAssistantPersistenceCounter(): void {
    this.cleanups.push(
      this.bus.on(
        MessageStorageSubjects.stored,
        /**
         * Count a persisted assistant message for its turn.
         * @param ctx - Event context carrying the fully persisted message
         */
        (ctx) => {
          const { message } = ctx.payload;
          if (message.role !== 'assistant' || !message.turnId) {
            return;
          }
          const turnId = message.turnId;
          if (
            !this.assistantStoredCounts.has(turnId) &&
            this.assistantStoredCounts.size >= ASSISTANT_PERSISTENCE_COUNTER_CAP
          ) {
            // FIFO eviction: Map iteration order is insertion order.
            const oldest = this.assistantStoredCounts.keys().next().value;
            if (oldest !== undefined) {
              this.assistantStoredCounts.delete(oldest);
            }
          }
          const count = (this.assistantStoredCounts.get(turnId) ?? 0) + 1;
          this.assistantStoredCounts.set(turnId, count);

          const waiter = this.assistantPersistenceWaiters.get(turnId);
          if (waiter && count >= waiter.expected) {
            waiter.settle();
          }
        },
      ),
    );
  }

  /**
   * Persist-before-emit barrier: wait until the turn's assistant messages are
   * durably stored (one per agent) or the bounded timeout elapses.
   *
   * Resolution paths, in order:
   * 1. The continuous `storage:message.stored` counter already reached the
   *    expected count (messages stored before `completeTurn` ran).
   * 2. `storage:message.getByTurn` is unhandled — no message storage exists,
   *    nothing can be waited for (skip).
   * 3. A queryable-state probe already shows the expected assistant messages
   *    (covers messages persisted before this manager was constructed).
   * 4. A waiter resolved by the counter reaching the expected count, bounded
   *    by {@link TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS} — the timeout is
   *    mandatory because SessionBridge persists nothing for agents with zero
   *    blocks and no error, and swallows write errors.
   * @param turn - The completing turn (expected count = its agent count)
   */
  private async awaitAssistantPersistence(turn: Turn): Promise<void> {
    const expected = turn.agentIds.length;
    if (expected <= 0) {
      return;
    }
    if ((this.assistantStoredCounts.get(turn.turnId) ?? 0) >= expected) {
      return;
    }

    const probe = await this.bus.requestOptional(MessageStorageSubjects.getByTurn, { turnId: turn.turnId });
    if (!probe.handled) {
      return;
    }
    const persisted = probe.data.messages.filter((message) => message.role === 'assistant').length;
    if (persisted >= expected) {
      return;
    }
    // Re-check the counter: a stored event may have arrived during the probe.
    if ((this.assistantStoredCounts.get(turn.turnId) ?? 0) >= expected) {
      return;
    }

    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.assistantPersistenceWaiters.delete(turn.turnId);
        resolve();
      };
      const timer = setTimeout(settle, TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS);
      this.assistantPersistenceWaiters.set(turn.turnId, { expected, settle });
      if ((this.assistantStoredCounts.get(turn.turnId) ?? 0) >= expected) {
        settle();
      }
    });
  }
}
