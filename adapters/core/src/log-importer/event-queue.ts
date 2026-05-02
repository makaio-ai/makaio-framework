import PQueue from 'p-queue';
import { MakaioBus } from '@makaio/bus-core';

import type { NormalizedEvent } from './types.js';

interface LogImportEventQueueConfig {
  readonly eventsPerSecond: number;
  readonly onEventEmitted: () => void;
}

/**
 * Serializes log-import event delivery and cursor writes.
 *
 * Cursor tasks accept the event promises they depend on, so event emission
 * failures reject the cursor task instead of advancing import progress.
 */
export class LogImportEventQueue {
  private readonly eventQueue: PQueue;
  private readonly cursorQueue: PQueue;
  private readonly onEventEmitted: () => void;

  public constructor(config: LogImportEventQueueConfig) {
    this.onEventEmitted = config.onEventEmitted;
    this.eventQueue = new PQueue({
      concurrency: 1,
      interval: 1000,
      intervalCap: config.eventsPerSecond,
    });
    this.cursorQueue = new PQueue({ concurrency: 1 });
  }

  /**
   * Queue a normalized event and return its delivery promise.
   * @param event - Normalized event to emit
   * @returns Promise that resolves after delivery or rejects on emit failure
   */
  public queueEvent(event: NormalizedEvent): Promise<void> {
    return this.eventQueue.add(async () => {
      await MakaioBus.emit(event.subject, event.payload);
      this.onEventEmitted();
    });
  }

  /**
   * Queue a cursor/progress task behind previously queued event deliveries.
   * @param task - Cursor/progress task to run after event delivery succeeds
   * @param precedingEventPromises - Emission promises queued before this task
   * @returns Promise that rejects if a preceding event or the task itself fails
   */
  public queueAfterEvents(
    task: () => Promise<void>,
    precedingEventPromises: readonly Promise<void>[] = [],
  ): Promise<void> {
    const precedingEvents = Promise.all(precedingEventPromises);
    // Mark the aggregate as observed immediately; cursor tasks can sit behind
    // earlier cursor writes, but event rejection must not become unhandled.
    void precedingEvents.catch(() => undefined);

    return this.cursorQueue.add(async () => {
      await precedingEvents;
      await task();
    });
  }

  /** Wait until all queued event and cursor tasks finish. */
  public async drain(): Promise<void> {
    await Promise.all([this.eventQueue.onIdle(), this.cursorQueue.onIdle()]);
  }

  /** Alias for callers that use queue-idle terminology instead of shutdown-drain terminology. */
  public async onIdle(): Promise<void> {
    await this.drain();
  }
}
