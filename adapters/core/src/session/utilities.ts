/**
 * Manages session lifecycle and abort handling.
 *
 * Provides coordinated abort signal management:
 * - Idempotent abort()
 * - Cleanup hook execution
 * - Termination state tracking
 *
 * ## Design Philosophy
 *
 * SessionLifecycle is a simple composition utility that encapsulates
 * abort signal coordination. It avoids inheritance coupling while providing
 * a clean API for session termination.
 *
 * ## Example Usage
 *
 * ```typescript
 * class MySession {
 *   private lifecycle = new SessionLifecycle();
 *
 *   abort() {
 *     this.lifecycle.abort(() => this.transport.close());
 *   }
 *
 *   async sendMessage(msg: string) {
 *     if (this.lifecycle.isTerminated) {
 *       throw new Error('Session terminated');
 *     }
 *     // ... send logic
 *   }
 *
 *   getAbortSignal(): AbortSignal {
 *     return this.lifecycle.signal;
 *   }
 * }
 * ```
 */
export class SessionLifecycle {
  private readonly abortController: AbortController;
  private terminated = false;

  /**
   * Create a new SessionLifecycle
   * @param abortController - Optional AbortController to use (creates new if not provided)
   */
  public constructor(abortController?: AbortController) {
    this.abortController = abortController ?? new AbortController();
  }

  /**
   * Get abort signal for provider integration
   * @returns The abort signal
   */
  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Get termination state
   * @returns True if session has been terminated
   */
  public get isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * Abort session and run cleanup.
   * Idempotent - safe to call multiple times.
   * @param cleanup - Cleanup function (sync or async)
   */
  public abort(cleanup?: () => void | Promise<void>): void {
    if (this.terminated) return;

    this.terminated = true;
    this.abortController.abort();

    if (cleanup) {
      Promise.resolve(cleanup()).catch((error) => {
        console.error('Error during session cleanup:', error);
      });
    }
  }

  /**
   * Register abort listener
   * @param handler - Callback to invoke when session is aborted
   */
  public onAbort(handler: () => void): void {
    this.abortController.signal.addEventListener('abort', handler);
  }
}
