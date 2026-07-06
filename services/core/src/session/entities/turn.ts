import type { TurnInitiator } from '@makaio/contracts';

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

/** Terminal outcome stored for one agent in a turn. */
type AgentTerminalOutcome = 'completed' | 'errored';

/**
 * State change returned by Turn mutation methods.
 * Orchestrator uses this to decide whether to emit turn.completed.
 */
export type TurnStateChange = { turnComplete: false } | { turnComplete: true; result: TurnResult };

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
 * const turn = new Turn({ sessionId: 'sess1', agentIds: ['agent1', 'agent2'] });
 * turn.addMessage('msg1');
 *
 * const change = turn.markAgentCompleted('agent1');
 * // change.turnComplete === false (agent2 still pending)
 *
 * const change2 = turn.markAgentCompleted('agent2');
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

  /** Messages sent during this turn */
  private readonly _messageIds: string[] = [];

  /** Message IDs currently claiming this turn while their storage append is in-flight. */
  private readonly _pendingMessageAppends = new Set<string>();

  /** Agents that have completed successfully */
  private readonly _completedAgents = new Set<string>();

  /** Agents that errored (agentId → error message) */
  private readonly _erroredAgents = new Map<string, string>();

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
    return this._pendingMessageAppends.size > 0;
  }

  /**
   * Agents that have completed successfully.
   * @returns Read-only set of completed agent IDs
   */
  public get completedAgents(): ReadonlySet<string> {
    return this._completedAgents;
  }

  /**
   * Agents that errored.
   * @returns Read-only map of agent ID to error message
   */
  public get erroredAgents(): ReadonlyMap<string, string> {
    return this._erroredAgents;
  }

  // ============================================================================
  // Mutations (return state changes for orchestrator to act on)
  // ============================================================================

  /**
   * Add a message to this turn.
   * @param messageId - The message ID to add
   */
  public addMessage(messageId: string): void {
    this._pendingMessageAppends.delete(messageId);
    this._messageIds.push(messageId);
  }

  /**
   * Claim this turn for a message whose durable append has started.
   * @param messageId - Message ID whose append is in-flight
   */
  public claimMessageAppend(messageId: string): void {
    this._pendingMessageAppends.add(messageId);
  }

  /**
   * Release a failed message append claim without adding the message.
   * @param messageId - Message ID whose append failed
   */
  public releaseMessageAppend(messageId: string): void {
    this._pendingMessageAppends.delete(messageId);
  }

  /**
   * Mark an agent as completed successfully.
   * @param agentId - The agent that completed
   * @returns State change indicating if turn is now complete
   */
  public markAgentCompleted(agentId: string): TurnStateChange {
    if (this.getAgentTerminalOutcome(agentId) !== undefined) {
      return { turnComplete: false };
    }
    this._completedAgents.add(agentId);
    return this.checkCompletion();
  }

  /**
   * Mark an agent as errored.
   * @param agentId - The agent that errored
   * @param error - Error message
   * @returns State change indicating if turn is now complete
   */
  public markAgentErrored(agentId: string, error: string): TurnStateChange {
    if (this.getAgentTerminalOutcome(agentId) !== undefined) {
      return { turnComplete: false };
    }
    this._erroredAgents.set(agentId, error);
    return this.checkCompletion();
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
   * Check if the turn is complete (all agents finished).
   * @returns True if all agents have completed or errored
   */
  public isComplete(): boolean {
    const completedCount = new Set([...this._completedAgents, ...this._erroredAgents.keys()]).size;
    return completedCount >= this._agentIds.length;
  }

  /**
   * Get the turn result (only meaningful when turn is complete).
   * @returns Turn result with success status and any errors
   */
  public getResult(): TurnResult {
    return {
      success: this._erroredAgents.size === 0,
      errors: Array.from(this._erroredAgents.values()),
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
   * Return the recorded terminal outcome for an agent, if any.
   * @param agentId - Agent ID to inspect.
   * @returns Terminal outcome already recorded for the agent.
   */
  private getAgentTerminalOutcome(agentId: string): AgentTerminalOutcome | undefined {
    if (this._completedAgents.has(agentId)) return 'completed';
    if (this._erroredAgents.has(agentId)) return 'errored';
    return undefined;
  }

  /**
   * Check if turn should complete and return appropriate state change.
   * @returns State change indicating completion status and result if complete
   */
  private checkCompletion(): TurnStateChange {
    if (this.isComplete()) {
      return { turnComplete: true, result: this.getResult() };
    }
    return { turnComplete: false };
  }
}
