import Piscina from 'piscina';
import type { TransferListItem } from 'node:worker_threads';

/**
 * Shared Piscina pool configuration for isolated workflow execution.
 */
export interface PiscinaPoolRunnerOptions {
  /** Absolute path to the worker entrypoint file. */
  readonly workerEntry: string;
  /** Maximum concurrent worker threads. @defaultValue 4 */
  readonly maxConcurrency?: number;
  /** Idle timeout before threads are reaped (ms). @defaultValue 30000 */
  readonly idleTimeoutMs?: number;
}

/**
 * Internal typed wrapper around a Piscina worker-thread pool.
 *
 * Centralizes the pool defaults and abort wiring for workflow-level Piscina
 * runners.
 * @typeParam TTask - Serializable task payload sent to the worker entrypoint.
 * @typeParam TResult - Serializable result returned by the worker entrypoint.
 */
export class PiscinaPoolRunner<TTask, TResult> {
  private readonly pool: Piscina;

  /**
   * @param options - Piscina pool configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(options: PiscinaPoolRunnerOptions) {
    this.pool = new Piscina({
      filename: options.workerEntry,
      maxThreads: options.maxConcurrency ?? 4,
      idleTimeout: options.idleTimeoutMs ?? 30_000,
    });
  }

  /**
   * Dispatch a task to the worker-thread pool.
   *
   * Piscina's `signal` option is the worker-thread cancellation path: when a
   * task is already running, Piscina stops that Worker. AbortSignal itself is
   * not structured-cloneable into the task payload, so worker entrypoints also
   * subscribe to bus cancellation subjects for cooperative in-task shutdown.
   * @param task - Serializable task payload for the worker entrypoint.
   * @param signal - Abort signal forwarded to Piscina task cancellation.
   * @param transferList - Task-owned transferable resources passed to the worker.
   * @returns Result returned by the worker entrypoint.
   */
  public async run(task: TTask, signal: AbortSignal, transferList?: TransferListItem[]): Promise<TResult> {
    return this.pool.run(task, { signal, transferList }) as Promise<TResult>;
  }

  /**
   * Subscribe to worker-thread messages emitted through Piscina.
   * @param listener - Callback invoked for each worker message.
   * @returns Cleanup callback that removes the listener.
   */
  public onMessage(listener: (message: unknown) => void): () => void {
    this.pool.on('message', listener);
    return () => this.pool.off('message', listener);
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool.destroy();
  }
}
