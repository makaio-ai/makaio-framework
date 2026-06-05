/**
 * Cross-execution session index.
 *
 * Tracks the mapping from agent session IDs to the (execution, frame) pair
 * that spawned them. Used by the {@link SpanCollector} to re-parent buffered
 * agent usage events when `frame.sessionLinked` arrives.
 * @packageDocumentation
 */

/**
 * A resolved link between a session and the workflow frame that spawned it.
 */
export interface SessionLink {
  /** Workflow execution that owns this session. */
  readonly executionId: string;
  /** Frame within the execution that spawned this session. */
  readonly frameId: string;
}

/**
 * Maintains an in-memory map from session IDs to their execution/frame origin.
 *
 * `link` and `lookup` are O(1). `evictExecution` is O(n) where n is the total
 * number of tracked sessions, bounded by the number of open executions times
 * the maximum sessions per execution.
 */
export class SessionIndex {
  private readonly links = new Map<string, SessionLink>();

  /**
   * Records a session-to-frame link.
   *
   * Overwrites any existing entry for the same `sessionId`.
   * @param sessionId - Agent session identifier to register.
   * @param executionId - Workflow execution that owns the session.
   * @param frameId - Frame within the execution that spawned the session.
   */
  public link(sessionId: string, executionId: string, frameId: string): void {
    this.links.set(sessionId, { executionId, frameId });
  }

  /**
   * Returns the link for `sessionId`, or `undefined` when not registered.
   * @param sessionId - Agent session identifier to look up.
   * @returns The {@link SessionLink} for the session, or `undefined` when absent.
   */
  public lookup(sessionId: string): SessionLink | undefined {
    return this.links.get(sessionId);
  }

  /**
   * Removes all session links belonging to `executionId`.
   *
   * Called when an execution reaches a terminal state so that sessions from
   * completed executions do not linger in memory.
   * @param executionId - Workflow execution whose sessions should be evicted.
   */
  public evictExecution(executionId: string): void {
    for (const [sessionId, link] of this.links) {
      if (link.executionId === executionId) {
        this.links.delete(sessionId);
      }
    }
  }
}
