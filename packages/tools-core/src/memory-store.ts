/**
 * Generic memory store for managing working memory instances across sessions.
 *
 * Provides session-keyed isolation for state when tool instances are
 * singleton in the registry.
 *
 * Type Parameters:
 * - T: The working memory class type
 * - TArgs: Constructor arguments for the working memory class
 * @example
 * ```typescript
 * class MyMemoryStore extends MemoryStore<MyWorkingMemory, [string]> {
 *   constructor() {
 *     super((sessionId) => new MyWorkingMemory(sessionId));
 *   }
 * }
 *
 * const store = new MyMemoryStore();
 * const memory = store.get('session-123');
 * store.delete('session-123');
 * ```
 */
export class MemoryStore<T, TArgs extends unknown[]> {
  private sessions = new Map<string, T>();

  /**
   * Creates a new memory store.
   * @param factory - Factory function to create new memory instances
   */
  public constructor(private factory: (sessionId: string, ...args: TArgs) => T) {}

  /**
   * Gets or creates working memory for a session.
   * Returns the same instance for the same sessionId.
   * @param sessionId - Session identifier
   * @param args - Additional arguments passed to the factory
   * @returns Working memory instance for the session
   */
  public get(sessionId: string, ...args: TArgs): T {
    let memory = this.sessions.get(sessionId);
    if (!memory) {
      memory = this.factory(sessionId, ...args);
      this.sessions.set(sessionId, memory);
    }
    return memory;
  }

  /**
   * Checks if a session has working memory.
   * @param sessionId - Session identifier
   * @returns true if session exists
   */
  public has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Deletes session memory (for cleanup on session close).
   * @param sessionId - Session identifier
   * @returns true if deleted, false if not found
   */
  public delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Iterates over all session memories.
   * @returns Iterator of [sessionId, memory] pairs
   */
  public entries(): IterableIterator<[string, T]> {
    return this.sessions.entries();
  }

  /**
   * Returns all session IDs with active memory.
   * @returns Array of session IDs
   */
  public sessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Returns the number of sessions with active memory.
   * @returns Session count
   */
  public get size(): number {
    return this.sessions.size;
  }
}
