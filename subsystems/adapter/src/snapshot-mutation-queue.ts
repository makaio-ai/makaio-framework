/**
 * Serializes adapter-subsystem snapshot mutations.
 *
 * Snapshot writes must clone, modify, persist, and publish while no other
 * mutation can derive from the same previous snapshot.
 */
export class SnapshotMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run one snapshot mutation after all earlier mutations settle.
   * @param operation - Mutation operation to execute exclusively.
   * @returns Operation result.
   */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}
