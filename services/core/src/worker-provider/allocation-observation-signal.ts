import type { JobRunId } from '@makaio/contracts';

/** A subscription that snapshots the next notification before each durable read. */
export interface ObservationWatch {
  /** Capture the next notification before reading. */
  changed(): Promise<void>;
  /** Remove the subscription when preparation ends. */
  dispose(): void;
}

/** Host-local wakeups after a durable dispatch observation. Storage remains authoritative. */
export class AllocationObservationSignal {
  private readonly waiters = new Map<JobRunId, Set<() => void>>();

  /**
   * Register before reading the run so a concurrent commit cannot be missed.
   * @param jobRunId - Run being checked.
   * @returns A notification subscription and release operation.
   */
  public watch(jobRunId: JobRunId): ObservationWatch {
    let next = Promise.withResolvers<void>();
    const wake = () => {
      next.resolve();
      next = Promise.withResolvers<void>();
    };
    const group = this.waiters.get(jobRunId) ?? new Set<() => void>();
    this.waiters.set(jobRunId, group);
    group.add(wake);
    return {
      changed: () => next.promise,
      dispose: () => {
        group.delete(wake);
        if (group.size === 0 && this.waiters.get(jobRunId) === group) this.waiters.delete(jobRunId);
      },
    };
  }

  /**
   * Wake current waiters after the storage transaction has committed.
   * @param jobRunId - Run whose dispatch was observed.
   */
  public notify(jobRunId: JobRunId): void {
    const group = this.waiters.get(jobRunId);
    group?.forEach((wake) => wake());
  }
}
