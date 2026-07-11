import type { MessageOutcome, TurnInitiator } from '@makaio/contracts';

/**
 * Creates an immutable copy of turn initiator metadata.
 * @param initiator - Incoming initiator metadata
 * @returns Cloned initiator object
 */
function cloneTurnInitiator(initiator: TurnInitiator): TurnInitiator {
  return {
    source: initiator.source,
    ...(initiator.sourceId !== undefined && { sourceId: initiator.sourceId }),
  };
}

/**
 * Result of a completed turn.
 */
export interface TurnResult {
  /** Whether all agents completed successfully */
  success: boolean;
  /** Error messages from agents that failed */
  errors: string[];
}

/** Terminal outcome stored for one admitted message/agent delivery. */
export type TurnPairTerminalOutcome = MessageOutcome;

/** Result of atomically recording one message/agent terminal transition. */
export type TurnPairStateChange =
  | { accepted: false; turnComplete: false }
  | { accepted: true; turnComplete: false }
  | { accepted: true; turnComplete: true; result: TurnResult };

/**
 * Context for dispatching messages to agents.
 * Passed to agent.sendMessage for context propagation.
 */
export interface TurnContext {
  /** Turn identifier */
  turnId: string;
  /** Current/latest message ID in this turn */
  messageId: string;
}

/**
 * Configuration for creating a Turn.
 */
export interface TurnConfig {
  /** Session this turn belongs to */
  sessionId: string;
  /** Agents participating in this turn */
  agentIds: string[];
  /** Monotonic per-session ordinal (1-based), assigned by turn storage. */
  turnNumber: number;
  /** Optional turn ID (generated if not provided) */
  turnId?: string;
  /** Optional start timestamp (defaults to Date.now()) */
  startedAt?: number;
  /** Origin of this turn (for loop prevention and audit). Defaults to user-initiated. */
  initiator?: TurnInitiator;
}

/**
 * Represents a single turn in a session.
 *
 * A turn is a semantic bracket: user message(s) → agent response(s).
 * Turn encapsulates state and logic, while SessionOrchestrator handles
 * bus events and emissions.
 *
 * Design:
 * - Immutable identity (turnId, sessionId, agentIds set at creation)
 * - Mutable state (messages, completion tracking)
 * - State changes return results for orchestrator to act on
 * - No bus dependency (testable in isolation)
 * @example
 * ```typescript
 * const turn = new Turn({ sessionId: 'sess1', agentIds: ['agent1', 'agent2'], turnNumber: 1 });
 * turn.addMessage('msg1');
 *
 * const change = turn.recordPairTerminal('msg1', 'agent1', 'completed');
 * // change.turnComplete === false (agent2 still pending)
 *
 * const change2 = turn.recordPairTerminal('msg1', 'agent2', 'completed');
 * // change2.turnComplete === true, change2.result.success === true
 * ```
 */
export class Turn {
  /** Unique turn identifier */
  public readonly turnId: string;

  /** Session this turn belongs to */
  public readonly sessionId: string;

  /** Monotonic per-session ordinal (1-based). */
  public readonly turnNumber: number;

  /** Timestamp when turn was created */
  public readonly startedAt: number;

  /** Origin of this turn, used for loop prevention and audit. */
  private readonly _initiator: Readonly<TurnInitiator>;

  /** Agents participating in this turn (immutable after creation) */
  private readonly _agentIds: readonly string[];

  /** Messages durably admitted during this turn. */
  private readonly _messageIds: string[] = [];

  /** Targeted agents for each admitted message.  This is the authoritative turn ledger. */
  private readonly admittedTargetsByMessageId = new Map<string, ReadonlySet<string>>();

  /** Terminal outcome for each admitted `{messageId, agentId}` pair. */
  private readonly terminalPairs = new Map<string, { outcome: TurnPairTerminalOutcome; error?: string }>();

  /** Message admissions whose append/lifecycle setup has not committed yet. */
  private readonly pendingMessageAdmissions = new Set<string>();

  public constructor(config: TurnConfig) {
    if (!Number.isInteger(config.turnNumber) || config.turnNumber < 1) {
      throw new Error('turnNumber must be a positive integer');
    }
    this.turnId = config.turnId ?? crypto.randomUUID();
    this.sessionId = config.sessionId;
    this.turnNumber = config.turnNumber;
    this.startedAt = config.startedAt ?? Date.now();
    this._initiator = Object.freeze(cloneTurnInitiator(config.initiator ?? { source: 'user' }));
    this._agentIds = Object.freeze([...config.agentIds]);
  }

  // ============================================================================
  // Accessors (read-only views of state)
  // ============================================================================

  /**
   * Agents participating in this turn.
   * @returns Immutable array of agent IDs
   */
  public get agentIds(): readonly string[] {
    return this._agentIds;
  }

  /**
   * Origin of this turn for loop prevention and audit.
   * Returned as a defensive copy to avoid external mutation of internal state.
   * @returns Defensive copy of turn initiator metadata
   */
  public get initiator(): TurnInitiator {
    return cloneTurnInitiator(this._initiator);
  }

  /**
   * Messages sent during this turn.
   * @returns Immutable array of message IDs
   */
  public get messageIds(): readonly string[] {
    return this._messageIds;
  }

  /**
   * Whether a user message has claimed this turn before its storage append completes.
   * @returns True when at least one message append is in-flight
   */
  public get hasPendingMessageAppends(): boolean {
    return this.pendingMessageAdmissions.size > 0;
  }

  // ============================================================================
  // Mutations (return state changes for orchestrator to act on)
  // ============================================================================

  /**
   * Add a message to this turn.
   * @param messageId - The message ID to add
   */
  public addMessage(messageId: string): void {
    this.admitMessage(messageId, this._agentIds);
    this.commitMessageAdmission(messageId);
  }

  /**
   * Claim this turn for a message whose durable append has started.
   * @param messageId - Message ID whose append is in-flight
   */
  public claimMessageAppend(messageId: string): void {
    this.admitMessage(messageId, this._agentIds);
  }

  /**
   * Release a failed message append claim without adding the message.
   * @param messageId - Message ID whose append failed
   */
  public releaseMessageAppend(messageId: string): void {
    this.rollbackMessageAdmission(messageId);
  }

  /**
   * Admit a message and its complete fanout into this turn's immutable ledger.
   * Completion may only terminalize pairs admitted through this method.
   * @param messageId - Stable user-message identity.
   * @param agentIds - Immutable participant subset targeted by this delivery.
   */
  public admitMessage(messageId: string, agentIds: readonly string[]): void {
    if (this.admittedTargetsByMessageId.has(messageId)) {
      throw new Error(`Turn ${this.turnId} already admitted message ${messageId}`);
    }
    if (agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) {
      throw new Error(`Turn ${this.turnId} requires a non-empty unique target set for message ${messageId}`);
    }
    if (agentIds.some((agentId) => !this.hasAgent(agentId))) {
      throw new Error(`Turn ${this.turnId} cannot admit targets outside its immutable participant set`);
    }
    this._messageIds.push(messageId);
    this.admittedTargetsByMessageId.set(messageId, new Set(agentIds));
    this.pendingMessageAdmissions.add(messageId);
  }

  /**
   * Commit a durable pre-dispatch message admission.
   * @param messageId - Admitted message whose setup became durable.
   */
  public commitMessageAdmission(messageId: string): void {
    if (!this.admittedTargetsByMessageId.has(messageId)) {
      throw new Error(`Turn ${this.turnId} cannot commit unknown message ${messageId}`);
    }
    this.pendingMessageAdmissions.delete(messageId);
  }

  /**
   * Roll back an admission whose append or lifecycle setup failed before dispatch.
   * @param messageId - Unrouted message admission to remove.
   */
  public rollbackMessageAdmission(messageId: string): void {
    const targets = this.admittedTargetsByMessageId.get(messageId);
    if (!targets) return;
    if ([...targets].some((agentId) => this.terminalPairs.has(this.pairKey(messageId, agentId)))) {
      throw new Error(`Turn ${this.turnId} cannot roll back terminal message ${messageId}`);
    }
    this.admittedTargetsByMessageId.delete(messageId);
    this.pendingMessageAdmissions.delete(messageId);
    const index = this._messageIds.indexOf(messageId);
    if (index >= 0) this._messageIds.splice(index, 1);
  }

  /**
   * Record one terminal outcome for an admitted delivery pair.
   * @param messageId - Exact admitted message identity.
   * @param agentId - Exact targeted agent identity.
   * @param outcome - Canonical terminal delivery outcome.
   * @param error - Optional provider or routing error.
   * @returns Whether the pair was accepted and completed the turn.
   */
  public recordPairTerminal(
    messageId: string,
    agentId: string,
    outcome: TurnPairTerminalOutcome,
    error?: string,
  ): TurnPairStateChange {
    if (!this.admittedTargetsByMessageId.get(messageId)?.has(agentId)) return { accepted: false, turnComplete: false };
    const key = this.pairKey(messageId, agentId);
    if (this.terminalPairs.has(key)) return { accepted: false, turnComplete: false };
    this.terminalPairs.set(key, { outcome, ...(error !== undefined && { error }) });
    if (!this.isComplete()) return { accepted: true, turnComplete: false };
    return { accepted: true, turnComplete: true, result: this.getResult() };
  }

  /**
   * Whether a concrete admitted delivery pair exists.
   * @param messageId - Message identity to inspect.
   * @param agentId - Agent identity to inspect.
   * @returns Whether the exact delivery pair was admitted.
   */
  public hasAdmittedPair(messageId: string, agentId: string): boolean {
    return this.admittedTargetsByMessageId.get(messageId)?.has(agentId) ?? false;
  }

  /** @returns Snapshot of every admitted delivery pair for barriers and diagnostics. */
  public get admittedPairs(): readonly { messageId: string; agentId: string }[] {
    return [...this.admittedTargetsByMessageId].flatMap(([messageId, targets]) =>
      [...targets].map((agentId) => ({ messageId, agentId })),
    );
  }

  // ============================================================================
  // Queries
  // ============================================================================

  /**
   * Check if an agent is part of this turn.
   * @param agentId - The agent ID to check
   * @returns True if agent is participating in this turn
   */
  public hasAgent(agentId: string): boolean {
    return this._agentIds.includes(agentId);
  }

  /**
   * Check whether every admitted delivery pair reached a terminal outcome.
   * @returns True when the turn has at least one committed admission and all of its pairs are terminal
   */
  public isComplete(): boolean {
    if (this.admittedTargetsByMessageId.size === 0) return false;
    if (this.pendingMessageAdmissions.size > 0) return false;
    for (const [messageId, targets] of this.admittedTargetsByMessageId) {
      for (const agentId of targets) {
        if (!this.terminalPairs.has(this.pairKey(messageId, agentId))) return false;
      }
    }
    return true;
  }

  /**
   * Get the turn result (only meaningful when turn is complete).
   * @returns Turn result with success status and any errors
   */
  public getResult(): TurnResult {
    const errors = [...this.terminalPairs.values()]
      .filter((entry) => entry.outcome === 'error')
      .map((entry) => entry.error ?? 'Unknown error');
    return {
      success: errors.length === 0,
      errors,
    };
  }

  /**
   * Get context for agent dispatch.
   * Used when sending messages to agents for context propagation.
   * @returns Turn context with turnId and current messageId
   * @throws Error if no messages have been added yet
   */
  public getContext(): TurnContext {
    if (this._messageIds.length === 0) {
      throw new Error(`Turn ${this.turnId} has no messages yet`);
    }
    return {
      turnId: this.turnId,
      messageId: this._messageIds[this._messageIds.length - 1],
    };
  }

  /**
   * Get context for a specific message (for events emitted per-message).
   * @param messageId - The message ID to get context for
   * @returns Turn context with turnId and the specified messageId
   */
  public getContextForMessage(messageId: string): TurnContext {
    return {
      turnId: this.turnId,
      messageId,
    };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Return a collision-free in-memory key for a ledger pair.
   * @param messageId - Message component of the pair.
   * @param agentId - Agent component of the pair.
   * @returns Collision-free composite key.
   */
  private pairKey(messageId: string, agentId: string): string {
    return JSON.stringify([messageId, agentId]);
  }
}
