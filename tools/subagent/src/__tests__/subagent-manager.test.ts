import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentManager } from '../manager/subagent-manager.js';
import { DEFAULT_CONSTRAINTS, SubagentErrorCode } from '@makaio/contracts';
import { config, expectSubagentError } from './test-helpers.js';

describe('SubagentManager', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager(DEFAULT_CONSTRAINTS);
  });

  describe('track', () => {
    it('tracks a new subagent', () => {
      const subagent = manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test task'),
        depth: 1,
      });

      expect(subagent.subagentId).toBe('sub-1');
      expect(subagent.status).toBe('spawning');
      expect(manager.get('sub-1')).toBeDefined();
    });

    it('initializes with empty progress buffer', () => {
      const subagent = manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test task'),
        depth: 1,
      });

      expect(subagent.progressUpdates.length).toBe(0);
    });

    it('sets startTime to current time', () => {
      const before = Date.now();
      const subagent = manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test task'),
        depth: 1,
      });
      const after = Date.now();

      expect(subagent.startTime).toBeGreaterThanOrEqual(before);
      expect(subagent.startTime).toBeLessThanOrEqual(after);
    });
  });

  describe('get', () => {
    it('returns undefined for unknown subagent', () => {
      expect(manager.get('unknown')).toBeUndefined();
    });

    it('returns tracked subagent by ID', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test task'),
        depth: 1,
      });

      const retrieved = manager.get('sub-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.subagentId).toBe('sub-1');
    });
  });

  describe('countActiveBySession', () => {
    it('counts active subagents for a session', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Task 1'),
        depth: 1,
      });
      manager.track({
        subagentId: 'sub-2',
        parentSessionId: 'parent-1',
        config: config('Task 2'),
        depth: 1,
      });
      manager.track({
        subagentId: 'sub-3',
        parentSessionId: 'parent-2',
        config: config('Task 3'),
        depth: 1,
      });

      expect(manager.countActiveBySession('parent-1')).toBe(2);
      expect(manager.countActiveBySession('parent-2')).toBe(1);
      expect(manager.countActiveBySession('unknown')).toBe(0);
    });

    it('excludes terminal state subagents from count', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Task 1'),
        depth: 1,
      });
      manager.track({
        subagentId: 'sub-2',
        parentSessionId: 'parent-1',
        config: config('Task 2'),
        depth: 1,
      });

      manager.markCompleted('sub-1', 'Done');
      expect(manager.countActiveBySession('parent-1')).toBe(1);
    });
  });

  describe('countTotalActive', () => {
    it('counts all active subagents', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Task 1'),
        depth: 1,
      });
      manager.track({
        subagentId: 'sub-2',
        parentSessionId: 'parent-2',
        config: config('Task 2'),
        depth: 1,
      });

      expect(manager.countTotalActive()).toBe(2);
    });

    it('excludes terminal state subagents', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Task 1'),
        depth: 1,
      });
      manager.track({
        subagentId: 'sub-2',
        parentSessionId: 'parent-1',
        config: config('Task 2'),
        depth: 1,
      });

      manager.markFailed('sub-1', 'Error');
      manager.markCancelled('sub-2');

      expect(manager.countTotalActive()).toBe(0);
    });
  });

  describe('updateStatus', () => {
    it('updates subagent status', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.updateStatus('sub-1', 'waiting_input');
      expect(manager.get('sub-1')?.status).toBe('waiting_input');
    });

    it('sets endTime for terminal states', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.updateStatus('sub-1', 'completed');
      expect(manager.get('sub-1')?.endTime).toBeDefined();
    });

    it('does nothing for unknown subagent', () => {
      manager.updateStatus('unknown', 'completed');
    });
  });

  describe('addProgress', () => {
    it('adds progress updates to buffer', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.addProgress('sub-1', 'Step 1');
      manager.addProgress('sub-1', 'Step 2');

      const subagent = manager.get('sub-1');
      expect(subagent?.progressUpdates.toArray()).toEqual(['Step 1', 'Step 2']);
    });

    it('does nothing for unknown subagent', () => {
      manager.addProgress('unknown', 'Step 1');
    });
  });

  describe('setPendingRequest', () => {
    it('sets pending request and updates status', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'What color?',
        resolver: () => {},
      });

      const subagent = manager.get('sub-1');
      expect(subagent?.status).toBe('waiting_input');
      expect(subagent?.pendingRequest?.messageId).toBe('msg-1');
      expect(subagent?.pendingRequest?.question).toBe('What color?');
    });

    it('throws if subagent not found', () => {
      expectSubagentError(
        () =>
          manager.setPendingRequest('unknown', {
            messageId: 'msg-1',
            question: 'Question?',
            resolver: () => {},
          }),
        SubagentErrorCode.NOT_FOUND,
      );
    });

    it('throws if request already pending (invariant)', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'First?',
        resolver: () => {},
      });

      expectSubagentError(
        () =>
          manager.setPendingRequest('sub-1', {
            messageId: 'msg-2',
            question: 'Second?',
            resolver: () => {},
          }),
        SubagentErrorCode.REQUEST_PENDING,
      );
    });
  });

  describe('resolvePendingRequest', () => {
    /**
     * Tracks a subagent and sets a pending request with a captured resolver.
     * @returns Object with the captured resolvedValue ref
     */
    function trackWithPendingRequest(): { resolvedValue: string | null } {
      const state = { resolvedValue: 'not-called' as string | null };
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });
      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'What color?',
        resolver: (val) => {
          state.resolvedValue = val;
        },
      });
      return state;
    }

    it('calls resolver and clears pending request', () => {
      const state = trackWithPendingRequest();

      manager.resolvePendingRequest('sub-1', 'Blue');

      expect(state.resolvedValue).toBe('Blue');
      expect(manager.get('sub-1')?.pendingRequest).toBeUndefined();
      expect(manager.get('sub-1')?.status).toBe('running');
    });

    it('handles null response (timeout/cancel)', () => {
      const state = trackWithPendingRequest();

      manager.resolvePendingRequest('sub-1', null);

      expect(state.resolvedValue).toBeNull();
    });

    it('does nothing if no pending request', () => {
      manager.track({
        subagentId: 'sub-1',
        parentSessionId: 'parent-1',
        config: config('Test'),
        depth: 1,
      });

      manager.resolvePendingRequest('sub-1', 'Response');
    });
  });
});
