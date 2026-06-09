import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { UserMessageQueue } from '../user-message-queue.js';
import { MessageHandle } from '../../message-handle/index.js';
import { normalizeMessageInput } from '../../utils/normalizeMessageInput.js';
import { processQueueMessages, type QueueableTurn } from '../process-queue.js';

/** Typed mock for the startNewTurn callback */
type StartNewTurnFn = (handle: MessageHandle, mergedContent?: string[], extra?: unknown) => Promise<void>;

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

/**
 * Create a mock turn that satisfies QueueableTurn.
 * @param state - Whether the turn is completed, active, or paused
 * @param handle - The message handle for this turn
 * @param pauseSucceeds - Whether pause() should succeed (turnEnded: false) or fail (turnEnded: true)
 */
function createMockTurn(
  state: 'active' | 'completed' | 'paused',
  handle: MessageHandle,
  pauseSucceeds = true,
): QueueableTurn {
  return {
    canAcceptImmediate: () => state === 'active',
    isCompleted: () => state === 'completed',
    getMessageHandle: () => handle,
    pause: vi.fn().mockResolvedValue({
      stateBeforePause: state,
      turnEnded: !pauseSucceeds,
    }),
  };
}

describe('processQueueMessages', () => {
  let queue: UserMessageQueue;
  let startNewTurn: Mock<StartNewTurnFn>;

  beforeEach(() => {
    queue = new UserMessageQueue();
    startNewTurn = vi.fn<StartNewTurnFn>().mockResolvedValue(undefined);
  });

  describe('normal queue processing', () => {
    it('processes next enqueued message when no active turn', async () => {
      const handle = createHandle('hello');
      queue.enqueue(handle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => undefined,
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(handle);
      expect(queue.isEmpty()).toBe(true);
    });

    it('processes next enqueued message when turn is completed', async () => {
      const oldHandle = createHandle('old');
      oldHandle.markCompleted({ outcome: 'completed' });
      const turn = createMockTurn('completed', oldHandle);

      const handle = createHandle('next');
      queue.enqueue(handle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(handle);
    });

    it('does nothing when queue is empty', async () => {
      await processQueueMessages(queue, {
        getCurrentTurn: () => undefined,
        startNewTurn,
      });

      expect(startNewTurn).not.toHaveBeenCalled();
    });

    it('does not dequeue when turn is active and not completed', async () => {
      const activeHandle = createHandle('active');
      const turn = createMockTurn('active', activeHandle);

      const nextHandle = createHandle('next');
      queue.enqueue(nextHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      // No immediate in queue, turn is active -> nothing happens
      expect(startNewTurn).not.toHaveBeenCalled();
      expect(queue.size()).toBe(1);
    });

    it('starts internal retries once the active message handle is processed', async () => {
      const activeHandle = createHandle('active');
      activeHandle.markCompleted({ outcome: 'completed', result: { message: 'invalid json' } });
      const turn = createMockTurn('active', activeHandle);

      const retryHandle = createHandle('retry', 'enqueue', true);
      queue.enqueue(retryHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(retryHandle);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('immediate message handling', () => {
    it('pauses active turn and starts new turn with merged content', async () => {
      const activeHandle = createHandle('in-flight');
      const turn = createMockTurn('active', activeHandle);

      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(turn.pause).toHaveBeenCalled();
      expect(activeHandle.state).toBe('completed');
      expect(startNewTurn).toHaveBeenCalledWith(immediateHandle, ['in-flight'], undefined);
    });

    it('merges enqueued messages when immediate arrives', async () => {
      const activeHandle = createHandle('in-flight');
      const turn = createMockTurn('active', activeHandle);

      const enqueuedHandle = createHandle('queued');
      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(enqueuedHandle);
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      // Both in-flight and enqueued should be merged
      expect(activeHandle.supersededBy).toBe(immediateHandle.messageId);
      expect(enqueuedHandle.supersededBy).toBe(immediateHandle.messageId);
      expect(startNewTurn).toHaveBeenCalledWith(immediateHandle, ['in-flight', 'queued'], undefined);
    });

    it('rejects immediate when pause fails (turn already ended)', async () => {
      const activeHandle = createHandle('in-flight');
      activeHandle.markCompleted({ outcome: 'completed' });
      const turn = createMockTurn('active', activeHandle, false);

      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(immediateHandle.state).toBe('completed');
      expect(startNewTurn).not.toHaveBeenCalled();
    });

    it('rejects late immediate messages when the previous turn already completed', async () => {
      const oldHandle = createHandle('old');
      oldHandle.markCompleted({ outcome: 'completed' });
      const turn = createMockTurn('completed', oldHandle);

      const immediateHandle = createHandle('too late', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(immediateHandle.state).toBe('completed');
      expect(startNewTurn).not.toHaveBeenCalled();
    });

    it('starts a new turn for immediate messages when no turn exists yet', async () => {
      const immediateHandle = createHandle('first message', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => undefined,
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(immediateHandle);
      expect(queue.isEmpty()).toBe(true);
    });

    it('rejects late immediate then processes next enqueued', async () => {
      const oldHandle = createHandle('old');
      oldHandle.markCompleted({ outcome: 'completed' });
      const turn = createMockTurn('completed', oldHandle);

      const immediateHandle = createHandle('too late', 'immediate');
      const nextHandle = createHandle('next');
      queue.enqueue(immediateHandle);
      queue.enqueue(nextHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        startNewTurn,
      });

      expect(immediateHandle.state).toBe('completed');
      expect(startNewTurn).toHaveBeenCalledWith(nextHandle);
    });
  });

  describe('adapter-specific callbacks', () => {
    it('calls onBeforeImmediateTurn before starting new turn', async () => {
      const activeHandle = createHandle('in-flight');
      const turn = createMockTurn('active', activeHandle);
      const callOrder: string[] = [];

      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        onBeforeImmediateTurn: async () => {
          callOrder.push('before');
        },
        startNewTurn: async (...args) => {
          callOrder.push('start');
          return startNewTurn(...args);
        },
      });

      expect(callOrder).toEqual(['before', 'start']);
    });

    it('uses custom extractContent for merge', async () => {
      const activeHandle = createHandle('in-flight');
      const turn = createMockTurn('active', activeHandle);

      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(immediateHandle);

      await processQueueMessages(queue, {
        getCurrentTurn: () => turn,
        extractContent: () => 'custom-content',
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(immediateHandle, ['custom-content'], undefined);
    });

    it('passes collectMergeExtra result through to startNewTurn', async () => {
      const activeHandle = createHandle('in-flight');
      const turn = createMockTurn('active', activeHandle);

      const immediateHandle = createHandle('urgent', 'immediate');
      queue.enqueue(immediateHandle);

      const extraData = { nonTextParts: ['image1'] };

      await processQueueMessages<typeof extraData>(queue, {
        getCurrentTurn: () => turn,
        collectMergeExtra: () => extraData,
        startNewTurn,
      });

      expect(startNewTurn).toHaveBeenCalledWith(immediateHandle, ['in-flight'], extraData);
    });
  });
});
