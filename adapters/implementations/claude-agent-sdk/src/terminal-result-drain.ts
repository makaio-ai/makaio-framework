import { DeferredPromise } from '@makaio/utils';

const TERMINAL_RESULT_DRAIN_TIMEOUT_MS = 250;

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
   * Release a pending drain when the query iterator fails before a result.
   * @param queryGeneration - Generation whose iterator failed.
   */
  public resolve(queryGeneration: number): void {
    if (this.active?.queryGeneration === queryGeneration) {
      this.active.deferred.resolve(undefined);
    }
  }

  /**
   * Check whether this generation already emitted its terminal result.
   * @param queryGeneration - Generation to check.
   * @returns Whether a terminal result was already routed.
   */
  public hasHandled(queryGeneration: number): boolean {
    return this.handledGeneration === queryGeneration;
  }
}
