import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { SubagentManager } from '../manager/subagent-manager.js';
import { DEFAULT_CONSTRAINTS } from '@makaio/contracts';
import { config } from './test-helpers.js';

describe('SubagentManager — sweepHung and lastActivityAt', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new SubagentManager(DEFAULT_CONSTRAINTS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Track a test subagent with sensible defaults.
   * @param id - The subagent ID to register.
   * @param task - The task label for the subagent config (defaults to 'Test').
   */
  function trackSub(id: string, task = 'Test'): void {
    manager.track({ subagentId: id, parentSessionId: 'parent-1', config: config(task), depth: 1 });
  }

  describe('sweepHung', () => {
    it('returns 0 when inactivityTimeoutMs is 0 (disabled)', () => {
      trackSub('sub-1');

      // 0 = disabled, sweep should always be a no-op regardless of idle time
      const swept = manager.sweepHung(0);
      expect(swept).toBe(0);
      expect(manager.get('sub-1')?.status).toBe('spawning');
    });

    it('returns 0 when inactivityTimeoutMs is negative (disabled)', () => {
      trackSub('sub-1');

      const swept = manager.sweepHung(-1);
      expect(swept).toBe(0);
      expect(manager.get('sub-1')?.status).toBe('spawning');
    });

    it('marks inactive non-terminal subagents as hung (non-terminal)', () => {
      trackSub('sub-1');

      jest.advanceTimersByTime(20);

      const swept = manager.sweepHung(10);
      expect(swept).toBe(1);

      const subagent = manager.get('sub-1');
      expect(subagent?.status).toBe('hung');
      // hung is non-terminal: no endTime set, no error field, awaiters not resolved
      expect(subagent?.endTime).toBeUndefined();
      expect(subagent?.error).toBeUndefined();
    });

    it('skips subagents that have been active within the threshold', () => {
      trackSub('sub-1');

      // 1-hour threshold — recently tracked subagent should not be swept
      const swept = manager.sweepHung(3_600_000);
      expect(swept).toBe(0);
      expect(manager.get('sub-1')?.status).toBe('spawning');
    });

    it('skips subagents already in terminal states', () => {
      trackSub('sub-1');
      manager.markCompleted('sub-1', 'Done');

      jest.advanceTimersByTime(20);

      const swept = manager.sweepHung(10);
      expect(swept).toBe(0);
      // Status should remain completed, not overwritten by sweep
      expect(manager.get('sub-1')?.status).toBe('completed');
    });

    it('does not resolve awaiters for swept subagents (hung is non-terminal)', () => {
      trackSub('sub-1');

      let awaiterCalled = false;
      manager.addAwaiter('sub-1', () => {
        awaiterCalled = true;
      });

      jest.advanceTimersByTime(20);
      manager.sweepHung(10);

      expect(manager.get('sub-1')?.status).toBe('hung');
      // Awaiter must NOT fire — coordinator polls getStatus to discover hung subagents
      expect(awaiterCalled).toBe(false);
    });

    it('does not re-sweep subagents already in hung state', () => {
      trackSub('sub-1');

      jest.advanceTimersByTime(20);
      const firstSweep = manager.sweepHung(10);
      expect(firstSweep).toBe(1);
      expect(manager.get('sub-1')?.status).toBe('hung');

      // Second sweep must not count the already-hung subagent again
      jest.advanceTimersByTime(20);
      const secondSweep = manager.sweepHung(10);
      expect(secondSweep).toBe(0);
      expect(manager.get('sub-1')?.status).toBe('hung');
    });

    it('does not sweep waiting_input subagents (request_input owns their timeout)', () => {
      trackSub('sub-1');
      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'Continue?',
        resolver: () => {},
      });

      // Subagent is now in waiting_input status
      expect(manager.get('sub-1')?.status).toBe('waiting_input');

      jest.advanceTimersByTime(20);

      // Should not be swept — request_input owns this timeout
      const swept = manager.sweepHung(10);
      expect(swept).toBe(0);
      expect(manager.get('sub-1')?.status).toBe('waiting_input');
    });

    it('sweeps multiple inactive subagents in one pass', () => {
      trackSub('sub-1', 'T1');
      trackSub('sub-2', 'T2');
      trackSub('sub-3', 'T3');

      // Mark sub-3 as completed so it is terminal and should not be swept
      manager.markCompleted('sub-3', 'Done');

      jest.advanceTimersByTime(20);

      const swept = manager.sweepHung(10);
      expect(swept).toBe(2); // sub-1 and sub-2 only
      expect(manager.get('sub-1')?.status).toBe('hung');
      expect(manager.get('sub-2')?.status).toBe('hung');
      expect(manager.get('sub-3')?.status).toBe('completed');
    });
  });

  describe('lastActivityAt', () => {
    it('is initialized to startTime on track', () => {
      jest.setSystemTime(1_700_000_000_000);
      trackSub('sub-1');

      const subagent = manager.get('sub-1');
      expect(subagent?.lastActivityAt).toBe(1_700_000_000_000);
    });

    it('is bumped on setChildSessionId', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.setChildSessionId('sub-1', 'child-session-1');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on sweepHung transition', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(20);

      manager.sweepHung(10);
      expect(manager.get('sub-1')!.status).toBe('hung');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on addProgress', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.addProgress('sub-1', 'Step 1');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on markCompleted', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.markCompleted('sub-1', 'Done');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on markFailed', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.markFailed('sub-1', 'Error');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on markCancelled', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.markCancelled('sub-1');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on updateStatus', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.updateStatus('sub-1', 'running');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on setPendingRequest', () => {
      trackSub('sub-1');

      const initial = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'Continue?',
        resolver: () => {},
      });
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(initial);
    });

    it('is bumped on resolvePendingRequest', () => {
      trackSub('sub-1');
      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'Continue?',
        resolver: () => {},
      });

      const afterSet = manager.get('sub-1')!.lastActivityAt;
      jest.advanceTimersByTime(10);

      manager.resolvePendingRequest('sub-1', 'yes');
      expect(manager.get('sub-1')!.lastActivityAt).toBeGreaterThan(afterSet);
    });
  });
});
