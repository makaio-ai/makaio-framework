import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type MessageOutcome, type TurnInitiator } from '@makaio/contracts';
import { TurnStorageSubjects } from './turns/index.js';
import { Turn } from './entities/turn.js';
import { TurnUsageAccumulator, type AgentUsageEvent } from './turn-usage-accumulator.js';
import { appendSessionLifecycleEvent } from './session-lifecycle-events.js';
import {
  TurnSlotRegistry,
  type TurnAcquisition,
  type TurnPreparationLease,
  type TurnReservation,
  type TurnMessageAdmissionLease,
  type PreparedTurnMessageAdmissionLease,
} from './turn-slot-registry.js';
import type { TurnCompleteCallback, TurnCompletionResult } from './turn-completion.js';
import { AssistantPersistenceBarrier } from './assistant-persistence-barrier.js';
import { composePreparedTurnAdmission } from './turn-admission.js';
import { flushBufferedTurnUsage, persistTurnCompletion } from './turn-finalization-persistence.js';
import { recordTurnPairCompletion, registerTurnCompletionEvents } from './turn-completion-events.js';

export type {
  TurnAcquisition,
  TurnReservation,
  TurnMessageAdmissionLease,
  PreparedTurnMessageAdmissionLease,
} from './turn-slot-registry.js';

/**
 * Upper bound (ms) for the persist-before-emit barrier in {@link SessionTurnManager.completeTurn}.
 *
 * SessionBridge normally resolves the barrier explicitly after each agent's
 * assistant-message persistence decision settles. The timeout remains a
 * mandatory fallback for a missing bridge or lost lifecycle signal so turn
 * completion can never hang indefinitely.
 */
export const TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS = 1500;

/** Durable error code for a new turn whose first user message could not be stored. */
export const USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR = 'user-message-persistence-failed';

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
 * **Persist-before-emit barrier:** successful assistant-message writes finish
 * before consumers observe `session.turn.completed`. Message persistence
 * (SessionBridge) and turn completion both react to `agent.complete`, and the
 * bus runs event handlers in parallel — so before emitting, `completeTurn` awaits
 * `session.turn.assistantPersistenceSettled` confirmations for every agent in
 * the turn (bus-mediated: the manager holds no reference to SessionBridge).
 * The wait is bounded by {@link TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS} as a
 * missing-bridge fallback and skipped entirely in ephemeral mode.
 */
export class SessionTurnManager {
  /** Owns routable turn slots and reservations across asynchronous setup. */
  private readonly turnSlots = new TurnSlotRegistry();

  /** Per-turn usage accumulators, keyed by turnId. */
  private readonly usageAccumulators = new Map<string, TurnUsageAccumulator>();

  /** Turns currently persisting completion (prevents concurrent writes). */
  private readonly completingTurnIds = new Set<string>();

  /** Shared completion work so slot gates can await an already-finalizing turn. */
  private readonly completionPromises = new Map<string, Promise<void>>();

  /** Completing turns retained for usage correlation after active routing is cleared. */
  private readonly completingTurns = new Map<string, Turn>();

  /**
   * Turns whose terminal usage snapshot is closed. Completion correlation may
   * remain retryable after this point, but a retry must never reopen usage
   * admission and mutate the snapshot already selected for lifecycle output.
   */
  private readonly closedUsageAdmissions = new Set<string>();

  /** Pending terminal completions keyed by turnId; value records whether turn storage handled the transition. */
  private readonly pendingTerminalCompletions = new Map<string, boolean>();

  /** Canonical terminal result retained while a finalizing turn needs an explicit retry. */
  private readonly pendingTerminalResults = new Map<string, TurnCompletionResult>();

  /** Setup-failed turns block new admission until their terminal write reconciles. */
  private readonly setupFinalizingTurnIds = new Set<string>();

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

  /** Bus-mediated assistant-message persistence barrier. */
  private readonly assistantPersistenceBarrier: AssistantPersistenceBarrier;

  /** Bus subscription cleanup functions. */
  private readonly cleanups: Array<() => void> = [];

  /**
   * @param bus - Event bus used for storage RPCs and event emission
   */
  public constructor(private readonly bus: IMakaioBus) {
    this.assistantPersistenceBarrier = new AssistantPersistenceBarrier(
      bus,
      (turnId) => this.findTurnForCompletion(turnId),
      TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS,
    );
  }

  // ---------------------------------------------------------------------------
  // Turn creation
  // ---------------------------------------------------------------------------

  /**
   * Acquire the routable turn for an ordinary message send.
   *
   * Concurrent sends either join the existing turn or await the same reserved
   * creation. They can never each create and overwrite a turn after storage
   * assignment has awaited.
   * @param sessionId - Session receiving the message.
   * @param agentIds - Agents participating when a new turn is needed.
   * @param initiator - Turn origin metadata for a new turn.
   * @param turnId - Optional pre-assigned identifier for a new turn.
   * @returns Existing or newly created routable turn plus its acquisition mode.
   */
  public async acquireTurn(
    sessionId: string,
    agentIds: string[],
    initiator?: TurnInitiator,
    turnId?: string,
  ): Promise<TurnAcquisition> {
    await this.retryRetainedCompletionsForSession(sessionId);
    const acquisition = await this.turnSlots.acquire(sessionId, (reservation) =>
      this.createReservedTurn(reservation, agentIds, initiator, turnId),
    );
    if (agentIds.some((agentId) => !acquisition.turn.hasAgent(agentId))) {
      throw new Error(
        `Turn ${acquisition.turn.turnId} cannot route agents outside its immutable participant set (sessionId=${sessionId})`,
      );
    }
    return acquisition;
  }

  /**
   * Reserve an otherwise idle session turn slot for an exclusive setup flow.
   *
   * Attach uses this before starting its idle agent, so an initial-message
   * attach is rejected before it can create a second provider lifecycle for a
   * session already routing work.
   * @param sessionId - Session whose next turn slot is reserved.
   * @returns Opaque reservation consumed by {@link createReservedTurn}.
   */
  public async reserveTurn(sessionId: string): Promise<TurnReservation> {
    await this.retryRetainedCompletionsForSession(sessionId);
    return this.turnSlots.reserve(sessionId);
  }

  /**
   * Release an unused exclusive turn reservation.
   * @param reservation - Reservation previously returned by {@link reserveTurn}.
   */
  public releaseTurnReservation(reservation: TurnReservation): void {
    this.turnSlots.release(reservation);
  }

  /**
   * Atomically acquire a routable turn and admit the complete message fanout.
   * When a concurrent terminal transition wins, acquisition retries rather than
   * returning a turn whose completion can no longer see this message.
   * @param sessionId - Session receiving the message.
   * @param agentIds - Immutable participant subset targeted by the message.
   * @param messageId - Stable message identity.
   * @param initiator - Optional turn origin metadata.
   * @param turnId - Optional preassigned turn identity.
   * @returns Prepared admission lease after first-message ordering is satisfied.
   */
  public async acquireMessageAdmission(
    sessionId: string,
    agentIds: string[],
    messageId: string,
    initiator?: TurnInitiator,
    turnId?: string,
  ): Promise<PreparedTurnMessageAdmissionLease> {
    for (;;) {
      const acquisition = await this.acquireTurn(sessionId, agentIds, initiator, turnId);
      const admission = this.turnSlots.tryAdmitMessage(acquisition.turn, messageId, agentIds);
      if (!admission) continue;
      const preparation = this.turnSlots.beginPreparation(acquisition.turn);
      if (!preparation.isOwner) {
        try {
          await preparation.ready;
        } catch {
          await admission.rollback();
          continue;
        }
      }
      return this.composeAdmissionWithPreparation(admission, preparation);
    }
  }

  /**
   * Admit a message to an exclusively reserved attach turn.
   * @param turn - Exclusively reserved attach turn.
   * @param messageId - Stable initial-message identity.
   * @param agentIds - Attach target participant set.
   * @returns Prepared admission lease for the attach message.
   */
  public admitReservedMessage(turn: Turn, messageId: string, agentIds: string[]): PreparedTurnMessageAdmissionLease {
    const admission = this.turnSlots.tryAdmitMessage(turn, messageId, agentIds);
    if (!admission) throw new Error(`Turn ${turn.turnId} is no longer routable for message admission`);
    return this.composeAdmissionWithPreparation(admission, this.turnSlots.beginPreparation(turn));
  }

  /**
   * Create a reserved turn once an exclusive setup flow knows its participants.
   *
   * Calls `TurnStorageSubjects.create` via `requestOptional`. If no storage
   * handler is registered (ephemeral mode), generates a synthetic UUID turn ID
   * and a per-session incrementing turn number.
   * @param reservation - Exclusive slot claim returned by {@link reserveTurn}.
   * @param agentIds - Agents participating in the new turn.
   * @param initiator - Turn origin metadata (user, plugin, system).
   * @param turnId - Optional pre-assigned turn ID passed to storage.
   * @returns Newly created and activated turn.
   */
  public async createReservedTurn(
    reservation: TurnReservation,
    agentIds: string[],
    initiator?: TurnInitiator,
    turnId?: string,
  ): Promise<Turn> {
    const { sessionId } = reservation;

    try {
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

      this.turnSlots.activate(reservation, turn);
      this.usageAccumulators.set(turn.turnId, new TurnUsageAccumulator());
      return turn;
    } finally {
      this.releaseTurnReservation(reservation);
    }
  }

  /**
   * Create a new exclusive turn, tracking it as active.
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
    return this.createReservedTurn(await this.reserveTurn(sessionId), agentIds, initiator, turnId);
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
    this.assistantPersistenceBarrier.clear(turn.turnId);
  }

  /**
   * Mark a newly created turn as failed before provider dispatch and discard its active state.
   *
   * A user message may already be durable when a later pre-dispatch lifecycle
   * step fails. No provider turn has been accepted in either case, so the
   * manager can terminalize the turn directly without waiting for assistant
   * persistence.
   * @param turn - Active turn whose setup failed before provider dispatch
   * @param error - Durable error code to store on the terminal turn
   */
  public async failActiveTurnBeforeDispatch(turn: Turn, error: string): Promise<void> {
    const active = this.turnSlots.getActive(turn.sessionId);
    if (active?.turnId !== turn.turnId) {
      return;
    }
    const result = { success: false, errors: [error] };
    this.beginFinalization(turn, result, 'setup');
    await this.completeTurn(turn, result);
  }

  /**
   * Mark an unclaimed newly created turn as failed and discard its active in-memory state.
   *
   * Concurrent sends may have claimed the turn by the time their sibling's
   * append fails. Those turns remain routable; callers that own the entire
   * pre-dispatch sequence should use {@link failActiveTurnBeforeDispatch}.
   * @param turn - Newly created active turn whose setup failed before any message claimed it
   * @param error - Durable error code to store on the terminal turn
   */
  public async failActiveTurnSetup(turn: Turn, error: string): Promise<void> {
    if (turn.messageIds.length > 0 || turn.hasPendingMessageAppends) {
      return;
    }
    await this.failActiveTurnBeforeDispatch(turn, error);
  }

  /**
   * Remove a turn from the active routing index when it is no longer routable.
   * @param turn - Turn to remove when it still owns the session slot
   * @returns Whether the turn owned and cleared the active routing slot
   */
  private clearActiveRoutingTurn(turn: Turn): boolean {
    return this.turnSlots.clearActive(turn);
  }

  private composeAdmissionWithPreparation(
    admission: TurnMessageAdmissionLease,
    preparation: TurnPreparationLease,
  ): PreparedTurnMessageAdmissionLease {
    return composePreparedTurnAdmission(admission, preparation, {
      completePreparation: (lease) => this.turnSlots.completePreparation(lease),
      failPreparation: (lease, error) => this.turnSlots.failPreparation(lease, error),
      beginSetupFailure: (current, result) => this.beginFinalization(current.turn, result, 'setup'),
      finalizeSetupFailure: async (current, result) => this.completeTurn(current.turn, result),
      finalizeCompletedLedger: async (current, result) => {
        this.beginFinalization(current.turn, result, 'normal');
        await this.completeTurn(current.turn, result);
      },
    });
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
    this.cleanups.push(...registerTurnCompletionEvents(this.bus, this.completionEventHooks(), onTurnComplete));
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
   * persistence succeeds; if persistence fails, non-routable finalization
   * state remains available to {@link retryTurnCompletion}.
   *
   * Before the event fires, the persist-before-emit barrier waits for every
   * agent's assistant-persistence decision to settle (see class docs), then a
   * `turn.completed` lifecycle row is appended to `session_events`. Successful
   * message writes and the lifecycle row are therefore durable before consumers
   * observe `session.turn.completed`.
   * @param turn - The turn to complete
   * @param result - Turn result (success status and error messages)
   * @returns Promise resolved after durable finalization and emission.
   */
  public async completeTurn(turn: Turn, result: TurnCompletionResult): Promise<void> {
    const existing = this.completionPromises.get(turn.turnId);
    if (existing) return await existing;
    const completion = this.completeTurnInternal(turn, result);
    this.completionPromises.set(turn.turnId, completion);
    try {
      await completion;
    } finally {
      if (this.completionPromises.get(turn.turnId) === completion) this.completionPromises.delete(turn.turnId);
    }
  }

  private async completeTurnInternal(turn: Turn, result: TurnCompletionResult): Promise<void> {
    if (this.completingTurnIds.has(turn.turnId)) {
      return;
    }
    this.completingTurnIds.add(turn.turnId);
    const terminalResult = this.beginFinalization(turn, result, 'normal');
    // A terminal turn must never remain available to a new send while durable
    // completion retries or the assistant-persistence barrier are in flight.

    const usageAccumulator = this.usageAccumulators.get(turn.turnId);
    let completedUsage = usageAccumulator?.snapshot();

    let turnStorageHandled = this.pendingTerminalCompletions.get(turn.turnId) ?? false;
    try {
      if (!this.pendingTerminalCompletions.has(turn.turnId)) {
        const completion = await persistTurnCompletion(this.bus, turn, terminalResult, completedUsage, 'active');
        turnStorageHandled = completion.handled;
        if (!completion.transitioned) {
          this.clearActiveRoutingTurn(turn);
          this.clearCompletionState(turn, usageAccumulator);
          return;
        }
        this.pendingTerminalCompletions.set(turn.turnId, turnStorageHandled);
        completedUsage = await flushBufferedTurnUsage({
          bus: this.bus,
          turn,
          result: terminalResult,
          usageAccumulator,
          currentUsage: completedUsage,
          bufferedUsage: this.bufferedUsageDuringCompletion,
        });
      }
    } catch (error) {
      // Retain the non-routable finalizing turn and its result for explicit
      // retry; only the in-flight guard is released.
      this.completingTurnIds.delete(turn.turnId);
      console.error(`[SessionTurnManager] Failed to persist completion for turn ${turn.turnId}:`, error);
      throw error;
    }

    // At this point the durable turn row is terminal. It remains non-routable
    // while assistant-message persistence and lifecycle emission finish.
    let lifecycleAppended = false;
    try {
      // Persist-before-emit barrier. Skipped entirely in ephemeral mode: turn
      // and message storage are registered together (sessionStoragePackage), so
      // unhandled turn storage implies unhandled message storage and there is
      // nothing to wait for (zero added latency).
      if (turnStorageHandled && !this.setupFinalizingTurnIds.has(turn.turnId)) {
        await this.assistantPersistenceBarrier.waitFor(turn);
      }
      // Close usage admission before the final drain. Completion correlation
      // remains in completingTurns for an explicit lifecycle retry, but that
      // retry must not reopen the terminal usage snapshot.
      this.closedUsageAdmissions.add(turn.turnId);
      completedUsage = await flushBufferedTurnUsage({
        bus: this.bus,
        turn,
        result: terminalResult,
        usageAccumulator,
        currentUsage: completedUsage,
        bufferedUsage: this.bufferedUsageDuringCompletion,
      });
      const completedPayload = {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        success: terminalResult.success,
        error: terminalResult.errors.length > 0 ? terminalResult.errors.join('; ') : undefined,
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
        // A failed final drain or lifecycle append remains explicitly retryable.
        // Its completion correlation stays intact, while closed usage admission
        // deliberately remains closed across the retry boundary.
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
   * Retry a retained non-routable completion after durable storage failed.
   * @param turnId - Identifier of the finalizing turn to retry.
   */
  public async retryTurnCompletion(turnId: string): Promise<void> {
    const retainedTurn = this.completingTurns.get(turnId);
    const retainedResult = this.pendingTerminalResults.get(turnId);
    if (retainedTurn === undefined || retainedResult === undefined) {
      throw new Error(`Turn ${turnId} has no retryable completion`);
    }
    await this.completeTurn(retainedTurn, retainedResult);
  }

  /**
   * Retry retained durable finalization before a session accepts new work.
   *
   * A provider normally emits one terminal event, so an ordinary later send is
   * the reachable owner trigger for a completion whose storage response failed.
   * @param sessionId - Session about to acquire a new routable turn.
   */
  public async retryRetainedCompletionsForSession(sessionId: string): Promise<void> {
    await this.turnSlots.awaitFinalization(sessionId, async () => {
      for (const turn of [...this.completingTurns.values()].filter(
        (candidate) => candidate.sessionId === sessionId && this.setupFinalizingTurnIds.has(candidate.turnId),
      )) {
        const inFlight = this.completionPromises.get(turn.turnId);
        if (inFlight) await inFlight;
        else if (!this.completingTurnIds.has(turn.turnId)) await this.retryTurnCompletion(turn.turnId);
      }
      for (const turn of [...this.completingTurns.values()].filter(
        // A normal assistant-persistence barrier remains intentionally
        // concurrent with the next turn. Any retained turn with no in-flight
        // completion, however, needs its storage or lifecycle retry first.
        (candidate) =>
          candidate.sessionId === sessionId &&
          this.pendingTerminalResults.has(candidate.turnId) &&
          !this.completingTurnIds.has(candidate.turnId),
      )) {
        const inFlight = this.completionPromises.get(turn.turnId);
        if (inFlight) {
          await inFlight;
        } else {
          await this.retryTurnCompletion(turn.turnId);
        }
      }
    });
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
    this.assistantPersistenceBarrier.clear(turn.turnId);
    this.completingTurns.delete(turn.turnId);
    this.closedUsageAdmissions.delete(turn.turnId);
    this.completingTurnIds.delete(turn.turnId);
    this.pendingTerminalCompletions.delete(turn.turnId);
    this.pendingTerminalResults.delete(turn.turnId);
    this.setupFinalizingTurnIds.delete(turn.turnId);
    this.turnSlots.finishFinalization(turn);
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
    return this.turnSlots.getActive(sessionId);
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
    return this.turnSlots.findActiveByTurnId(turnId);
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
    this.turnSlots.clear();
    this.usageAccumulators.clear();
    this.completingTurnIds.clear();
    this.completionPromises.clear();
    this.completingTurns.clear();
    this.closedUsageAdmissions.clear();
    this.pendingTerminalCompletions.clear();
    this.pendingTerminalResults.clear();
    this.setupFinalizingTurnIds.clear();
    this.bufferedUsageDuringCompletion.clear();
    this.syntheticTurnCounters.clear();
    this.assistantPersistenceBarrier.destroy();
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
   * @param messageId - Exact admitted message identity.
   * @param outcome - Canonical provider or routing outcome.
   * @param error - Error message if the agent failed
   * @param onTurnComplete - Callback to invoke when the turn is complete
   * @param completionTurnId - Explicit turn identifier supplied by the adapter completion event
   * @returns Promise resolved after pair observation and any terminal finalization.
   */
  public async recordAgentCompletion(
    agentId: string,
    messageId: string,
    outcome: MessageOutcome,
    error: string | undefined,
    onTurnComplete: TurnCompleteCallback,
    completionTurnId: string,
  ): Promise<void> {
    await recordTurnPairCompletion(this.bus, this.completionEventHooks(), {
      agentId,
      messageId,
      outcome,
      ...(error !== undefined && { error }),
      turnId: completionTurnId,
      onTurnComplete,
    });
  }

  private completionEventHooks() {
    return {
      resolveUsageTurn: (turnId: string) => this.findTurnForUsage(turnId),
      resolveCompletionTurn: (turnId: string) => this.findTurnForCompletion(turnId),
      isCompletionInFlight: (turnId: string) => this.completingTurnIds.has(turnId),
      addUsage: (turn: Turn, event: AgentUsageEvent) => this.usageAccumulators.get(turn.turnId)?.add(event),
      bufferUsage: (turnId: string, event: AgentUsageEvent) => this.bufferUsageDuringCompletion(turnId, event),
      canRetry: (turnId: string) => this.pendingTerminalResults.has(turnId) && !this.completingTurnIds.has(turnId),
      retry: async (turnId: string) => this.retryTurnCompletion(turnId),
      beginFinalization: (turn: Turn, result: TurnCompletionResult) => this.beginFinalization(turn, result, 'normal'),
    };
  }

  private beginFinalization(turn: Turn, result: TurnCompletionResult, mode: 'normal' | 'setup'): TurnCompletionResult {
    const canonical = this.pendingTerminalResults.get(turn.turnId) ?? result;
    this.completingTurns.set(turn.turnId, turn);
    this.pendingTerminalResults.set(turn.turnId, canonical);
    if (mode === 'setup') this.setupFinalizingTurnIds.add(turn.turnId);
    this.turnSlots.beginFinalization(turn);
    return canonical;
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
    const activeTurn = this.findActiveTurnByTurnId(turnId);
    if (activeTurn !== undefined) return activeTurn;
    if (this.closedUsageAdmissions.has(turnId)) return undefined;
    return this.completingTurns.get(turnId);
  }

  /**
   * Find a turn that may still accept agent completion by turnId.
   * @param turnId - Turn identifier from an agent completion event
   * @returns Active or completing turn, if completion can still be correlated
   */
  private findTurnForCompletion(turnId: string): Turn | undefined {
    return this.findActiveTurnByTurnId(turnId) ?? this.completingTurns.get(turnId);
  }
}
