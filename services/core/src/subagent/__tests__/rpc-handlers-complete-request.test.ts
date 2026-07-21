import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { DEFAULT_CONSTRAINTS, SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { SubagentManager } from '../manager/index.js';
import {
  handleCompleteTaskRpc,
  handleRequestInputRpc,
  handleSendRpc,
  type RpcHandlerContext,
} from '../rpc-handlers.js';

/**
 * Helper to create a SubagentConfig with defaults applied.
 * @param task - Task description
 * @returns Config object
 */
function config(task: string) {
  return {
    task,
    adapterName: 'claude-code',
    contextMode: 'fork' as const,
  };
}

describe('rpc-handlers completeTask/requestInput', () => {
  let manager: SubagentManager;
  let ctx: RpcHandlerContext;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    manager = new SubagentManager(DEFAULT_CONSTRAINTS);
    ctx = { manager, bus: MakaioBus };
  });

  describe('handleCompleteTaskRpc', () => {
    it('throws when subagent not found', async () => {
      await expect(
        handleCompleteTaskRpc(ctx, {
          sessionId: 'missing-session',
          result: 'Done',
        }),
      ).rejects.toThrow('No subagent owns this child session');
    });

    it('records a non-terminal completion candidate for the exact child turn', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      manager.recordTurnStarted('child-1', 'turn-1');
      const onCompletionCandidate = vi.fn(async () => undefined);
      ctx.onCompletionCandidate = onCompletionCandidate;

      const result = await handleCompleteTaskRpc(ctx, {
        sessionId: 'child-1',
        result: 'Task finished successfully',
      });

      expect(result.completed).toBe(true);
      expect(manager.get('sub-1')?.status).toBe('completing');
      expect(manager.get('sub-1')?.completionCandidate).toMatchObject({
        turnId: 'turn-1',
        result: 'Task finished successfully',
      });
      expect(onCompletionCandidate).toHaveBeenCalledWith('sub-1');
    });

    it('rejects completion outside an active child turn', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');

      await expect(
        handleCompleteTaskRpc(ctx, { sessionId: 'child-1', result: 'Attempted completion' }),
      ).rejects.toThrow('No active turn exists');
    });

    it('rejects a turn hint that does not match the active child turn', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      manager.recordTurnStarted('child-1', 'turn-active');

      await expect(
        handleCompleteTaskRpc(ctx, { sessionId: 'child-1', turnId: 'turn-stale', result: 'Attempted completion' }),
      ).rejects.toThrow('does not match the active child turn');
    });

    it('throws when subagent already in terminal state', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      manager.recordTurnStarted('child-1', 'turn-1');
      manager.markFailed('sub-1', 'Previous error');

      await expect(
        handleCompleteTaskRpc(ctx, {
          sessionId: 'child-1',
          result: 'Attempted completion',
        }),
      ).rejects.toThrow('terminal state');
    });

    it('does not count a complete_task request rejected by lifecycle arbitration', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      manager.recordTurnStarted('child-1', 'turn-1');
      manager.setPendingRequest('sub-1', {
        messageId: 'request-1',
        question: 'Continue?',
        resolver: () => undefined,
      });

      await expect(
        handleCompleteTaskRpc(ctx, {
          sessionId: 'child-1',
          turnId: 'turn-1',
          result: 'Attempted completion',
        }),
      ).rejects.toThrow('input request is pending');
      expect(manager.get('sub-1')?.toolObservations).toHaveLength(0);
      expect(manager.get('sub-1')?.toolCallIds.size).toBe(0);
    });
  });

  describe('handleRequestInputRpc', () => {
    it('throws when subagent not found', async () => {
      await expect(handleRequestInputRpc(ctx, { subagentId: 'nonexistent', question: 'What color?' })).rejects.toThrow(
        'not found',
      );
    });

    it('sets pending request and waits for response', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const resultPromise = handleRequestInputRpc(ctx, {
        subagentId: 'sub-1',
        question: 'What color?',
        context: 'Theme selection',
        timeoutMs: 5000,
      });

      // Wait for pending request to be set (async emit completes first)
      await vi.waitFor(() => {
        expect(manager.get('sub-1')?.status).toBe('waiting_input');
      });
      expect(manager.get('sub-1')?.pendingRequest?.question).toBe('What color?');

      // Simulate parent response
      manager.resolvePendingRequest('sub-1', 'Blue');

      const result = await resultPromise;
      expect(result.responded).toBe(true);
      expect(result.response).toBe('Blue');
      expect(result.timedOut).toBe(false);
    });

    it('rejects completion-pending input requests before publishing them', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'tool');
      const toParentEvents: unknown[] = [];
      MakaioBus.on(SubagentSubjects.toParent, (busCtx) => {
        toParentEvents.push(busCtx.payload);
      });

      await expect(handleRequestInputRpc(ctx, { subagentId: 'sub-1', question: 'More input?' })).rejects.toThrow(
        'completion is pending',
      );
      expect(toParentEvents).toHaveLength(0);
      expect(manager.get('sub-1')?.status).toBe('completing');
    });

    it('claims waiting_input before publication so concurrent completion cannot win', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      let completionError: unknown;
      MakaioBus.on(SubagentSubjects.toParent, async () => {
        try {
          await handleCompleteTaskRpc(ctx, {
            sessionId: 'child-1',
            result: 'done',
          });
        } catch (error) {
          completionError = error;
        }
      });

      const input = handleRequestInputRpc(ctx, { subagentId: 'sub-1', question: 'More input?' });
      await vi.waitFor(() => expect(completionError).toBeDefined());
      expect(completionError).toMatchObject({ code: SubagentErrorCode.INVALID_STATE });
      expect(manager.get('sub-1')?.status).toBe('waiting_input');
      manager.resolvePendingRequest('sub-1', 'continue');
      await expect(input).resolves.toMatchObject({ responded: true, response: 'continue' });
    });

    it('returns timedOut: true when timeout expires', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const result = await handleRequestInputRpc(ctx, { subagentId: 'sub-1', question: 'What color?', timeoutMs: 20 });

      expect(result.responded).toBe(false);
      expect(result.timedOut).toBe(true);
    });

    it('times out while request_input publication is still blocked', async () => {
      vi.useFakeTimers();
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      let releasePublication!: () => void;
      const publication = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      MakaioBus.on(SubagentSubjects.toParent, async () => publication);

      try {
        const resultPromise = handleRequestInputRpc(ctx, {
          subagentId: 'sub-1',
          question: 'What color?',
          timeoutMs: 20,
        });
        await vi.advanceTimersByTimeAsync(20);
        expect(manager.get('sub-1')?.status).toBe('running');
        await expect(resultPromise).resolves.toEqual({ responded: false, timedOut: true });
        releasePublication();
      } finally {
        releasePublication();
        vi.useRealTimers();
      }
    });

    it('clears pending request on timeout', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const result = await handleRequestInputRpc(ctx, { subagentId: 'sub-1', question: 'What color?', timeoutMs: 20 });
      expect(result.timedOut).toBe(true);

      // Verify subagent is back to running (pending request cleared by timeout)
      expect(manager.get('sub-1')?.status).toBe('running');
      expect(manager.get('sub-1')?.pendingRequest).toBeUndefined();
    });

    it('emits toParent event with request_input type', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const toParentEvents: unknown[] = [];
      MakaioBus.on(SubagentSubjects.toParent, (busCtx) => {
        toParentEvents.push(busCtx.payload);
      });

      const resultPromise = handleRequestInputRpc(ctx, {
        subagentId: 'sub-1',
        question: 'What color?',
        context: 'Theme',
        timeoutMs: 100,
      });

      await vi.waitFor(() => expect(toParentEvents).toHaveLength(1));
      expect(toParentEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        type: 'request_input',
        content: 'What color?',
        context: 'Theme',
      });

      // Clean up
      manager.resolvePendingRequest('sub-1', 'Blue');
      await resultPromise;
    });

    it('throws REQUEST_PENDING when request already pending', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      // Start first request (don't await - it will block waiting for response)
      const firstRequestPromise = handleRequestInputRpc(ctx, {
        subagentId: 'sub-1',
        question: 'First question?',
        timeoutMs: 5000,
      });

      // Wait for pending request to be set
      await vi.waitFor(() => {
        expect(manager.get('sub-1')?.pendingRequest).toBeDefined();
      });

      // Second request should throw REQUEST_PENDING
      await expect(
        handleRequestInputRpc(ctx, {
          subagentId: 'sub-1',
          question: 'Second question?',
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({
        code: SubagentErrorCode.REQUEST_PENDING,
      });

      // Clean up first request
      manager.resolvePendingRequest('sub-1', 'Answer');
      await firstRequestPromise;
    });
  });

  it('rejects sends until atomic startup admits the initial task', async () => {
    manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
    manager.setChildSessionId('sub-1', 'child-1');

    await expect(handleSendRpc(ctx, { subagentId: 'sub-1', content: 'too early' })).rejects.toThrow(
      'before startup completes',
    );
  });

  it('rejects sends for a stalled completion candidate after it becomes hung', async () => {
    manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
    manager.markStarted('sub-1');
    manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'tool');
    manager.get('sub-1')!.lastActivityAt = 0;
    manager.sweepHung(1);

    await expect(handleSendRpc(ctx, { subagentId: 'sub-1', content: 'more work' })).rejects.toThrow(
      'completion is pending',
    );
    expect(manager.get('sub-1')?.status).toBe('hung');
  });
});
