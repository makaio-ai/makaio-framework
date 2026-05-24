import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

describe('SubagentService child-session terminal races', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    MakaioBus.__resetHandlers?.();
  });

  it('closes a child session created after the subagent already completed', async () => {
    const closedSessions: string[] = [];
    const startAgentCalls: unknown[] = [];

    MakaioBus.on(SessionSubjects.create, async (ctx) => {
      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: 'sub-race',
        result: 'done',
      });
      ctx.setResult({ sessionId: 'child-race' });
    });
    MakaioBus.on(SessionSubjects.close, (ctx) => {
      closedSessions.push(ctx.payload.sessionId);
      ctx.setResult({ success: true });
    });
    mocks.setStartAgentHandler((ctx) => {
      startAgentCalls.push(ctx.payload);
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: 'resolved-claude-code',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-race',
        messageId: 'msg-1',
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, {
      subagentId: 'sub-race',
      parentSessionId: 'parent-1',
      task: 'Test task',
      config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
      depth: 1,
    });

    await vi.waitFor(() => expect(closedSessions).toEqual(['child-race']));
    expect(startAgentCalls).toHaveLength(0);
  });
});
