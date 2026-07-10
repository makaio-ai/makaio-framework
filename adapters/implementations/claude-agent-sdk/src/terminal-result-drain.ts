import { DeferredPromise } from '@makaio/utils';
import { TERMINAL_RESULT_DRAIN_TIMEOUT_MS } from '@makaio/ai-adapters-claude-shared';

/** Coordinates the bounded terminal-result window used during query teardown. */
export class TerminalResultDrain {
  private active?: { queryGeneration: number; deferred: DeferredPromise<void> };
  private handledGeneration?: number;

  /**
   * Open a terminal-result window for a query generation.
   * @param queryGeneration - Generation that still owns the SDK query.
   * @returns Whether a terminal result arrived before the timeout.
   */
  public async waitForResult(queryGeneration: number): Promise<boolean> {
    const drain = { queryGeneration, deferred: new DeferredPromise<void>() };
    this.active = drain;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        drain.deferred.getPromise().then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), TERMINAL_RESULT_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.active === drain) this.active = undefined;
    }
  }

  /**
   * Report a terminal result after it has been emitted and routed.
   * @param queryGeneration - Generation that produced the result.
   */
  public markHandled(queryGeneration: number): void {
    if (this.active?.queryGeneration !== queryGeneration) return;
    this.handledGeneration = queryGeneration;
    this.active.deferred.resolve(undefined);
  }

  /**
   * Release the drain and retire the generation in a single call.
   *
   * Resolves any pending drain deferred and marks the generation as handled
   * so {@link hasHandled} returns true even when no SDK result was received.
   * Used by the error-completion path to prevent late results from being
   * accepted while async teardown (completion transforms, onTurnComplete,
   * finishOnError) is in progress.
   * @param queryGeneration - Generation whose iterator failed or is being torn down.
   */
  public forceClose(queryGeneration: number): void {
    if (this.active?.queryGeneration === queryGeneration) {
      this.active.deferred.resolve(undefined);
    }
    this.handledGeneration = queryGeneration;
  }

  /**
   * Check whether this generation already emitted its terminal result or was
   * retired by the error-completion path.
   * @param queryGeneration - Generation to check.
   * @returns Whether a terminal result was already routed or the generation was retired.
   */
  public hasHandled(queryGeneration: number): boolean {
    return this.handledGeneration === queryGeneration;
  }
}
