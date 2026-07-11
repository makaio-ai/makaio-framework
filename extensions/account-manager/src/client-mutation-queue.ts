/** Serializes multi-step account mutations independently for each client. */
export class ClientMutationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  /**
   * Run one workflow after the client's previous mutation settles.
   * @param clientId - Client whose mutation queue should be used.
   * @param action - Workflow to run exclusively for that client.
   * @returns The workflow result.
   */
  public async run<T>(clientId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(clientId) ?? Promise.resolve();
    const run = previous.then(action, action);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(clientId, settled);
    try {
      return await run;
    } finally {
      if (this.pending.get(clientId) === settled) this.pending.delete(clientId);
    }
  }
}
