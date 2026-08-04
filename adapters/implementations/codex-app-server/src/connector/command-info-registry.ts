/**
 * Command-execution metadata cache with waiter support.
 *
 * The `item/started` lifecycle path populates command metadata, while approval
 * handling may need it before that notification has been processed. This
 * registry pairs the cache with one-shot waiters so approval callers can block
 * briefly for late metadata instead of failing on the race.
 * @packageDocumentation
 */

/** Command execution metadata captured from `item/started`. */
export interface CommandInfo {
  /** Command line the provider is about to execute. */
  command: string;
  /** Working directory of the execution. */
  cwd: string;
}

/**
 * Cache of command execution metadata by item ID, with bounded waiting.
 */
export class CommandInfoRegistry {
  /**
   * Metadata by item ID. Exposed as the raw map because the notification and
   * server-request handler contexts consume it directly.
   */
  public readonly byItemId = new Map<string, CommandInfo>();

  /** Pending resolvers for {@link waitFor}, keyed by itemId. */
  private readonly waiters = new Map<string, (info: CommandInfo) => void>();

  /**
   * Resolve any pending {@link waitFor} promise for `itemId`.
   * Called by the `item/started` lifecycle path after populating {@link byItemId}.
   * @param itemId - Item now available in the cache
   * @param info - Command execution metadata just written to the cache
   */
  public notifyReady(itemId: string, info: CommandInfo): void {
    const resolve = this.waiters.get(itemId);
    if (resolve) {
      this.waiters.delete(itemId);
      resolve(info);
    }
  }

  /**
   * Return the cached entry for `itemId` immediately if present, otherwise
   * wait up to 5 seconds for `item/started` to populate it.
   * Returns `undefined` on timeout so callers can degrade gracefully.
   * @param itemId - Item ID to wait for
   * @returns Command execution metadata, or `undefined` on timeout
   */
  public waitFor(itemId: string): Promise<CommandInfo | undefined> {
    const existing = this.byItemId.get(itemId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(itemId);
        resolve(undefined);
      }, 5000);
      this.waiters.set(itemId, (info) => {
        clearTimeout(timeout);
        resolve(info);
      });
    });
  }
}
