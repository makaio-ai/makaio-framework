import { AsyncLocalStorage } from 'node:async_hooks';
import { JournalError } from '@makaio/contracts';
import type { ExtensionName } from '@makaio/core';
import type { JournalStartGate } from '@makaio/services-core/journal';

/** Allow slow extension startup while bounding delivery waits in a startup cycle. */
const DEFAULT_JOURNAL_STARTUP_WAIT_TIMEOUT_MS = 30_000;

/** Gates inbound deliveries and identifies work running in an extension's startup. */
export class JournalStartBarrier implements JournalStartGate {
  private readonly startup = new AsyncLocalStorage<{ extension: ExtensionName; running: boolean }>();
  private waiters: Set<() => void> | undefined = new Set();
  private closed?: { reason: unknown };

  /**
   * @param waitTimeoutMs - Maximum time in milliseconds that each delivery waits for startup.
   */
  public constructor(private readonly waitTimeoutMs = DEFAULT_JOURNAL_STARTUP_WAIT_TIMEOUT_MS) {
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 2_147_483_647) {
      throw new RangeError('journalStartupWaitTimeoutMs must be an integer from 1 to 2147483647.');
    }
  }

  /** Allow inbound deliveries after all extensions have started. */
  public open(): void {
    this.releaseWaiters();
  }

  /** Wake and detach all deliveries waiting for the gate to settle. */
  private releaseWaiters(): void {
    const waiters = this.waiters;
    this.waiters = undefined;
    waiters?.forEach((resolve) => resolve());
  }

  /**
   * Reject pending and future deliveries when the host stops.
   * @param reason - Failure or shutdown reason delivered to waiting callers.
   */
  public close(reason: unknown): void {
    this.closed ??= { reason };
    this.releaseWaiters();
  }

  /**
   * Wait for startup, checking for shutdown before admitting the delivery.
   * @throws JournalError with code `accept-startup-timeout` if startup remains pending.
   */
  public async awaitOpen(): Promise<void> {
    // Yield even after opening so a shutdown in the same turn can close admission.
    await this.waitForStartup();
    if (this.closed !== undefined) throw this.closed.reason;
  }

  /**
   * Subscribe to startup completion only for the duration of this wait.
   * @returns The pending startup wait, if startup is still in progress.
   */
  private waitForStartup(): Promise<void> | undefined {
    const waiters = this.waiters;
    if (waiters === undefined) return;
    const waiter = Promise.withResolvers<void>();
    waiters.add(waiter.resolve);
    const timer = setTimeout(() => {
      waiter.reject(
        new JournalError(
          'accept-startup-timeout',
          `Journal delivery waited ${this.waitTimeoutMs} ms for host startup.`,
        ),
      );
    }, this.waitTimeoutMs);
    return waiter.promise.finally(() => {
      clearTimeout(timer);
      waiters.delete(waiter.resolve);
    });
  }

  /**
   * Check whether this asynchronous execution belongs to the owner's unfinished startup.
   * @param extension - Owner of the inbound edge.
   * @returns Whether this execution is in that extension's running startup.
   */
  public isOwnStartRunning(extension: ExtensionName): boolean {
    const scope = this.startup.getStore();
    return scope?.extension === extension && scope.running;
  }

  /**
   * Track the extension's startup until its returned promise settles.
   * @param extension - Extension being started.
   * @param start - Startup operation to run in the scope.
   * @returns The result of startup.
   */
  public async runInStartScope<T>(extension: ExtensionName, start: () => Promise<T>): Promise<T> {
    const scope = { extension, running: true };
    try {
      return await this.startup.run(scope, start);
    } finally {
      scope.running = false;
    }
  }
}
