/**
 * Turn boundary state machine for synthesizing turn events during log import.
 *
 * Some log formats (like Claude Code) lack explicit turn boundaries.
 * This module provides a generic state machine to track turn lifecycle
 * and emit synthetic `turn.started` and `turn.completed` events.
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Turn lifecycle state.
 * @remarks
 * - `idle`: No active turn, waiting for a turn to start
 * - `active`: Turn in progress, waiting for completion
 */
export type TurnState = 'idle' | 'active';

/**
 * Synthetic turn event to be emitted during log import.
 * @remarks
 * These events are synthesized by the state machine when it detects
 * turn boundaries (e.g., user message starts a turn, final text completes it).
 * @see {@link TurnTracker} - State machine that produces these events
 */
export interface TurnEvent {
  /** Type of turn event */
  type: 'turn.started' | 'turn.completed';

  /** Session ID for this turn (from the record that triggered the transition) */
  sessionId: string;

  /** Unique identifier for this turn instance */
  turnId: string;
}

/**
 * Configuration options for the turn tracker.
 * @remarks
 * Adapters provide detection functions specific to their log format:
 * - Claude Code: `detectTurnStart` triggers on user messages,
 *   `detectTurnComplete` triggers on final text content blocks
 * - Copilot: Explicit `turn_start`/`turn_end` events, may bypass this tracker
 * @typeParam TRecord - The adapter's native log record type
 * @see {@link TurnTracker} - Uses these options
 */
export interface TurnTrackerOptions<TRecord> {
  /**
   * Detect if a record indicates the start of a turn.
   * @param record - Log record to check
   * @returns True if this record starts a new turn
   * @example
   * ```typescript
   * // Claude Code: user message starts a turn
   * detectTurnStart: (record) => record.type === 'user'
   * ```
   */
  detectTurnStart: (record: TRecord) => boolean;

  /**
   * Detect if a record indicates the completion of a turn.
   * @param record - Log record to check
   * @returns True if this record completes the current turn
   * @example
   * ```typescript
   * // Claude Code: final text block completes a turn
   * detectTurnComplete: (record) =>
   *   record.type === 'assistant' &&
   *   record.message?.content?.some((b) => b.type === 'text')
   * ```
   */
  detectTurnComplete: (record: TRecord) => boolean;

  /**
   * Extract the session ID from a log record.
   * @param record - Log record to extract session ID from
   * @returns Session ID string
   * @example
   * ```typescript
   * getSessionId: (record) => record.sessionId
   * ```
   */
  getSessionId: (record: TRecord) => string;

  /**
   * Optional custom function to generate turn IDs.
   * @defaultValue Uses `crypto.randomUUID()`
   * @remarks
   * Override this for deterministic testing or custom ID schemes.
   * @param sessionId - The session ID for context
   * @returns Unique turn ID string
   */
  generateTurnId?: (sessionId: string) => string;
}

/**
 * Internal state tracked per session.
 */
interface SessionTurnState {
  /** Current turn state */
  state: TurnState;

  /** Current turn ID (when state is 'active'), undefined when idle */
  currentTurnId: string | undefined;
}

/**
 * Serialized form of TurnTracker state for persistence across chunks/restarts.
 * @remarks
 * Used by {@link TurnTracker.serialize} and {@link TurnTracker.restore} to
 * enable incremental log imports that can resume processing.
 */
export interface TurnTrackerSerializedState {
  /** Session states keyed by session ID */
  sessions: Record<string, { state: TurnState; currentTurnId?: string }>;
}

/**
 * Zod schema for validating serialized TurnTracker state.
 *
 * Used by adapter log importers to safely deserialize cursor state
 * without unsafe `as` casts.
 * @see {@link TurnTrackerSerializedState} - TypeScript interface this validates
 */
export const TurnTrackerSerializedStateSchema = z
  .object({
    sessions: z.record(
      z.string(),
      z.object({
        state: z.enum(['idle', 'active']),
        currentTurnId: z.string().optional(),
      }),
    ),
  })
  .default({ sessions: {} });

/**
 * State machine for tracking turn boundaries during log import.
 *
 * ## Purpose
 *
 * Some external tools (like Claude Code) don't emit explicit turn start/end events.
 * This tracker synthesizes these events based on adapter-specific detection logic.
 *
 * ## State Transitions
 *
 * ```
 * idle --[turn start detected]--> active (emit turn.started)
 * active --[turn complete detected]--> idle (emit turn.completed)
 * ```
 *
 * ## Multi-Session Support
 *
 * The tracker maintains independent state per session ID, enabling
 * concurrent processing of multiple sessions from the same log file.
 * @remarks
 * - Thread-safe for single-threaded async processing (no mutex needed)
 * - Stateless between sessions (each session tracked independently)
 * - Idempotent: processing the same record twice produces consistent results
 * @typeParam TRecord - The adapter's native log record type
 * @example
 * ```typescript
 * // Create tracker for Claude Code logs
 * const tracker = new TurnTracker({
 *   detectTurnStart: (record) => record.type === 'user',
 *   detectTurnComplete: (record) =>
 *     record.type === 'assistant' &&
 *     record.message?.content?.some((b) => b.type === 'text'),
 *   getSessionId: (record) => record.sessionId,
 * });
 *
 * // Process records
 * for (const record of records) {
 *   const turnEvents = tracker.processRecord(record);
 *   for (const event of turnEvents) {
 *     // Emit turn.started or turn.completed events
 *     console.log(event.type, event.turnId);
 *   }
 * }
 * ```
 * @see {@link TurnTrackerOptions} - Configuration options
 * @see {@link TurnEvent} - Emitted turn events
 */
export class TurnTracker<TRecord> {
  private readonly options: TurnTrackerOptions<TRecord>;
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly generateTurnId: (sessionId: string) => string;

  /**
   * Create a new turn tracker.
   * @param options - Tracker configuration with detection functions
   */
  public constructor(options: TurnTrackerOptions<TRecord>) {
    this.options = options;
    this.generateTurnId = options.generateTurnId ?? (() => crypto.randomUUID());
  }

  /**
   * Process a log record and return any turn events that should be emitted.
   * @param record - Log record to process
   * @returns Array of turn events (may be empty, one, or two if turn completes and new one starts)
   * @remarks
   * ## Transition Rules
   *
   * 1. **idle + turn start detected** emits `turn.started`, transitions to active
   * 2. **active + turn complete detected** emits `turn.completed`, transitions to idle
   * 3. **active + turn start detected** emits `turn.completed` for previous turn,
   *    then emits `turn.started` for new turn (implicit completion)
   * 4. **idle + turn complete detected** is a no-op (no active turn to complete)
   *
   * Rule 3 handles cases where a user sends another message before the assistant
   * finishes responding (rare but possible in log replays).
   */
  public processRecord(record: TRecord): TurnEvent[] {
    const sessionId = this.options.getSessionId(record);
    const sessionState = this.getOrCreateSessionState(sessionId);
    const events: TurnEvent[] = [];

    const isTurnStart = this.options.detectTurnStart(record);
    const isTurnComplete = this.options.detectTurnComplete(record);

    if (isTurnStart) {
      // If we're already in an active turn, implicitly complete it first
      if (sessionState.state === 'active' && sessionState.currentTurnId) {
        events.push({
          type: 'turn.completed',
          sessionId,
          turnId: sessionState.currentTurnId,
        });
      }

      // Start new turn
      const newTurnId = this.generateTurnId(sessionId);
      sessionState.state = 'active';
      sessionState.currentTurnId = newTurnId;
      events.push({
        type: 'turn.started',
        sessionId,
        turnId: newTurnId,
      });
    } else if (isTurnComplete && sessionState.state === 'active' && sessionState.currentTurnId) {
      // Complete the current turn
      events.push({
        type: 'turn.completed',
        sessionId,
        turnId: sessionState.currentTurnId,
      });
      sessionState.state = 'idle';
      sessionState.currentTurnId = undefined;
    }
    // else: no-op for turn complete when idle, or records that aren't turn boundaries

    return events;
  }

  /**
   * Get the current turn state for a session.
   * @param sessionId - Session identifier
   * @returns Current turn state ('idle' if session not tracked)
   */
  public getState(sessionId: string): TurnState {
    return this.sessions.get(sessionId)?.state ?? 'idle';
  }

  /**
   * Get the current turn ID for a session.
   * @param sessionId - Session identifier
   * @returns Current turn ID or undefined if no active turn
   */
  public getCurrentTurnId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.currentTurnId;
  }

  /**
   * Check if a session has an active turn.
   * @param sessionId - Session identifier
   * @returns True if the session has an active (non-idle) turn
   */
  public hasActiveTurn(sessionId: string): boolean {
    return this.getState(sessionId) === 'active';
  }

  /**
   * Reset state for a specific session.
   * @remarks
   * Use this when a session is known to be complete or when re-processing.
   * @param sessionId - Session identifier
   * @returns True if the session was tracked and removed
   */
  public resetSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Reset all tracked session state.
   * @remarks
   * Use this for cleanup or when starting fresh.
   */
  public resetAll(): void {
    this.sessions.clear();
  }

  /**
   * Serialize the tracker state for persistence.
   * @remarks
   * Use this to save state between chunks or before process shutdown
   * for incremental log imports.
   * @returns JSON-serializable state object
   * @see {@link restore} - Restore state from serialized form
   */
  public serialize(): TurnTrackerSerializedState {
    const sessions: TurnTrackerSerializedState['sessions'] = {};
    for (const [sessionId, sessionState] of this.sessions) {
      sessions[sessionId] = {
        state: sessionState.state,
        currentTurnId: sessionState.currentTurnId,
      };
    }
    return { sessions };
  }

  /**
   * Restore tracker state from a serialized form.
   * @remarks
   * Clears all current state before restoring. Use this to resume
   * processing after a restart or between chunks.
   * @param serialized - State object from {@link serialize}
   * @see {@link serialize} - Create serialized state
   */
  public restore(serialized: TurnTrackerSerializedState): void {
    this.sessions.clear();
    for (const [sessionId, sessionState] of Object.entries(serialized.sessions)) {
      this.sessions.set(sessionId, {
        state: sessionState.state,
        currentTurnId: sessionState.currentTurnId,
      });
    }
  }

  /**
   * Get all currently tracked session IDs.
   * @returns Array of session IDs being tracked
   */
  public getTrackedSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Manually complete the current turn for a session.
   * @remarks
   * Use this for cleanup when processing ends mid-turn (e.g., end of file
   * with an incomplete conversation). Does nothing if no active turn.
   * @param sessionId - Session identifier
   * @returns Turn completed event or undefined if no active turn
   */
  public forceCompleteTurn(sessionId: string): TurnEvent | undefined {
    const sessionState = this.sessions.get(sessionId);
    if (!sessionState || sessionState.state !== 'active' || !sessionState.currentTurnId) {
      return undefined;
    }

    const event: TurnEvent = {
      type: 'turn.completed',
      sessionId,
      turnId: sessionState.currentTurnId,
    };

    sessionState.state = 'idle';
    sessionState.currentTurnId = undefined;

    return event;
  }

  /**
   * Get or create session state for a session ID.
   * @param sessionId - Session identifier
   * @returns Session state (creates new idle state if not exists)
   */
  private getOrCreateSessionState(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { state: 'idle', currentTurnId: undefined };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}
