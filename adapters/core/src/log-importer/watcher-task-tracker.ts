/** Tracks asynchronous watcher work so orchestrators can drain it on shutdown. */
export class WatcherTaskTracker {
  private readonly tasks = new Set<Promise<void>>();

  /**
   * Track a watcher task until it settles.
   * @param task - Promise representing watcher-triggered async work
   */
  public track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => {
      this.tasks.delete(task);
    });
  }

  /** Wait until all tracked tasks, including tasks added while draining, settle. */
  public async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}
