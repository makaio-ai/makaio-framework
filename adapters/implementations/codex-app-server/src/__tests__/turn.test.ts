/**
 * Tests for CodexAppServerTurn
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodexAppServerTurn } from '../turn.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import type { CodexAppServerBus } from '../namespaces/index.js';
import { MessageHandle } from '@makaio/ai-adapters-core';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';

/**
 * Creates a properly-typed CodexAppServerBus for unit tests.
 * Delegates to the namespace's scopedBus factory — the single source of truth
 * for constructing a real scoped bus instance.
 * @returns Promise resolving to a CodexAppServerBus
 */
function createTestBus(): Promise<CodexAppServerBus> {
  return CodexAppServerNamespace.scopedBus();
}

describe('CodexAppServerTurn', () => {
  let bus: CodexAppServerBus;
  const adapterId = 'test-adapter';
  const adapterName = 'codex-app-server';
  const agentId = 'test-agent';
  const threadId = 'thread-123';
  let messageHandle: MessageHandle;
  let turn: CodexAppServerTurn;

  beforeEach(async () => {
    bus = await createTestBus();

    // Create a mock message handle with proper type
    const message: NormalizedMessageInput = {
      role: 'user',
      blocks: [
        {
          type: 'text',
          content: 'Hello, world!',
        },
      ],
      message: 'Hello, world!',
    };
    messageHandle = new MessageHandle('msg-1', message, 'enqueue');
    turn = new CodexAppServerTurn(bus, adapterId, adapterName, agentId, threadId, messageHandle);
  });

  describe('initialization', () => {
    it('initializes with idle state', () => {
      expect(turn.getState()).toBe('idle');
      expect(turn.getTurnId()).toBeUndefined();
      expect(turn.getCurrentItemId()).toBeUndefined();
      expect(turn.isPaused()).toBe(false);
      expect(turn.isCompleted()).toBe(false);
    });

    it('can accept immediate when idle', () => {
      expect(turn.canAcceptImmediate()).toBe(true);
    });
  });

  describe('start', () => {
    it('transitions from idle to active', async () => {
      await turn.start();
      expect(turn.getState()).toBe('active');
    });
  });

  describe('handleTurnStarted', () => {
    it('sets turnId and transitions to processing_started', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-456');

      expect(turn.getTurnId()).toBe('turn-456');
      expect(turn.getState()).toBe('processing_started');
    });
  });

  describe('handleItemStarted - first item', () => {
    it('transitions processing_started to turn_started then step_started', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'agentMessage');

      expect(turn.getState()).toBe('step_started');
      expect(turn.getCurrentItemId()).toBe('item-1');
    });
  });

  describe('handleItemCompleted', () => {
    it('transitions from step_started to step_finished', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'agentMessage');
      await turn.handleItemCompleted('item-1');

      expect(turn.getState()).toBe('step_finished');
    });

    it('ignores mismatched item IDs', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'agentMessage');
      await turn.handleItemCompleted('item-2'); // Different ID

      expect(turn.getState()).toBe('step_started'); // No transition
    });
  });

  describe('multiple items', () => {
    it('handles item sequence: started → finished → started → finished', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');

      // First item
      await turn.handleItemStarted('item-1', 'commandExecution');
      expect(turn.getState()).toBe('step_started');

      await turn.handleItemCompleted('item-1');
      expect(turn.getState()).toBe('step_finished');

      // Second item
      await turn.handleItemStarted('item-2', 'fileChange');
      expect(turn.getState()).toBe('step_started');

      await turn.handleItemCompleted('item-2');
      expect(turn.getState()).toBe('step_finished');
    });
  });

  describe('handleTurnCompleted', () => {
    it('transitions from step_finished to turn_finished', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'agentMessage');
      await turn.handleItemCompleted('item-1');
      await turn.handleTurnCompleted();

      expect(turn.getState()).toBe('turn_finished');
    });

    it('requires at least one item before turn can complete', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      // Without items, state stays at processing_started
      expect(turn.getState()).toBe('processing_started');

      // Need an item to move forward
      await turn.handleItemStarted('item-1', 'agentMessage');
      await turn.handleItemCompleted('item-1');
      await turn.handleTurnCompleted();
      expect(turn.getState()).toBe('turn_finished');
    });
  });

  describe('pause (interrupt)', () => {
    it('pauses active turn and returns turnEnded: false', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'commandExecution');

      const result = await turn.pause();

      expect(result.turnEnded).toBe(false);
      expect(result.stateBeforePause).toBe('step_started');
      expect(turn.isPaused()).toBe(true);
    });

    it('returns turnEnded: true if already finished', async () => {
      await turn.start();
      await turn.handleTurnStarted('turn-1');
      await turn.handleItemStarted('item-1', 'agentMessage');
      await turn.handleItemCompleted('item-1');
      await turn.handleTurnCompleted();

      const result = await turn.pause();

      expect(result.turnEnded).toBe(true);
      expect(result.stateBeforePause).toBe('turn_finished');
    });

    it('prevents accepting immediate after pause', async () => {
      await turn.start();
      await turn.pause();

      expect(turn.canAcceptImmediate()).toBe(false);
    });

    it('throws error on resume attempt', async () => {
      await turn.start();
      await turn.pause();

      await expect(turn.resume()).rejects.toThrow('Codex app-server does not support resume');
    });
  });

  describe('message handle', () => {
    it('returns the message handle', () => {
      expect(turn.getMessageHandle()).toBe(messageHandle);
    });

    it('marks acknowledged', async () => {
      turn.markAcknowledged();
      const isAcked = await messageHandle.waitForAcknowledgment();
      expect(isAcked).toBe(true);
    });

    it('marks completed', async () => {
      turn.markCompleted({
        outcome: 'completed',
        result: { message: 'Done' },
      });
      const result = await messageHandle.waitForCompletion();
      expect(result).toMatchObject({
        outcome: 'completed',
      });
    });
  });

  describe('complete lifecycle flow', () => {
    it('handles full turn lifecycle with state transitions', async () => {
      // Turn starts
      await turn.start();
      expect(turn.getState()).toBe('active');

      // Turn started notification
      await turn.handleTurnStarted('turn-full');
      expect(turn.getState()).toBe('processing_started');

      // First item
      await turn.handleItemStarted('item-1', 'reasoning');
      expect(turn.getState()).toBe('step_started');
      await turn.handleItemCompleted('item-1');
      expect(turn.getState()).toBe('step_finished');

      // Second item
      await turn.handleItemStarted('item-2', 'commandExecution');
      expect(turn.getState()).toBe('step_started');
      await turn.handleItemCompleted('item-2');
      expect(turn.getState()).toBe('step_finished');

      // Turn completes
      await turn.handleTurnCompleted();
      expect(turn.getState()).toBe('turn_finished');
      expect(turn.isCompleted()).toBe(true);
    });
  });
});
