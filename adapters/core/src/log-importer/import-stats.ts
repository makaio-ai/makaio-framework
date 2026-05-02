const PROGRESS_LOG_EVENT_COUNT = 1000;

/**
 * Tracks and logs log-import progress without coupling stats bookkeeping to
 * file parsing or cursor persistence.
 */
export class LogImportStats {
  private filesProcessed = 0;
  private eventsEmitted = 0;
  private readonly sessionsImported = new Set<string>();
  private readonly sessionsSkipped = new Set<string>();
  private lastLoggedEventCount = 0;
  private lastLoggedSnapshot = '';

  public reset(): void {
    this.filesProcessed = 0;
    this.eventsEmitted = 0;
    this.sessionsImported.clear();
    this.sessionsSkipped.clear();
    this.lastLoggedEventCount = 0;
    this.lastLoggedSnapshot = '';
  }

  public recordFileProcessed(): void {
    this.filesProcessed++;
  }

  public recordEventEmitted(logPrefix: string): void {
    this.eventsEmitted++;
    const eventsSinceLastLog = this.eventsEmitted - this.lastLoggedEventCount;
    if (eventsSinceLastLog < PROGRESS_LOG_EVENT_COUNT) {
      return;
    }
    console.info(`${logPrefix} Imported ${this.eventsEmitted} events (${this.sessionsImported.size} sessions)...`);
    this.lastLoggedEventCount = this.eventsEmitted;
  }

  public recordSessionImported(adapterSessionId: string): void {
    this.sessionsImported.add(adapterSessionId);
  }

  public recordSessionSkipped(adapterSessionId: string): void {
    this.sessionsSkipped.add(adapterSessionId);
  }

  public hasActivity(): boolean {
    return this.eventsEmitted > 0 || this.filesProcessed > 0;
  }

  public stoppedMessage(logPrefix: string): string {
    return `${logPrefix} Stopped - ${this.eventsEmitted} events from ${this.sessionsImported.size} sessions (${this.sessionsSkipped.size} skipped)`;
  }

  public logProgress(logPrefix: string): void {
    if (!this.hasActivity()) {
      return;
    }
    const snapshot = JSON.stringify({
      eventsEmitted: this.eventsEmitted,
      filesProcessed: this.filesProcessed,
      sessionsImported: this.sessionsImported.size,
      sessionsSkipped: this.sessionsSkipped.size,
    });
    if (snapshot === this.lastLoggedSnapshot) {
      return;
    }
    this.lastLoggedSnapshot = snapshot;
    console.info(
      `${logPrefix} Progress: ${this.eventsEmitted} events, ` +
        `${this.sessionsImported.size} sessions, ${this.filesProcessed} files, ` +
        `${this.sessionsSkipped.size} skipped`,
    );
  }
}
