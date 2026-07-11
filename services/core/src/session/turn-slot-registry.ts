import type { Turn } from './entities/turn.js';

const turnReservationBrand: unique symbol = Symbol('turnReservation');

/** Opaque exclusive claim on a session's next routable turn slot. */
export interface TurnReservation {
  /** Session whose turn slot is exclusively reserved. */
  readonly sessionId: string;
  /** Prevents callers from fabricating reservations outside this module. */
  readonly [turnReservationBrand]: true;
}

/** Result of atomically acquiring a session turn for normal message delivery. */
export interface TurnAcquisition {
  /** Routable turn acquired for the caller. */
  readonly turn: Turn;
  /** Whether this caller created the turn rather than joining an existing one. */
  readonly isNew: boolean;
}

/**
 * Exclusive lease for preparing a newly routable turn.
 *
 * The owner persists the first user message and initializes `turn.started`.
 * Joiners wait for the same lease before appending and routing their own
 * messages, so provider delivery can never outrun durable turn initialization.
 */
export interface TurnPreparationLease {
  /** Turn whose initial durable setup is coordinated by this lease. */
  readonly turn: Turn;
  /** Whether this caller owns the first-message preparation work. */
  readonly isOwner: boolean;
  /** Resolves after the first durable append and `turn.started` initialization. */
  readonly ready: Promise<void>;
}

/** Atomic pre-dispatch ownership of one admitted message fanout. */
export interface TurnMessageAdmissionLease {
  readonly turn: Turn;
  readonly messageId: string;
  readonly agentIds: readonly string[];
  /** Finalize the durable append/lifecycle setup and permit terminal outcomes. */
  commit(): void;
  /** Remove an un-routed admission after pre-dispatch setup failed. */
  rollback(): Promise<void>;
}

/** Admission lease composed with the turn's one-time durable preparation gate. */
export interface PreparedTurnMessageAdmissionLease extends TurnMessageAdmissionLease {
  readonly isPreparationOwner: boolean;
  rollback(errorCode?: string): Promise<void>;
}

interface PendingTurnPreparation {
  readonly turn: Turn;
  readonly ready: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Owns the one-routable-turn-per-session slot invariant.
 *
 * Turn persistence remains in SessionTurnManager; this registry only protects
 * the in-memory routing slot across asynchronous creation and attach setup.
 */
export class TurnSlotRegistry {
  private readonly activeTurns = new Map<string, Turn>();
  private readonly reservations = new Map<string, TurnReservation>();
  private readonly pendingAcquisitions = new Map<string, Promise<Turn>>();
  private readonly pendingPreparations = new Map<string, PendingTurnPreparation>();
  private readonly preparedTurnIds = new Set<string>();
  private readonly pendingFinalizations = new Map<string, Promise<void>>();
  private readonly finalizingTurnIds = new Set<string>();

  /**
   * Join the per-session finalization gate before creating or reserving a turn.
   * @param sessionId - Session whose non-routable finalization must settle.
   * @param finalize - Owner action that completes retained terminal work.
   * @returns Promise resolved after retained finalization settles.
   */
  public async awaitFinalization(sessionId: string, finalize: () => Promise<void>): Promise<void> {
    const existing = this.pendingFinalizations.get(sessionId);
    if (existing) return await existing;
    const pending = finalize();
    this.pendingFinalizations.set(sessionId, pending);
    try {
      await pending;
    } finally {
      if (this.pendingFinalizations.get(sessionId) === pending) this.pendingFinalizations.delete(sessionId);
    }
  }

  /**
   * Return the routable turn currently owned by a session.
   * @param sessionId - Session whose active slot is queried.
   * @returns Routable turn currently occupying the slot, if any.
   */
  public getActive(sessionId: string): Turn | undefined {
    return this.activeTurns.get(sessionId);
  }

  /**
   * Find a routable turn by its globally unique turn ID.
   * @param turnId - Turn identifier to locate.
   * @returns Matching routable turn, if any.
   */
  public findActiveByTurnId(turnId: string): Turn | undefined {
    for (const turn of this.activeTurns.values()) {
      if (turn.turnId === turnId) return turn;
    }
    return undefined;
  }

  /**
   * Atomically reuse or create the session's routable turn.
   * @param sessionId - Session whose turn is acquired.
   * @param create - Factory invoked once while holding an exclusive reservation.
   * @returns Existing, pending, or newly created turn with acquisition metadata.
   */
  public async acquire(
    sessionId: string,
    create: (reservation: TurnReservation) => Promise<Turn>,
  ): Promise<TurnAcquisition> {
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn) return { turn: activeTurn, isNew: false };

    const pending = this.pendingAcquisitions.get(sessionId);
    if (pending) return { turn: await pending, isNew: false };

    const reservation = this.reserve(sessionId);
    const creation = create(reservation);
    this.pendingAcquisitions.set(sessionId, creation);
    try {
      return { turn: await creation, isNew: true };
    } finally {
      if (this.pendingAcquisitions.get(sessionId) === creation) {
        this.pendingAcquisitions.delete(sessionId);
      }
    }
  }

  /**
   * Reserve an otherwise idle session slot for exclusive attach setup.
   * @param sessionId - Session whose idle slot is reserved.
   * @returns Opaque reservation required to activate the new turn.
   */
  public reserve(sessionId: string): TurnReservation {
    if (this.activeTurns.has(sessionId) || this.reservations.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a routable or pending turn`);
    }
    const reservation: TurnReservation = { sessionId, [turnReservationBrand]: true };
    this.reservations.set(sessionId, reservation);
    return reservation;
  }

  /**
   * Release an unused reservation.
   * @param reservation - Reservation to release when still current.
   */
  public release(reservation: TurnReservation): void {
    if (this.reservations.get(reservation.sessionId) === reservation) {
      this.reservations.delete(reservation.sessionId);
    }
  }

  /**
   * Activate a newly constructed turn while consuming its reservation.
   * @param reservation - Current exclusive reservation for the session.
   * @param turn - Newly constructed turn that will occupy the slot.
   */
  public activate(reservation: TurnReservation, turn: Turn): void {
    if (this.reservations.get(reservation.sessionId) !== reservation) {
      throw new Error(`Turn reservation for session ${reservation.sessionId} is no longer active`);
    }
    this.activeTurns.set(reservation.sessionId, turn);
    this.release(reservation);
  }

  /**
   * Remove a turn only when it still owns its session's routable slot.
   * @param turn - Turn to remove when it still occupies the slot.
   * @returns Whether the turn owned and cleared the slot.
   */
  public clearActive(turn: Turn): boolean {
    if (this.activeTurns.get(turn.sessionId)?.turnId !== turn.turnId) return false;
    this.activeTurns.delete(turn.sessionId);
    this.preparedTurnIds.delete(turn.turnId);
    return true;
  }

  /**
   * Admit a message while the turn still owns a routable slot.
   * This synchronous transition is deliberately shared with finalization:
   * either the ledger sees the whole fanout, or the caller retries on a new turn.
   * @param turn - Routable turn receiving the message.
   * @param messageId - Stable message identity.
   * @param agentIds - Immutable participant subset targeted by the message.
   * @returns Admission lease, or undefined when finalization already won.
   */
  public tryAdmitMessage(
    turn: Turn,
    messageId: string,
    agentIds: readonly string[],
  ): TurnMessageAdmissionLease | undefined {
    if (this.finalizingTurnIds.has(turn.turnId) || this.activeTurns.get(turn.sessionId)?.turnId !== turn.turnId) {
      return undefined;
    }
    turn.admitMessage(messageId, agentIds);
    let settled = false;
    return {
      turn,
      messageId,
      agentIds: [...agentIds],
      commit: () => {
        if (settled) return;
        settled = true;
        turn.commitMessageAdmission(messageId);
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        turn.rollbackMessageAdmission(messageId);
      },
    };
  }

  /**
   * Begin terminalization synchronously, preventing any later admission to this turn.
   * @param turn - Turn whose routable slot is closed.
   * @returns Whether this call began finalization.
   */
  public beginFinalization(turn: Turn): boolean {
    if (this.finalizingTurnIds.has(turn.turnId)) return false;
    if (this.activeTurns.get(turn.sessionId)?.turnId !== turn.turnId) return false;
    this.finalizingTurnIds.add(turn.turnId);
    this.clearActive(turn);
    return true;
  }

  /**
   * Release the terminal marker after finalization state is fully cleared.
   * @param turn - Successfully finalized turn whose marker is released.
   */
  public finishFinalization(turn: Turn): void {
    this.finalizingTurnIds.delete(turn.turnId);
  }

  /**
   * Acquire the first-message preparation lease for a turn.
   * @param turn - Active turn that must become durable before routing starts.
   * @returns Owner lease or a waiter for the owner's preparation result.
   */
  public beginPreparation(turn: Turn): TurnPreparationLease {
    if (this.preparedTurnIds.has(turn.turnId)) {
      return { turn, isOwner: false, ready: Promise.resolve() };
    }

    const pending = this.pendingPreparations.get(turn.turnId);
    if (pending) {
      return { turn, isOwner: false, ready: pending.ready };
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      resolve = resolveReady;
      reject = rejectReady;
    });
    // A preparation owner receives the original error directly; this prevents
    // an unobserved sibling rejection when no joiner arrived before failure.
    void ready.catch(() => {});
    this.pendingPreparations.set(turn.turnId, { turn, ready, resolve, reject });
    return { turn, isOwner: true, ready };
  }

  /**
   * Publish a completed first-message preparation to all joiners.
   * @param lease - Owner lease that completed durable setup.
   */
  public completePreparation(lease: TurnPreparationLease): void {
    if (!lease.isOwner) {
      throw new Error(`Only the preparation owner can complete turn ${lease.turn.turnId}`);
    }
    const pending = this.pendingPreparations.get(lease.turn.turnId);
    if (!pending || pending.turn !== lease.turn) {
      throw new Error(`Turn preparation for ${lease.turn.turnId} is no longer active`);
    }
    this.pendingPreparations.delete(lease.turn.turnId);
    this.preparedTurnIds.add(lease.turn.turnId);
    pending.resolve();
  }

  /**
   * Reject every pre-dispatch joiner after first-message preparation fails.
   * @param lease - Owner lease whose preparation failed.
   * @param error - Original append or lifecycle error.
   */
  public failPreparation(lease: TurnPreparationLease, error: unknown): void {
    if (!lease.isOwner) {
      throw new Error(`Only the preparation owner can fail turn ${lease.turn.turnId}`);
    }
    const pending = this.pendingPreparations.get(lease.turn.turnId);
    if (!pending || pending.turn !== lease.turn) return;
    this.pendingPreparations.delete(lease.turn.turnId);
    pending.reject(error);
  }

  /** Drop all slots during manager teardown. */
  public clear(): void {
    this.activeTurns.clear();
    this.reservations.clear();
    this.pendingAcquisitions.clear();
    this.pendingFinalizations.clear();
    this.finalizingTurnIds.clear();
    for (const pending of this.pendingPreparations.values()) {
      pending.reject(new Error('Turn slot registry was cleared during preparation'));
    }
    this.pendingPreparations.clear();
    this.preparedTurnIds.clear();
  }
}
