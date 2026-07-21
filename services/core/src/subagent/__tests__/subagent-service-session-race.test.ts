import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

/**
 * Execute the shared child-session race fixture.
 * @returns Pending subagent execution result.
 */
function executeRaceSubagent() {
  return MakaioBus.request(SubagentSubjects.execute, {
    subagentId: 'sub-race',
    parentSessionId: 'parent-1',
    task: 'Test task',
    config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
    depth: 1,
  });
}

describe('SubagentService child-session terminal races', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;
  let attachPayloads: Array<{ initialMessage?: unknown; source?: string }>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    attachPayloads = [];
    mocks = setupSubagentServiceMocks(MakaioBus, {
      onAttachResolvedPayload: (payload) => attachPayloads.push(payload),
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    MakaioBus.__resetHandlers?.();
  });

  it('closes a child session created after the subagent was already cancelled', async () => {
    const closedSessions: string[] = [];
    const startAgentCalls: unknown[] = [];

    MakaioBus.on(SessionSubjects.create, async (ctx) => {
      await MakaioBus.request(SubagentSubjects.kill, {
        subagentId: 'sub-race',
        reason: 'cancelled during creation',
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

  it('keeps child messaging closed until the initial task is admitted atomically', async () => {
    const attachStarted = Promise.withResolvers<void>();
    const releaseAttach = Promise.withResolvers<void>();

    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-race' });
    });
    mocks.setStartAgentHandler(async (ctx) => {
      attachStarted.resolve();
      await releaseAttach.promise;
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: 'resolved-claude-code',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-race',
        messageId: 'msg-1',
      });
    });

    const execution = executeRaceSubagent();
    await attachStarted.promise;
    await expect(MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-race' })).resolves.toMatchObject({
      status: 'spawning',
    });
    await expect(
      MakaioBus.request(SubagentSubjects.send, { subagentId: 'sub-race', content: 'Premature message' }),
    ).rejects.toThrow('Cannot send to a subagent before startup completes');
    releaseAttach.resolve();
    await expect(execution).resolves.toEqual({ success: true });

    expect(attachPayloads).toEqual([expect.objectContaining({ initialMessage: 'Test task', source: 'system' })]);
    await expect(MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-race' })).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('keeps cancellation authoritative when adapter attach aborts', async () => {
    const attachStarted = Promise.withResolvers<void>();
    const releaseAttach = Promise.withResolvers<void>();
    const executionFailures: unknown[] = [];

    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-race' });
    });
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      executionFailures.push(ctx.payload);
    });
    mocks.setStartAgentHandler(async () => {
      attachStarted.resolve();
      await releaseAttach.promise;
      throw new Error('session closed during adapter startup');
    });

    const execution = executeRaceSubagent();
    await attachStarted.promise;
    await MakaioBus.request(SubagentSubjects.kill, {
      subagentId: 'sub-race',
      reason: 'cancelled during attach',
    });
    releaseAttach.resolve();
    await expect(execution).resolves.toEqual({ success: true });

    await expect(MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-race' })).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(executionFailures).toHaveLength(0);
  });

  it('prevents initial task admission when cancellation wins a successful adapter startup race', async () => {
    const attachStarted = Promise.withResolvers<void>();
    const releaseAttach = Promise.withResolvers<void>();
    const routedMessages: unknown[] = [];

    await service.destroy();
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus, {
      onSendMessagePayload: (payload) => routedMessages.push(payload),
    });
    await service.init();
    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-race' });
    });
    mocks.setStartAgentHandler(async (ctx) => {
      attachStarted.resolve();
      await releaseAttach.promise;
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: 'resolved-claude-code',
        adapterSessionId: 'adapter-session-1',
        sessionId: 'child-race',
        messageId: 'msg-1',
      });
    });

    const execution = executeRaceSubagent();
    await attachStarted.promise;
    await MakaioBus.request(SubagentSubjects.kill, {
      subagentId: 'sub-race',
      reason: 'cancelled during successful attach',
    });
    releaseAttach.resolve();
    await expect(execution).resolves.toEqual({ success: true });

    expect(routedMessages).toHaveLength(0);
    await expect(MakaioBus.request(SubagentSubjects.getStatus, { subagentId: 'sub-race' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('classifies atomic initial-task admission failures as agent_start', async () => {
    const executionFailures: Array<{ phase?: string; error?: string }> = [];

    await service.destroy();
    MakaioBus.__resetHandlers?.();
    service = new SubagentService(MakaioBus);
    mocks = setupSubagentServiceMocks(MakaioBus, {
      onSendMessagePayload: () => {
        throw new Error('Initial task routing failed');
      },
    });
    await service.init();
    MakaioBus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-race' });
    });
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      executionFailures.push(ctx.payload);
    });

    await MakaioBus.emit(SubagentSubjects.spawned, {
      subagentId: 'sub-race',
      parentSessionId: 'parent-1',
      task: 'Test task',
      config: { task: 'Test task', adapterName: 'claude-code', contextMode: 'fork' },
      depth: 1,
    });
    await vi.waitFor(() => expect(executionFailures).toHaveLength(1));

    expect(executionFailures[0]).toMatchObject({
      phase: 'agent_start',
      error: expect.stringContaining('Initial task routing failed'),
    });
  });
});
