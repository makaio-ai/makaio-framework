import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { DEFAULT_CONSTRAINTS, SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { SubagentManager } from '../manager/index.js';
import { handleCompleteTaskRpc, handleRequestInputRpc, type RpcHandlerContext } from '../rpc-handlers.js';

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
      await expect(handleCompleteTaskRpc(ctx, { subagentId: 'nonexistent', result: 'Done' })).rejects.toThrow(
        'not found',
      );
    });

    it('marks subagent as completed and emits event', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const completedEvents: unknown[] = [];
      MakaioBus.on(SubagentSubjects.completed, (busCtx) => {
        completedEvents.push(busCtx.payload);
      });

      const result = await handleCompleteTaskRpc(ctx, { subagentId: 'sub-1', result: 'Task finished successfully' });

      expect(result.completed).toBe(true);
      expect(manager.get('sub-1')?.status).toBe('completed');
      expect(manager.get('sub-1')?.result).toBe('Task finished successfully');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        subagentId: 'sub-1',
        success: true,
        result: 'Task finished successfully',
      });
    });

    it('throws when subagent already in terminal state', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.markFailed('sub-1', 'Previous error');

      await expect(handleCompleteTaskRpc(ctx, { subagentId: 'sub-1', result: 'Attempted completion' })).rejects.toThrow(
        'terminal state',
      );
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

    it('returns timedOut: true when timeout expires', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });

      const result = await handleRequestInputRpc(ctx, { subagentId: 'sub-1', question: 'What color?', timeoutMs: 20 });

      expect(result.responded).toBe(false);
      expect(result.timedOut).toBe(true);
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
});
