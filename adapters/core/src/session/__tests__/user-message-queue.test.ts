import { describe, it, expect, beforeEach } from 'vitest';
import { UserMessageQueue } from '../user-message-queue.js';
import { MessageHandle } from '../../message-handle/index.js';
import { normalizeMessageInput } from '../../utils/normalizeMessageInput.js';

function createHandle(
  message: string,
  deliveryMode: 'enqueue' | 'replace' | 'immediate' = 'enqueue',
  internalRetry = false,
): MessageHandle {
  return new MessageHandle(
    crypto.randomUUID(),
    normalizeMessageInput(message),
    deliveryMode,
    undefined,
    undefined,
    undefined,
    internalRetry,
  );
}

describe('UserMessageQueue', () => {
  let queue: UserMessageQueue;

  beforeEach(() => {
    queue = new UserMessageQueue();
  });

  describe('basic operations', () => {
    it('enqueues and dequeues in FIFO order', () => {
      const h1 = createHandle('first');
      const h2 = createHandle('second');

      queue.enqueue(h1);
      queue.enqueue(h2);

      expect(queue.dequeue()).toBe(h1);
      expect(queue.dequeue()).toBe(h2);
      expect(queue.isEmpty()).toBe(true);
    });

    it('peeks without removing', () => {
      const h1 = createHandle('first');
      queue.enqueue(h1);

      expect(queue.peek()).toBe(h1);
      expect(queue.peek()).toBe(h1);
      expect(queue.size()).toBe(1);
    });

    it('returns undefined when dequeuing empty queue', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('returns undefined when peeking empty queue', () => {
      expect(queue.peek()).toBeUndefined();
    });

    it('reports correct size', () => {
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);

      queue.enqueue(createHandle('first'));
      expect(queue.size()).toBe(1);
      expect(queue.isEmpty()).toBe(false);

      queue.enqueue(createHandle('second'));
      expect(queue.size()).toBe(2);
    });

    it('clears all messages', () => {
      queue.enqueue(createHandle('first'));
      queue.enqueue(createHandle('second'));
      expect(queue.size()).toBe(2);

      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('replace mode', () => {
    it('supersedes queued messages', () => {
      const h1 = createHandle('first');
      const h2 = createHandle('second');
      const h3 = createHandle('replace', 'replace');

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.enqueue(h3);

      expect(h1.supersededBy).toBe(h3.messageId);
      expect(h2.supersededBy).toBe(h3.messageId);
      expect(queue.size()).toBe(1);
      expect(queue.dequeue()).toBe(h3);
    });

    it('does not supersede already acknowledged messages', () => {
      const h1 = createHandle('first');
      const h2 = createHandle('second');
      const h3 = createHandle('replace', 'replace');

      queue.enqueue(h1);
      h1.markAcknowledged(); // Already acknowledged
      queue.enqueue(h2);
      queue.enqueue(h3);

      // h1 was acknowledged, should not be superseded
      expect(h1.supersededBy).toBeUndefined();
      // h2 was still queued, should be superseded
      expect(h2.supersededBy).toBe(h3.messageId);
      // h1 stays in queue (acknowledged), h3 added
      expect(queue.size()).toBe(2);
    });
  });

  describe('immediate mode support', () => {
    it('findImmediate returns first immediate message', () => {
      const h1 = createHandle('enqueued');
      const h2 = createHandle('immediate1', 'immediate');
      const h3 = createHandle('immediate2', 'immediate');

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.enqueue(h3);

      expect(queue.findImmediate()).toBe(h2);
    });

    it('findImmediate returns undefined when no immediate messages', () => {
      const h1 = createHandle('enqueued1');
      const h2 = createHandle('enqueued2');

      queue.enqueue(h1);
      queue.enqueue(h2);

      expect(queue.findImmediate()).toBeUndefined();
    });

    it('removeImmediate removes specific handle', () => {
      const h1 = createHandle('enqueued');
      const h2 = createHandle('immediate', 'immediate');

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.removeImmediate(h2);

      expect(queue.size()).toBe(1);
      expect(queue.findImmediate()).toBeUndefined();
    });

    it('removeImmediate does nothing for non-existent handle', () => {
      const h1 = createHandle('enqueued');
      const h2 = createHandle('immediate', 'immediate');

      queue.enqueue(h1);
      queue.removeImmediate(h2); // h2 was never added

      expect(queue.size()).toBe(1);
    });

    it('drainEnqueued returns all enqueued messages', () => {
      const h1 = createHandle('enqueued1');
      const h2 = createHandle('immediate', 'immediate');
      const h3 = createHandle('enqueued2');

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.enqueue(h3);

      const drained = queue.drainEnqueued();

      expect(drained).toHaveLength(2);
      expect(drained[0]).toBe(h1);
      expect(drained[1]).toBe(h3);
      expect(queue.size()).toBe(1); // Only immediate remains
    });

    it('drainEnqueued returns empty array when no enqueued messages', () => {
      const h1 = createHandle('immediate1', 'immediate');
      const h2 = createHandle('immediate2', 'immediate');

      queue.enqueue(h1);
      queue.enqueue(h2);

      const drained = queue.drainEnqueued();

      expect(drained).toHaveLength(0);
      expect(queue.size()).toBe(2);
    });

    it('drainEnqueued preserves order of immediate messages', () => {
      const h1 = createHandle('enqueued1');
      const h2 = createHandle('immediate1', 'immediate');
      const h3 = createHandle('enqueued2');
      const h4 = createHandle('immediate2', 'immediate');

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.enqueue(h3);
      queue.enqueue(h4);

      queue.drainEnqueued();

      // Immediate messages should remain in order
      expect(queue.dequeue()).toBe(h2);
      expect(queue.dequeue()).toBe(h4);
    });
  });

  describe('internal retry priority', () => {
    it('dequeues internal structured-output retries before already queued user turns', () => {
      const h1 = createHandle('follow-up');
      const h2 = createHandle('later follow-up');
      const retry = createHandle('retry', 'enqueue', true);

      queue.enqueue(h1);
      queue.enqueue(h2);
      queue.enqueue(retry);

      expect(queue.dequeue()).toBe(retry);
      expect(queue.dequeue()).toBe(h1);
      expect(queue.dequeue()).toBe(h2);
    });

    it('preserves existing immediate priority ahead of internal retries', () => {
      const immediate = createHandle('interrupt', 'immediate');
      const followUp = createHandle('follow-up');
      const retry = createHandle('retry', 'enqueue', true);

      queue.enqueue(immediate);
      queue.enqueue(followUp);
      queue.enqueue(retry);

      expect(queue.dequeue()).toBe(immediate);
      expect(queue.dequeue()).toBe(retry);
      expect(queue.dequeue()).toBe(followUp);
    });
  });
});
