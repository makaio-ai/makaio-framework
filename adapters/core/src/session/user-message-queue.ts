import type { MessageHandle } from '../message-handle/index.js';

/**
 * Simple FIFO queue for user messages with delivery mode support.
 *
 * This queue is owned by adapter Connectors and passed to Sessions for processing.
 *
 * Delivery modes:
 * - 'enqueue': Add to end of queue (default); internal retries are prioritized
 *   ahead of already queued user turns.
 * - 'replace': Supersede all unacknowledged messages, add to queue
 * - 'immediate': Handled by Session (abort/restart), not queue
 *
 * Design:
 * - Connector enqueues messages as they arrive
 * - Session dequeues messages when ready to process
 * - Peek allows Session to inspect next message without removing
 */
export class UserMessageQueue {
  private readonly queue: MessageHandle[] = [];

  /**
   * Add message to queue based on delivery mode.
   * @param handle - Message handle to enqueue
   */
  public enqueue(handle: MessageHandle): void {
    if (handle.deliveryMode === 'replace') {
      // Supersede all unacknowledged messages
      for (const existing of this.queue) {
        if (existing.state === 'queued') {
          existing.supersededBy = handle.messageId;
          existing.markCompleted({ outcome: 'superseded', supersededBy: handle.messageId });
        }
      }
      this.removeSuperseded();
    }
    if (handle.internalRetry && handle.deliveryMode === 'enqueue') {
      this.enqueueInternalRetry(handle);
      return;
    }
    this.queue.push(handle);
  }

  /**
   * Enqueue an internal retry before ordinary queued user turns while preserving
   * immediate-mode ordering and FIFO ordering among retries.
   * @param handle - Internal retry handle to enqueue
   */
  private enqueueInternalRetry(handle: MessageHandle): void {
    const insertionIndex = this.queue.findIndex(
      (queuedHandle) => queuedHandle.deliveryMode !== 'immediate' && !queuedHandle.internalRetry,
    );
    if (insertionIndex === -1) {
      this.queue.push(handle);
      return;
    }
    this.queue.splice(insertionIndex, 0, handle);
  }

  /**
   * Remove all superseded messages from queue.
   */
  private removeSuperseded(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].supersededBy) {
        this.queue.splice(i, 1);
      }
    }
  }

  /**
   * Remove and return first message from queue.
   * @returns First message or undefined if queue empty
   */
  public dequeue(): MessageHandle | undefined {
    return this.queue.shift();
  }

  /**
   * Look at first message without removing.
   * @returns First message or undefined if queue empty
   */
  public peek(): MessageHandle | undefined {
    return this.queue[0];
  }

  /**
   * Check if queue is empty.
   * @returns True if queue has no messages
   */
  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get current queue size.
   * @returns Number of messages in queue
   */
  public size(): number {
    return this.queue.length;
  }

  /**
   * Clear all messages from queue.
   */
  public clear(): void {
    this.queue.length = 0;
  }

  /**
   * Find the first immediate message in the queue.
   * @returns First immediate message or undefined
   */
  public findImmediate(): MessageHandle | undefined {
    return this.queue.find((h) => h.deliveryMode === 'immediate');
  }

  /**
   * Remove a specific immediate message from the queue.
   * @param handle - Handle to remove
   */
  public removeImmediate(handle: MessageHandle): void {
    const idx = this.queue.indexOf(handle);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
  }

  /**
   * Remove and return all enqueued (non-immediate) messages.
   * Used when immediate arrives to merge their content.
   * @returns Array of enqueued message handles in FIFO order
   */
  public drainEnqueued(): MessageHandle[] {
    const enqueued: MessageHandle[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].deliveryMode === 'enqueue') {
        enqueued.unshift(this.queue.splice(i, 1)[0]);
      }
    }
    return enqueued;
  }
}
