/**
 * Serialize every operation that can observe or replace an agent connector.
 *
 * One instance belongs to one {@link AIAgent}. Callers keep the lock across the
 * complete read-decide-mutate/publish boundary so two operations can never both
 * take ownership of the same connector generation.
 */
export class AgentRuntimeMutationBarrier {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run one connector-affecting operation after all earlier operations settle.
   * @param action - Complete mutation or turn-dispatch boundary to serialize
   * @returns Action result
   */
  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await action();
    } finally {
      // A timeout here would let the next operation race work that is still
      // mutating the current connector, so exclusivity ends only on settlement.
      release?.();
    }
  }
}
