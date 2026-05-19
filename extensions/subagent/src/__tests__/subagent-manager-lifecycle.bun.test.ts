import { describe, it, expect, beforeEach } from 'bun:test';
import { SubagentManager } from '../manager/subagent-manager.js';
import { DEFAULT_CONSTRAINTS, SubagentErrorCode } from '@makaio/contracts';
import { config, expectSubagentError } from './test-helpers.js';

describe('SubagentManager lifecycle', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(DEFAULT_CONSTRAINTS);
  });

  describe('markCompleted', () => {
    it('sets status, result, and endTime', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.markCompleted('sub-1', 'Task done!');

      const subagent = manager.get('sub-1');
      expect(subagent?.status).toBe('completed');
      expect(subagent?.result).toBe('Task done!');
      expect(subagent?.endTime).toBeDefined();
    });

    it('throws if subagent not found', () => {
      expectSubagentError(() => manager.markCompleted('unknown', 'Result'), SubagentErrorCode.NOT_FOUND);
    });

    it('throws if already in terminal state', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.markCompleted('sub-1', 'First');

      expectSubagentError(() => manager.markCompleted('sub-1', 'Second'), SubagentErrorCode.ALREADY_TERMINAL);
    });

    it('resolves awaiters on completion', async () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const awaiterPromise = new Promise<string>((resolve) => {
        manager.addAwaiter('sub-1', (result) => {
          resolve(result.status);
        });
      });

      manager.markCompleted('sub-1', 'Done');

      const status = await awaiterPromise;
      expect(status).toBe('completed');
    });
  });

  describe('markFailed', () => {
    it('sets status, error, and endTime', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.markFailed('sub-1', 'Something went wrong');

      const subagent = manager.get('sub-1');
      expect(subagent?.status).toBe('failed');
      expect(subagent?.error).toBe('Something went wrong');
      expect(subagent?.endTime).toBeDefined();
    });

    it('does nothing for unknown subagent', () => {
      manager.markFailed('unknown', 'Error');
    });

    it('does nothing if already cancelled', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.markCancelled('sub-1');
      manager.markFailed('sub-1', 'Error');

      expect(manager.get('sub-1')?.status).toBe('cancelled');
      expect(manager.get('sub-1')?.error).toBeUndefined();
    });
  });

  describe('markCancelled', () => {
    it('sets status and endTime, returns true', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const result = manager.markCancelled('sub-1');

      expect(result).toBe(true);
      const subagent = manager.get('sub-1');
      expect(subagent?.status).toBe('cancelled');
      expect(subagent?.endTime).toBeDefined();
    });

    it('returns false for unknown subagent', () => {
      expect(manager.markCancelled('unknown')).toBe(false);
    });

    it('returns false if already in terminal state', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.markCompleted('sub-1', 'Done');
      expect(manager.markCancelled('sub-1')).toBe(false);
    });

    it('resolves pending request with null', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      let resolvedValue: string | null = 'not-called';
      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'Question?',
        resolver: (val) => {
          resolvedValue = val;
        },
      });

      manager.markCancelled('sub-1');

      expect(resolvedValue).toBeNull();
      expect(manager.get('sub-1')?.pendingRequest).toBeUndefined();
    });
  });

  describe('addAwaiter', () => {
    it('registers awaiter callback', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const results: string[] = [];
      manager.addAwaiter('sub-1', (result) => {
        results.push(`awaiter1:${result.status}`);
      });
      manager.addAwaiter('sub-1', (result) => {
        results.push(`awaiter2:${result.status}`);
      });

      manager.markFailed('sub-1', 'Error');

      expect(results).toEqual(['awaiter1:failed', 'awaiter2:failed']);
    });
  });

  describe('removeAwaiter', () => {
    it('removes awaiter callback and returns true', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const results: string[] = [];
      const callback1 = (result: { status: string }) => {
        results.push(`callback1:${result.status}`);
      };
      const callback2 = (result: { status: string }) => {
        results.push(`callback2:${result.status}`);
      };

      manager.addAwaiter('sub-1', callback1);
      manager.addAwaiter('sub-1', callback2);

      const removed = manager.removeAwaiter('sub-1', callback1);
      expect(removed).toBe(true);

      manager.markCompleted('sub-1', 'Done');

      // Only callback2 should be called
      expect(results).toEqual(['callback2:completed']);
    });

    it('returns false when subagent has no awaiters', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const callback = () => {};
      const removed = manager.removeAwaiter('sub-1', callback);
      expect(removed).toBe(false);
    });

    it('returns false when callback is not found', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const callback1 = () => {};
      const callback2 = () => {};

      manager.addAwaiter('sub-1', callback1);

      const removed = manager.removeAwaiter('sub-1', callback2);
      expect(removed).toBe(false);
    });

    it('cleans up empty awaiter array from map', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      const callback = () => {};
      manager.addAwaiter('sub-1', callback);
      manager.removeAwaiter('sub-1', callback);

      // Adding another awaiter after removal should work
      let called = false;
      manager.addAwaiter('sub-1', () => {
        called = true;
      });
      manager.markCompleted('sub-1', 'Done');
      expect(called).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('removes old completed subagents based on retention TTL', () => {
      const shortRetentionManager = new SubagentManager({
        ...DEFAULT_CONSTRAINTS,
        stateRetentionMs: 100,
      });

      shortRetentionManager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      shortRetentionManager.markCompleted('sub-1', 'Done');

      // Immediately after - should not clean up
      expect(shortRetentionManager.cleanup()).toBe(0);
      expect(shortRetentionManager.get('sub-1')).toBeDefined();
    });

    it('does not remove active subagents', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      expect(manager.cleanup()).toBe(0);
      expect(manager.get('sub-1')).toBeDefined();
    });

    it('returns count of cleaned up subagents', async () => {
      const shortRetentionManager = new SubagentManager({
        ...DEFAULT_CONSTRAINTS,
        stateRetentionMs: 10,
      });

      shortRetentionManager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test 1'),
        depth: 1,
      });
      shortRetentionManager.track({
        subagentId: 'sub-2',
        parentSessionId: 'parent-1',
        config: config('Test 2'),
        depth: 1,
      });

      shortRetentionManager.markCompleted('sub-1', 'Done 1');
      shortRetentionManager.markFailed('sub-2', 'Failed 2');

      // Wait for retention to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      const cleaned = shortRetentionManager.cleanup();
      expect(cleaned).toBe(2);
      expect(shortRetentionManager.get('sub-1')).toBeUndefined();
      expect(shortRetentionManager.get('sub-2')).toBeUndefined();
    });
  });
});
