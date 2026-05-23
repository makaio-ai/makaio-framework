import type { SubagentConstraints, SubagentStatus, SubagentConfig } from '@makaio/contracts';
import { SubagentError, SubagentErrorCode } from '@makaio/contracts';
import { RingBuffer } from '../utils/ring-buffer.js';
import type { TrackedSubagent, InternalPendingRequest, AwaitResult } from './types.js';

/** Terminal states where subagent is no longer active */
const TERMINAL_STATES: SubagentStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Check whether a status is terminal (completed, failed, or cancelled).
 * @param status - Subagent status to check
 * @returns true if the status is terminal
 */
function isTerminal(status: SubagentStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/** Default size for progress update ring buffer */
const PROGRESS_BUFFER_SIZE = 50;

/**
 * Options for tracking a new subagent.
 */
export interface TrackOptions {
  /** Unique identifier for the subagent */
  subagentId: string;
  /** Parent session that spawned this subagent */
  parentSessionId: string;
  /** Configuration used to spawn this subagent */
  config: SubagentConfig;
  /** Nesting depth in subagent hierarchy */
  depth: number;
}

/**
 * Manages tracked subagent state.
 *
 * Similar pattern to ShellManager - tracks active subagents, handles lifecycle.
 * Responsible for:
 * - Tracking subagent state
 * - Managing pending request_input
 * - Coordinating awaiters for completion
 * - Cleanup of stale completed subagents
 */
export class SubagentManager {
  private subagents = new Map<string, TrackedSubagent>();
  private awaiters = new Map<string, Array<(result: AwaitResult) => void>>();

  public constructor(public readonly constraints: SubagentConstraints) {}

  /**
   * Track a new subagent.
   * childSessionId is set later by SubagentService after session creation.
   * @param options - Tracking options
   * @returns The tracked subagent state
   */
  public track(options: TrackOptions): TrackedSubagent {
    const now = Date.now();
    const tracked: TrackedSubagent = {
      subagentId: options.subagentId,
      parentSessionId: options.parentSessionId,
      childSessionId: undefined, // Set by SubagentService after session creation
      status: 'spawning',
      config: options.config,
      depth: options.depth,
      progressUpdates: new RingBuffer<string>(PROGRESS_BUFFER_SIZE),
      startTime: now,
      lastActivityAt: now,
    };
    this.subagents.set(options.subagentId, tracked);
    return tracked;
  }

  /**
   * Set the child session ID after session creation.
   * Called by SubagentService after creating the session.
   * @param subagentId - ID of the subagent
   * @param childSessionId - Session ID created by session service
   */
  public setChildSessionId(subagentId: string, childSessionId: string): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;
    subagent.childSessionId = childSessionId;
    subagent.lastActivityAt = Date.now();
    if (subagent.status === 'spawning') {
      subagent.status = 'running';
    }
  }

  /**
   * Get tracked subagent by ID.
   * @param subagentId - ID of the subagent
   * @returns The tracked subagent, or undefined if not found
   */
  public get(subagentId: string): TrackedSubagent | undefined {
    return this.subagents.get(subagentId);
  }

  /**
   * Return all non-terminal subagents as an array.
   *
   * Non-terminal means any status not in `TERMINAL_STATES` (`completed`, `failed`, `cancelled`).
   * This includes `'hung'`, so results (and derived counts from `countActiveBySession`
   * and `countTotalActive`) represent "not terminal" rather than "currently doing useful work".
   *
   * Used for lookups that need to scan active state (e.g. session close detection).
   * @returns Array of tracked subagents not yet in a terminal state
   */
  public getAllNonTerminal(): TrackedSubagent[] {
    const result: TrackedSubagent[] = [];
    for (const subagent of this.subagents.values()) {
      if (!isTerminal(subagent.status)) {
        result.push(subagent);
      }
    }
    return result;
  }

  /**
   * Count non-terminal subagents for a parent session.
   *
   * Includes `'hung'` because `'hung'` is not part of `TERMINAL_STATES`.
   * @param parentSessionId - Parent session ID
   * @returns Count of non-terminal subagents
   */
  public countActiveBySession(parentSessionId: string): number {
    let count = 0;
    for (const subagent of this.subagents.values()) {
      if (subagent.parentSessionId === parentSessionId && !isTerminal(subagent.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Count total non-terminal subagents across all sessions.
   *
   * Includes `'hung'` because `'hung'` is not part of `TERMINAL_STATES`.
   * @returns Total count of non-terminal subagents
   */
  public countTotalActive(): number {
    let count = 0;
    for (const subagent of this.subagents.values()) {
      if (!isTerminal(subagent.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Update subagent status.
   * Sets endTime if transitioning to a terminal state.
   * @param subagentId - ID of the subagent
   * @param status - New status
   */
  public updateStatus(subagentId: string, status: SubagentStatus): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;

    const now = Date.now();
    subagent.status = status;
    subagent.lastActivityAt = now;
    if (isTerminal(status)) {
      subagent.endTime = now;
    }
  }

  /**
   * Add a progress update to the subagent's ring buffer.
   * @param subagentId - ID of the subagent
   * @param update - Progress update message
   */
  public addProgress(subagentId: string, update: string): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;
    subagent.progressUpdates.push(update);
    subagent.lastActivityAt = Date.now();
  }

  /**
   * Set pending request (enforces single-request invariant).
   * @param subagentId - ID of the subagent
   * @param request - The pending request with resolver
   * @throws SubagentError if subagent not found or request already pending
   */
  public setPendingRequest(subagentId: string, request: InternalPendingRequest): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) {
      throw new SubagentError(SubagentErrorCode.NOT_FOUND, `Subagent ${subagentId} not found`);
    }
    if (subagent.pendingRequest) {
      throw new SubagentError(
        SubagentErrorCode.REQUEST_PENDING,
        'Cannot call request_input while another request is pending',
      );
    }
    subagent.pendingRequest = request;
    subagent.status = 'waiting_input';
    subagent.lastActivityAt = Date.now();
  }

  /**
   * Resolve pending request with response.
   * @param subagentId - ID of the subagent
   * @param response - Response string, or null if timed out/cancelled
   */
  public resolvePendingRequest(subagentId: string, response: string | null): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent?.pendingRequest) return;

    subagent.pendingRequest.resolver(response);
    subagent.pendingRequest = undefined;
    subagent.lastActivityAt = Date.now();
    if (subagent.status === 'waiting_input') {
      subagent.status = 'running';
    }
  }

  /**
   * Mark subagent as completed.
   * @param subagentId - ID of the subagent
   * @param result - Result string
   * @param summary - Optional summary of the result
   * @throws SubagentError if subagent not found or already in terminal state
   */
  public markCompleted(subagentId: string, result: string, summary?: string): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) {
      throw new SubagentError(SubagentErrorCode.NOT_FOUND, `Subagent ${subagentId} not found`);
    }
    if (isTerminal(subagent.status)) {
      throw new SubagentError(
        SubagentErrorCode.ALREADY_TERMINAL,
        `Subagent already in terminal state: ${subagent.status}`,
      );
    }

    const now = Date.now();
    subagent.status = 'completed';
    subagent.result = result;
    subagent.summary = summary;
    subagent.endTime = now;
    subagent.lastActivityAt = now;
    this.resolveAwaiters(subagentId);
  }

  /**
   * Mark subagent as failed.
   * Does nothing if subagent not found or already in a terminal state.
   * @param subagentId - ID of the subagent
   * @param error - Error message
   */
  public markFailed(subagentId: string, error: string): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent || isTerminal(subagent.status)) return;

    const now = Date.now();
    subagent.status = 'failed';
    subagent.error = error;
    subagent.endTime = now;
    subagent.lastActivityAt = now;
    this.resolveAwaiters(subagentId);
  }

  /**
   * Mark subagent as cancelled.
   * Resolves any pending request with null.
   * @param subagentId - ID of the subagent
   * @returns true if cancelled, false if not found or already terminal
   */
  public markCancelled(subagentId: string): boolean {
    const subagent = this.subagents.get(subagentId);
    if (!subagent || isTerminal(subagent.status)) {
      return false;
    }

    const now = Date.now();
    subagent.status = 'cancelled';
    subagent.endTime = now;
    subagent.lastActivityAt = now;

    // Cancel pending request
    if (subagent.pendingRequest) {
      subagent.pendingRequest.resolver(null);
      subagent.pendingRequest = undefined;
    }

    this.resolveAwaiters(subagentId);
    return true;
  }

  /**
   * Register an awaiter callback for subagent completion.
   * @param subagentId - ID of the subagent
   * @param callback - Callback to invoke when subagent reaches terminal state
   */
  public addAwaiter(subagentId: string, callback: (result: AwaitResult) => void): void {
    const existing = this.awaiters.get(subagentId) ?? [];
    existing.push(callback);
    this.awaiters.set(subagentId, existing);
  }

  /**
   * Remove an awaiter callback for a subagent.
   * Used for cleanup when await times out before subagent reaches terminal state.
   * @param subagentId - ID of the subagent
   * @param callback - The callback to remove
   * @returns true if the callback was found and removed
   */
  public removeAwaiter(subagentId: string, callback: (result: AwaitResult) => void): boolean {
    const awaiters = this.awaiters.get(subagentId);
    if (!awaiters) return false;

    const index = awaiters.indexOf(callback);
    if (index === -1) return false;

    awaiters.splice(index, 1);
    if (awaiters.length === 0) {
      this.awaiters.delete(subagentId);
    }
    return true;
  }

  /**
   * Resolve all awaiters for a subagent.
   * @param subagentId - ID of the subagent
   */
  private resolveAwaiters(subagentId: string): void {
    const subagent = this.subagents.get(subagentId);
    const awaiters = this.awaiters.get(subagentId);
    if (!awaiters || !subagent) return;

    const result: AwaitResult = {
      status: subagent.status as AwaitResult['status'],
      result: subagent.result,
      error: subagent.error,
    };

    for (const callback of awaiters) {
      callback(result);
    }
    this.awaiters.delete(subagentId);
  }

  /**
   * Cleanup old completed subagents based on retention TTL.
   * @returns Number of subagents cleaned up
   */
  public cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, subagent] of this.subagents) {
      if (isTerminal(subagent.status) && subagent.endTime) {
        const age = now - subagent.endTime;
        if (age > this.constraints.stateRetentionMs) {
          this.subagents.delete(id);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /**
   * Sweep for hung subagents that have had no state activity within the timeout window.
   *
   * Transitions `spawning` and `running` subagents to `'hung'` (non-terminal).
   * `waiting_input` subagents are skipped — `request_input` owns their timeout.
   * Already-hung subagents are also skipped to avoid redundant transitions.
   *
   * The coordinator observes `'hung'` via `getStatus` and decides whether to kill
   * and retry or abort. Awaiters are NOT resolved — `'hung'` is non-terminal.
   *
   * When `inactivityTimeoutMs` is less than or equal to 0 this is a no-op (sweep is opt-in).
   * @param inactivityTimeoutMs - Inactivity threshold in milliseconds. Values less than or equal to 0 disable sweep.
   * @returns Number of subagents transitioned to `'hung'`
   */
  public sweepHung(inactivityTimeoutMs: number): number {
    if (inactivityTimeoutMs <= 0) return 0;

    const now = Date.now();
    let swept = 0;

    for (const subagent of this.subagents.values()) {
      if (isTerminal(subagent.status)) continue;

      // Skip subagents legitimately waiting for parent input —
      // request_input has its own timeout (defaultRequestTimeoutMs).
      if (subagent.status === 'waiting_input') continue;

      // Skip already-hung subagents — avoid redundant transitions.
      if (subagent.status === 'hung') continue;

      const idle = now - subagent.lastActivityAt;
      if (idle >= inactivityTimeoutMs) {
        subagent.status = 'hung';
        subagent.lastActivityAt = now;
        swept++;
      }
    }

    return swept;
  }
}
