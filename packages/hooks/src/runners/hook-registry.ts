/**
 * Generic priority-sorted hook registry.
 *
 * Provides register/unregister/reset/iterate for hook entries
 * sorted by priority (higher first). Both PreUserMessage and
 * PostUserMessage runners share this core bookkeeping.
 * @typeParam TContext - Hook context type
 * @typeParam TOptions - Hook options type
 */

/**
 * A registered hook entry.
 * @typeParam TContext - Hook context type
 * @typeParam TOptions - Hook options type
 */
export interface HookEntry<TContext, TOptions> {
  /** Hook name for error attribution */
  name: string;
  /** Hook handler function */
  handler: (ctx: TContext) => void | Promise<void>;
  /** Execution priority (higher runs first) */
  priority: number;
  /** Hook-specific configuration */
  options: TOptions;
}

/**
 * Priority-sorted registry for hook entries.
 * @typeParam TContext - Hook context type
 * @typeParam TOptions - Hook options type
 */
export class HookRegistry<TContext, TOptions> {
  private readonly entries: Array<HookEntry<TContext, TOptions>> = [];

  /**
   * Register a hook entry, maintaining priority sort order.
   * @param name - Hook name for error attribution
   * @param handler - Hook handler function
   * @param options - Hook configuration options
   * @param priority - Handler priority (higher runs first, default: 0)
   * @returns Unsubscribe function
   */
  public register(
    name: string,
    handler: (ctx: TContext) => void | Promise<void>,
    options: TOptions,
    priority = 0,
  ): () => void {
    const entry: HookEntry<TContext, TOptions> = { name, handler, priority, options };
    this.entries.push(entry);
    this.entries.sort((a, b) => b.priority - a.priority);

    return () => {
      const idx = this.entries.indexOf(entry);
      if (idx !== -1) this.entries.splice(idx, 1);
    };
  }

  /**
   * Remove all registered hooks. For testing only.
   */
  public reset(): void {
    this.entries.length = 0;
  }

  /**
   * Iterate over registered hooks in priority order.
   * @returns Iterable of hook entries
   */
  public [Symbol.iterator](): IterableIterator<HookEntry<TContext, TOptions>> {
    return this.entries[Symbol.iterator]();
  }
}
