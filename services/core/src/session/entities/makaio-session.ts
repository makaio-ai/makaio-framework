import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import { Turn, type TurnConfig } from './turn.js';

/**
 * Configuration for creating a MakaioSession.
 */
export interface MakaioSessionConfig {
  /** Session ID (generated if not provided) */
  sessionId?: string;
  /** Bus for event emission */
  bus: IMakaioBus;
  /** Parent session ID (for forks) */
  parentSessionId?: string;
}

/**
 * Options for starting a turn.
 */
export interface StartTurnOptions {
  /** Agents participating in this turn */
  agentIds: string[];
  /** Initial message ID (required - turn.started schema mandates it) */
  messageId: string;
  /** Monotonic per-session ordinal (1-based), assigned by turn storage. */
  turnNumber: number;
  /** Optional pre-generated turn ID */
  turnId?: string;
}

/**
 * MakaioSession is the aggregate root for session state.
 *
 * It owns Turn[] children and emits lifecycle events from within,
 * mirroring the AIAgent pattern. Events are emitted when state changes,
 * not by external orchestration code.
 *
 * SEAM: This entity is designed to support future buildContext() method
 * for projecting raw history to effective history (transforms, token budgets).
 */
export class MakaioSession {
  public readonly sessionId: string;
  public readonly parentSessionId?: string;
  public status: 'active' | 'closed' | 'archived' = 'active';

  /** Turn children - owned by this aggregate */
  private readonly _turns: Turn[] = [];

  /** Track which turns have been completed */
  private readonly _completedTurnIds = new Set<string>();

  /** Bus for event emission */
  protected readonly bus: IMakaioBus;

  public constructor(config: MakaioSessionConfig) {
    this.sessionId = config.sessionId ?? crypto.randomUUID();
    this.parentSessionId = config.parentSessionId;
    this.bus = config.bus;
  }

  /**
   * Get turns owned by this session (read-only view).
   * @returns Immutable array of turns
   */
  public get turns(): readonly Turn[] {
    return this._turns;
  }

  /**
   * Start a new turn in this session.
   *
   * Creates a Turn child entity and emits turn.started event.
   * This is the key pattern: state change + event emission happen together
   * inside the aggregate, not in external orchestration code.
   * @param options - Turn configuration
   * @returns The created Turn
   * @throws Error if session is not active (for example closed or archived)
   */
  public async startTurn(options: StartTurnOptions): Promise<Turn> {
    if (this.status !== 'active') {
      throw new Error('Cannot start turn on non-active session');
    }

    const turnConfig: TurnConfig = {
      sessionId: this.sessionId,
      agentIds: options.agentIds,
      turnNumber: options.turnNumber,
      turnId: options.turnId,
    };

    const turn = new Turn(turnConfig);
    this._turns.push(turn);

    // Add initial message to turn
    turn.addMessage(options.messageId);

    // Emit from within the entity - the key architectural pattern
    await this.emit(SessionSubjects.turn.started, {
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      agentIds: [...turn.agentIds],
      messageId: options.messageId,
    });

    return turn;
  }

  /**
   * Get the currently active (incomplete) turn.
   * @returns The active turn, or undefined if no turn is active
   */
  public getActiveTurn(): Turn | undefined {
    // Find the most recent turn that isn't completed
    for (let i = this._turns.length - 1; i >= 0; i--) {
      const turn = this._turns[i];
      if (!this._completedTurnIds.has(turn.turnId)) {
        return turn;
      }
    }
    return undefined;
  }

  /**
   * Complete a turn and emit turn.completed event.
   * @param turn - The turn to complete
   */
  public async completeTurn(turn: Turn): Promise<void> {
    if (!turn.isComplete()) {
      throw new Error(`Turn ${turn.turnId} is not complete yet`);
    }

    this._completedTurnIds.add(turn.turnId);
    const result = turn.getResult();

    await this.emit(SessionSubjects.turn.completed, {
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      success: result.success,
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    });
  }

  /**
   * Emit an event with sessionId auto-enriched.
   *
   * Mirrors AIAgent.emitGlobal pattern - entity emits its own events
   * with context automatically included.
   * @param subject - The subject to emit to
   * @param payload - The payload (without sessionId - it's added automatically)
   */
  protected async emit<S extends SubjectDefinition>(
    subject: S,
    payload: Omit<ExtractSubjectPayload<S>, 'sessionId'>,
  ): Promise<void> {
    await this.bus.emit(
      subject as Parameters<IMakaioBus['emit']>[0],
      {
        ...payload,
        sessionId: this.sessionId,
      } as Parameters<IMakaioBus['emit']>[1],
    );
  }
}
