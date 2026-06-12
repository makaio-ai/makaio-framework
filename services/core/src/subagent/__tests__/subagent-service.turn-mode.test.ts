// NOTE: do NOT change eslint rules without explicit human approval
/* eslint max-lines: ["error", { "max": 400, "skipBlankLines": true, "skipComments": true }] */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

/**
 * Builds a minimal `agent.complete` payload for a given session.
 * @param sessionId - Child session the event targets
 * @param overrides - Fields to override on the base payload
 * @returns Complete agent.complete bus payload
 */
function agentCompletePayload(
  sessionId: string,
  overrides: Partial<{
    outcome: 'completed' | 'error' | 'superseded' | 'merged' | 'cancelled' | 'rejected';
    message: string;
    error: string;
  }> = {},
) {
  return {
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'claude-code',
    adapterSessionId: 'adapter-session-1',
    sessionId,
    messageId: 'msg-1',
    message: overrides.message ?? 'The result',
    outcome: overrides.outcome,
    error: overrides.error,
  };
}

/** Base config for a turn-mode subagent spawn. */
const TURN_SPAWN = {
  subagentId: 'sub-turn-1',
  parentSessionId: 'parent-1',
  task: 'Summarize report',
  config: {
    task: 'Summarize report',
    adapterName: 'claude-code',
    contextMode: 'fresh' as const,
    completion: 'turn' as const,
  },
  depth: 1,
};

/** Base config for a tool-mode subagent spawn (default). */
const TOOL_SPAWN = {
  subagentId: 'sub-tool-1',
  parentSessionId: 'parent-1',
  task: 'Build feature',
  config: {
    task: 'Build feature',
    adapterName: 'claude-code',
    contextMode: 'fresh' as const,
    // completion omitted → defaults to 'tool'
  },
  depth: 1,
};

describe('SubagentService — turn-mode completion', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;
  let closedSessions: string[];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus);
    closedSessions = [];

    // Wire session creation for all tests in this suite
    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-sess-1' });
    });
    MakaioBus.on(SessionSubjects.close, (ctx) => {
      closedSessions.push(ctx.payload.sessionId);
      ctx.setResult({ success: true });
    });

    await service.init();
  });

  afterEach(() => {
    service.destroy();
  });

  /**
   * Spawn a subagent and wait for it to reach 'running' status.
   * @param spawn - Spawn payload
   * @returns Resolved child session ID
   */
  async function spawnAndWaitRunning(spawn: typeof TURN_SPAWN | typeof TOOL_SPAWN): Promise<string> {
    mocks.setStartAgentHandler((ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-sess-1',
        messageId: 'msg-1',
      });
    });
    await MakaioBus.emit(SubagentSubjects.spawned, spawn);
    // Wait until the manager records the child session ID
    await vi.waitFor(async () => {
      const status = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: spawn.subagentId,
      });
      expect(status.status).toBe('running');
    });
    return 'child-sess-1';
  }

  describe('turn-mode — agent.complete terminalizes', () => {
    it('terminalizes with result when outcome is completed', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      const awaiter = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-turn-1',
        timeoutMs: 5_000,
      });

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'completed', message: 'Summary complete' }),
      );

      const result = await awaiter;
      expect(result.status).toBe('completed');
      expect(result.result).toBe('Summary complete');
      expect(result.completionSource).toBe('turn');
    });

    it('terminalizes with result when outcome is absent (legacy emitters)', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      const awaiter = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-turn-1',
        timeoutMs: 5_000,
      });

      // Emit without outcome — legacy emitter path
      const payload = agentCompletePayload('child-sess-1', { message: 'Legacy result' });
      const { outcome: _omitted, ...payloadWithoutOutcome } = payload;
      await MakaioBus.emit(AgentSubjects.complete, payloadWithoutOutcome);

      const result = await awaiter;
      expect(result.status).toBe('completed');
      expect(result.result).toBe('Legacy result');
      expect(result.completionSource).toBe('turn');
    });

    it('marks failed when outcome is error', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      const awaiter = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-turn-1',
        timeoutMs: 5_000,
      });

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', {
          outcome: 'error',
          error: 'context window exceeded',
        }),
      );

      const result = await awaiter;
      expect(result.status).toBe('failed');
      expect(result.error).toBe('context window exceeded');
    });

    it.each([
      'superseded',
      'merged',
      'cancelled',
      'rejected',
    ] as const)('ignores non-result outcome "%s" — subagent stays non-terminal', async (outcome) => {
      await spawnAndWaitRunning(TURN_SPAWN);

      await MakaioBus.emit(AgentSubjects.complete, agentCompletePayload('child-sess-1', { outcome }));

      const status = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-turn-1',
      });
      expect(status.status).toBe('running');
    });
  });

  describe('turn-mode — waiting_input guard', () => {
    it('ignores agent.complete during a pending requestInput round-trip', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      // Inject a pending requestInput without waiting for the async bus emit
      // (the bus emit for toParent happens inside requestInput RPC, but we can
      // prime the manager state via the RPC — don't await, just let it pend)
      const inputPromise = MakaioBus.request(SubagentSubjects.requestInput, {
        subagentId: 'sub-turn-1',
        question: 'Which format do you want?',
        timeoutMs: 10_000,
      });

      // Wait for waiting_input status
      await vi.waitFor(async () => {
        const s = await MakaioBus.request(SubagentSubjects.getStatus, {
          subagentId: 'sub-turn-1',
        });
        expect(s.status).toBe('waiting_input');
      });

      // Now emit agent.complete — this should be ignored because the subagent is waiting_input
      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'completed', message: 'Ignored turn' }),
      );

      // Subagent should still be in waiting_input
      const status = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-turn-1',
      });
      expect(status.status).toBe('waiting_input');

      // Clean up
      await MakaioBus.request(SubagentSubjects.send, {
        subagentId: 'sub-turn-1',
        content: 'JSON',
        inResponseTo: status.pendingRequest?.messageId,
      });
      await inputPromise;
    });
  });

  describe('turn-mode — child session cleanup', () => {
    it('closes the child session after turn-mode completion', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'completed', message: 'Done' }),
      );

      await vi.waitFor(() => {
        expect(closedSessions).toContain('child-sess-1');
      });
    });

    it('closes the child session after a turn-mode error outcome', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'error', error: 'context window exceeded' }),
      );

      await vi.waitFor(() => {
        expect(closedSessions).toContain('child-sess-1');
      });
    });

    it('emits subagent.completed with success: false for the error outcome', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      const completedEvents: Array<{ success: boolean; error?: string }> = [];
      const cleanup = MakaioBus.on(SubagentSubjects.completed, (ctx) => {
        completedEvents.push({ success: ctx.payload.success, error: ctx.payload.error });
      });

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'error', error: 'boom' }),
      );

      await vi.waitFor(() => {
        expect(completedEvents).toEqual([{ success: false, error: 'boom' }]);
      });
      cleanup();
    });
  });

  describe('first-terminal-wins', () => {
    it('completeTask first: agent.complete after completeTask does not override result', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      // completeTask wins first
      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: 'sub-turn-1',
        result: 'Tool result',
      });

      const statusAfterTool = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-turn-1',
      });
      expect(statusAfterTool.status).toBe('completed');
      expect(statusAfterTool.result).toBe('Tool result');

      // agent.complete arrives late — should be silently ignored
      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'completed', message: 'Late turn result' }),
      );

      const statusAfterTurn = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-turn-1',
      });
      // Tool result must stand
      expect(statusAfterTurn.status).toBe('completed');
      expect(statusAfterTurn.result).toBe('Tool result');
    });

    it('completeTask sets completionSource to tool', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      const awaiter = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-turn-1',
        timeoutMs: 5_000,
      });

      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: 'sub-turn-1',
        result: 'Tool result',
      });

      const response = await awaiter;
      expect(response.status).toBe('completed');
      expect(response.completionSource).toBe('tool');
    });
  });

  describe('tool-mode — agent.complete must NOT terminalize', () => {
    it('does not terminalize when completion is omitted (default tool mode)', async () => {
      await spawnAndWaitRunning(TOOL_SPAWN);

      await MakaioBus.emit(
        AgentSubjects.complete,
        agentCompletePayload('child-sess-1', { outcome: 'completed', message: 'Turn done' }),
      );

      const status = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-tool-1',
      });
      expect(status.status).toBe('running');
    });

    it('completeTask in tool mode reports completionSource tool', async () => {
      await spawnAndWaitRunning(TOOL_SPAWN);

      const awaiter = MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-tool-1',
        timeoutMs: 5_000,
      });

      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: 'sub-tool-1',
        result: 'Tool finished',
      });

      const response = await awaiter;
      expect(response.status).toBe('completed');
      expect(response.completionSource).toBe('tool');
    });

    it('reports completionSource on await issued after termination (early-return path)', async () => {
      await spawnAndWaitRunning(TOOL_SPAWN);

      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: 'sub-tool-1',
        result: 'Tool finished',
      });

      // Await AFTER the subagent is already terminal — exercises the
      // early-return branch of handleAwaitRpc, not the awaiter callback.
      const response = await MakaioBus.request(SubagentSubjects.await, {
        subagentId: 'sub-tool-1',
        timeoutMs: 1_000,
      });
      expect(response.status).toBe('completed');
      expect(response.completionSource).toBe('tool');
    });
  });

  describe('sessionId guard', () => {
    it('does not throw when agent.complete has no sessionId (legacy emitter)', async () => {
      await spawnAndWaitRunning(TURN_SPAWN);

      // Payload without sessionId — should be silently ignored
      await expect(
        MakaioBus.emit(AgentSubjects.complete, {
          agentId: 'agent-1',
          adapterId: 'adapter-1',
          adapterName: 'claude-code',
          adapterSessionId: 'adapter-session-1',
          messageId: 'msg-1',
          message: 'No session ID',
        }),
      ).resolves.not.toThrow();

      const status = await MakaioBus.request(SubagentSubjects.getStatus, {
        subagentId: 'sub-turn-1',
      });
      expect(status.status).toBe('running');
    });
  });
});
