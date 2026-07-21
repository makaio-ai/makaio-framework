import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectPayload } from '@makaio/core';
import { AgentSubjects, SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

describe('SubagentService lifecycle projection', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus);
    MakaioBus.on(SessionSubjects.create, (ctx) => ctx.setResult({ sessionId: 'child-sess-1' }));
    MakaioBus.on(SessionSubjects.close, (ctx) => ctx.setResult({ success: true }));
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
    await service.init();
    await MakaioBus.emit(SubagentSubjects.spawned, {
      subagentId: 'sub-1',
      parentSessionId: 'parent-1',
      task: 'Test task',
      config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fresh' },
      depth: 1,
    });
    await vi.waitFor(async () => {
      await expect(MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-1' })).resolves.toMatchObject({
        status: 'running',
      });
    });
  });

  afterEach(() => service.destroy());

  it('ignores backfilled turns when validating completion', async () => {
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'child-sess-1',
      turnId: 'turn-backfill',
      turnNumber: 1,
      messageId: 'msg-1',
      agentIds: ['agent-1'],
      ingestionMarker: 'backfill',
    });

    await expect(
      MakaioBus.request(SubagentSubjects.completeTask, { sessionId: 'child-sess-1', result: 'Wrong turn' }),
    ).rejects.toThrow('No active turn exists');
  });

  it('accepts contract-valid lifecycle events without an ingestion marker', async () => {
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'child-sess-1',
      turnId: 'turn-legacy',
      turnNumber: 1,
      messageId: 'msg-1',
      agentIds: ['agent-1'],
    });
    await MakaioBus.request(SubagentSubjects.completeTask, { sessionId: 'child-sess-1', result: 'Done' });
    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: 'child-sess-1',
      turnId: 'turn-legacy',
      turnNumber: 1,
      success: true,
    });

    await expect(MakaioBus.request(SubagentSubjects.await, { subagentId: 'sub-1' })).resolves.toMatchObject({
      status: 'completed',
      result: 'Done',
    });
  });

  it('ignores imported child tool completions', async () => {
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'child-sess-1',
      turnId: 'turn-1',
      turnNumber: 1,
      messageId: 'msg-1',
      agentIds: ['agent-1'],
      ingestionMarker: 'live',
    });
    const importedCompletion: ExtractSubjectPayload<typeof AgentSubjects.tool.completed> & { readonly _import: true } =
      {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        sessionId: 'child-sess-1',
        toolName: 'read_file',
        toolCallId: 'imported-tool-1',
        result: 'historical',
        success: true,
        _import: true,
      };
    await MakaioBus.emit(AgentSubjects.tool.completed, importedCompletion);
    await MakaioBus.request(SubagentSubjects.completeTask, { sessionId: 'child-sess-1', result: 'Done' });
    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: 'child-sess-1',
      turnId: 'turn-1',
      turnNumber: 1,
      success: true,
      ingestionMarker: 'live',
    });

    await expect(MakaioBus.request(SubagentSubjects.await, { subagentId: 'sub-1' })).resolves.toMatchObject({
      status: 'completed',
      usage: { toolCallCount: 0 },
      toolObservations: [],
    });
  });
});
