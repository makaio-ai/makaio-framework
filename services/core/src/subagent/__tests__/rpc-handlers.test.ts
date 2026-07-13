import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { DEFAULT_CONSTRAINTS, SubagentSubjects, SessionSubjects } from '@makaio/contracts';
import { SubagentManager } from '../manager/index.js';
import { handleSpawnRpc, handleAwaitRpc, handleListBySessionRpc, type RpcHandlerContext } from '../rpc-handlers.js';

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

describe('rpc-handlers spawn/await', () => {
  let manager: SubagentManager;
  let ctx: RpcHandlerContext;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    manager = new SubagentManager(DEFAULT_CONSTRAINTS);
    ctx = { manager, bus: MakaioBus };
  });

  describe('handleSpawnRpc', () => {
    describe('constraint validation', () => {
      it('rejects spawn when depth exceeds maxDepth', async () => {
        const customManager = new SubagentManager({ ...DEFAULT_CONSTRAINTS, maxDepth: 2 });
        const customCtx = { manager: customManager, bus: MakaioBus };

        await expect(
          handleSpawnRpc(customCtx, {
            parentSessionId: 'parent-1',
            config: config('Test task'),
            depth: 3,
          }),
        ).rejects.toThrow('Maximum subagent depth (2) exceeded');
      });

      it('rejects spawn when concurrent session limit exceeded', async () => {
        const customManager = new SubagentManager({ ...DEFAULT_CONSTRAINTS, maxConcurrentPerSession: 2 });
        const customCtx = { manager: customManager, bus: MakaioBus };

        customManager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Task 1'), depth: 1 });
        customManager.track({ subagentId: 'sub-2', parentSessionId: 'parent-1', config: config('Task 2'), depth: 1 });

        await expect(
          handleSpawnRpc(customCtx, { parentSessionId: 'parent-1', config: config('Task 3'), depth: 1 }),
        ).rejects.toThrow('Maximum concurrent subagents per session (2) reached');
      });

      it('rejects spawn when global limit exceeded', async () => {
        const customManager = new SubagentManager({ ...DEFAULT_CONSTRAINTS, maxTotalActive: 2 });
        const customCtx = { manager: customManager, bus: MakaioBus };

        customManager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Task 1'), depth: 1 });
        customManager.track({ subagentId: 'sub-2', parentSessionId: 'parent-2', config: config('Task 2'), depth: 1 });

        await expect(
          handleSpawnRpc(customCtx, { parentSessionId: 'parent-3', config: config('Task 3'), depth: 1 }),
        ).rejects.toThrow('Maximum total active subagents (2) reached');
      });

      it('rejects spawn when adapter not in allowlist', async () => {
        const customManager = new SubagentManager({ ...DEFAULT_CONSTRAINTS, allowedAdapters: ['claude-code'] });
        const customCtx = { manager: customManager, bus: MakaioBus };

        await expect(
          handleSpawnRpc(customCtx, {
            parentSessionId: 'parent-1',
            config: { ...config('Task'), adapterName: 'other-adapter' },
            depth: 1,
          }),
        ).rejects.toThrow("Adapter 'other-adapter' is not allowed");
      });

      it('inherits adapterName from parent session when missing', async () => {
        MakaioBus.on(SessionSubjects.get, (busCtx) => {
          busCtx.setResult({
            session: {
              sessionId: busCtx.payload.sessionId,
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              status: 'active',
              agents: [
                {
                  agentId: 'parent-agent',
                  adapterId: 'adapter-parent',
                  adapterName: 'claude-code',
                  sessionId: busCtx.payload.sessionId,
                  status: 'idle',
                  createdAt: Date.now(),
                  lastActivityAt: Date.now(),
                  role: 'lead',
                },
              ],
              leadAgentId: 'parent-agent',
            },
          });
        });

        const result = await handleSpawnRpc(ctx, {
          parentSessionId: 'parent-1',
          config: { task: 'Task', contextMode: 'fork' },
          depth: 1,
        });

        expect(result.status).toBe('spawning');
      });

      it('rejects spawn when adapterName is missing and no parent adapter is available', async () => {
        MakaioBus.on(SessionSubjects.get, (busCtx) => {
          busCtx.setResult({
            session: {
              sessionId: busCtx.payload.sessionId,
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              status: 'active',
              agents: [],
            },
          });
        });

        await expect(
          handleSpawnRpc(ctx, {
            parentSessionId: 'parent-1',
            config: { task: 'Task', contextMode: 'fork' },
            depth: 1,
          }),
        ).rejects.toThrow('no inheritable adapter');
      });

      it('rejects spawn when model not in allowlist', async () => {
        const customManager = new SubagentManager({ ...DEFAULT_CONSTRAINTS, allowedModels: ['gpt-4', 'claude-3'] });
        const customCtx = { manager: customManager, bus: MakaioBus };

        await expect(
          handleSpawnRpc(customCtx, {
            parentSessionId: 'parent-1',
            config: { ...config('Task'), model: 'other-model' },
            depth: 1,
          }),
        ).rejects.toThrow("Model 'other-model' is not allowed");
      });

      it('allows spawn when constraints are satisfied', async () => {
        const emitSpy = vi.fn();
        MakaioBus.on(SubagentSubjects.spawned, (busCtx) => {
          emitSpy(busCtx.payload);
        });

        const result = await handleSpawnRpc(ctx, {
          parentSessionId: 'parent-1',
          config: config('Test task'),
          depth: 1,
        });

        expect(result.status).toBe('spawning');
        expect(result.subagentId).toBeDefined();
        expect(emitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            subagentId: result.subagentId,
            parentSessionId: 'parent-1',
            task: 'Test task',
            depth: 1,
          }),
        );
      });

      it('publishes the winning service identity for execution ownership', async () => {
        const emitSpy = vi.fn();
        MakaioBus.on(SubagentSubjects.spawned, (busCtx) => emitSpy(busCtx.payload));

        await handleSpawnRpc(
          { ...ctx, executionOwnerId: 'isolated-runtime-service' },
          {
            parentSessionId: 'parent-1',
            config: config('Owned task'),
            depth: 1,
          },
        );

        expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ executionOwnerId: 'isolated-runtime-service' }));
      });
    });
  });

  describe('handleAwaitRpc', () => {
    it('throws when subagent not found', async () => {
      await expect(handleAwaitRpc(ctx, { subagentId: 'nonexistent' })).rejects.toThrow('not found');
    });

    it('returns immediately if subagent already completed', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');
      manager.recordToolObservation('child-1', {
        toolName: 'artifacts_get',
        outcome: 'success',
        artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
      });
      manager.markCompleted('sub-1', 'Task done');

      const result = await handleAwaitRpc(ctx, { subagentId: 'sub-1' });
      expect(result.status).toBe('completed');
      expect(result.result).toBe('Task done');
      expect(result.toolObservations).toEqual([
        {
          toolName: 'artifacts_get',
          outcome: 'success',
          artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
        },
      ]);
    });

    it('returns immediately if subagent already failed', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.markFailed('sub-1', 'Something went wrong');

      const result = await handleAwaitRpc(ctx, { subagentId: 'sub-1' });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Something went wrong');
    });

    it('returns immediately if subagent already cancelled', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.markCancelled('sub-1');

      const result = await handleAwaitRpc(ctx, { subagentId: 'sub-1' });
      expect(result.status).toBe('cancelled');
    });

    it('returns waiting_input if subagent has pending request', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setPendingRequest('sub-1', {
        messageId: 'msg-1',
        question: 'What color?',
        context: 'Choosing theme',
        resolver: () => {},
      });

      const result = await handleAwaitRpc(ctx, { subagentId: 'sub-1' });
      expect(result.status).toBe('waiting_input');
      expect(result.pendingRequest).toEqual({
        messageId: 'msg-1',
        question: 'What color?',
        context: 'Choosing theme',
      });
    });

    it('returns timeout status when timeout expires', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');

      const result = await handleAwaitRpc(ctx, { subagentId: 'sub-1', timeoutMs: 50 });
      expect(result.status).toBe('timeout');
    });

    it('cleans up awaiter on timeout to prevent memory leak', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');

      await handleAwaitRpc(ctx, { subagentId: 'sub-1', timeoutMs: 10 });

      // Verify no leak: add new awaiter, complete, and verify only new one is called
      let awaiterCalled = false;
      manager.addAwaiter('sub-1', () => {
        awaiterCalled = true;
      });
      manager.markCompleted('sub-1', 'Done');
      expect(awaiterCalled).toBe(true);
    });

    it('resolves when subagent completes', async () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Test'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-1');

      const resultPromise = handleAwaitRpc(ctx, { subagentId: 'sub-1', timeoutMs: 5000 });
      setTimeout(() => manager.markCompleted('sub-1', 'Task finished'), 10);

      const result = await resultPromise;
      expect(result.status).toBe('completed');
      expect(result.result).toBe('Task finished');
    });
  });

  describe('handleListBySessionRpc', () => {
    it('returns empty array when no subagents tracked for the session', () => {
      const result = handleListBySessionRpc(ctx, { parentSessionId: 'parent-1' });
      expect(result.subagents).toEqual([]);
    });

    it('returns only non-terminal subagents for the requested parent session', () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('Task A'), depth: 1 });
      manager.track({ subagentId: 'sub-2', parentSessionId: 'parent-1', config: config('Task B'), depth: 1 });
      // Terminal — should not appear
      manager.track({ subagentId: 'sub-3', parentSessionId: 'parent-1', config: config('Task C'), depth: 1 });
      manager.markCompleted('sub-3', 'done');
      // Different parent — should not appear
      manager.track({ subagentId: 'sub-4', parentSessionId: 'parent-2', config: config('Task D'), depth: 1 });

      const result = handleListBySessionRpc(ctx, { parentSessionId: 'parent-1' });

      expect(result.subagents).toHaveLength(2);
      expect(result.subagents.map((s) => s.subagentId)).toEqual(expect.arrayContaining(['sub-1', 'sub-2']));
    });

    it('maps subagent summary fields correctly', () => {
      manager.track({ subagentId: 'sub-1', parentSessionId: 'parent-1', config: config('My Task'), depth: 1 });
      manager.setChildSessionId('sub-1', 'child-session');

      const result = handleListBySessionRpc(ctx, { parentSessionId: 'parent-1' });

      expect(result.subagents).toHaveLength(1);
      expect(result.subagents[0]).toMatchObject({
        subagentId: 'sub-1',
        task: 'My Task',
        status: 'running',
      });
    });
  });
});
