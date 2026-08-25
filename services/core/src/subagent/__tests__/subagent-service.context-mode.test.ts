import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, SubagentSubjects } from '@makaio/contracts';
import type { ResponseSchemaDescriptor } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/index.js';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { MakaioSessionService } from '../../session/session-service.js';
import { registerMemorySessionStorage } from '../../session/storage/memory-handler.js';
import { SubagentService } from '../subagent-service.js';
import { registerSubagentSessionOrchestrationMocks } from './subagent-service.mocks.js';

describe('SubagentService - context mode', () => {
  let sessionService: MakaioSessionService;
  let subagentService: SubagentService;
  let cleanupStorage: (() => void) | undefined;
  let attachPayloads: Array<{ responseSchema?: ResponseSchemaDescriptor }>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupStorage = registerMemorySessionStorage(MakaioBus);
    sessionService = new MakaioSessionService(MakaioBus);
    subagentService = new SubagentService(MakaioBus);
    attachPayloads = [];

    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    });
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: ctx.payload.executionTargetId ?? 'system:local',
          name: 'Local',
          description: 'Local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });
    registerSubagentSessionOrchestrationMocks(MakaioBus, {
      onAttachResolvedPayload: (payload) => {
        attachPayloads.push(payload);
      },
    });
    await sessionService.init();
    await subagentService.init();
  });

  afterEach(() => {
    subagentService.destroy();
    sessionService.destroy();
    cleanupStorage?.();
    cleanupStorage = undefined;
  });

  it('creates fresh subagent sessions with persisted lineage and no parent-history inheritance', async () => {
    const { sessionId: parentSessionId } = await MakaioBus.request(SessionSubjects.create, {
      title: 'Parent',
    });
    let childSessionId: string | undefined;
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      childSessionId = String(ctx.payload.sessionId ?? '');
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: String(ctx.payload.adapterId),
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-1',
        sessionId: childSessionId,
        messageId: 'msg-1',
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, {
      subagentId: 'sub-fresh-1',
      parentSessionId,
      task: 'Fresh task',
      config: { task: 'Fresh task', adapterName: 'claude-code', contextMode: 'fresh' },
      depth: 1,
    });

    await vi.waitFor(() => expect(childSessionId).toBeDefined());
    const { session: childSession } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: childSessionId!,
    });

    expect(childSession).toMatchObject({
      parentSessionId,
      branchKind: 'subagent',
      contextInheritance: 'none',
    });
  });

  it('forwards structured output schemas to adapter startup', async () => {
    const { sessionId: parentSessionId } = await MakaioBus.request(SessionSubjects.create, {
      title: 'Parent',
    });
    const responseSchema: ResponseSchemaDescriptor = {
      schema: { type: 'object', properties: { verdict: { type: 'string' } } },
      name: 'verdict_schema',
    };
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: String(ctx.payload.adapterId),
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-structured',
        sessionId: String(ctx.payload.sessionId ?? 'session-missing'),
        messageId: 'msg-structured',
      });
    });

    await MakaioBus.request(SubagentSubjects.spawn, {
      parentSessionId,
      config: {
        task: 'Return structured review',
        adapterName: 'claude-code',
        contextMode: 'fresh',
        responseSchema,
      },
      depth: 1,
    });

    await vi.waitFor(() => expect(attachPayloads.at(-1)?.responseSchema).toEqual(responseSchema));
  });

  it('closes child sessions when subagents complete or cancel', async () => {
    const { sessionId: parentSessionId } = await MakaioBus.request(SessionSubjects.create, {
      title: 'Parent',
    });
    const childSessionIds: string[] = [];
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      const childSessionId = String(ctx.payload.sessionId ?? '');
      childSessionIds.push(childSessionId);
      ctx.setResult({
        success: true,
        agentId: `mock-agent-${childSessionIds.length}`,
        adapterId: String(ctx.payload.adapterId),
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: `adapter-session-${childSessionIds.length}`,
        sessionId: childSessionId,
        messageId: `msg-${childSessionIds.length}`,
      });
    });

    await MakaioBus.request(SubagentSubjects.spawn, {
      parentSessionId,
      config: { task: 'Complete task', adapterName: 'claude-code', contextMode: 'fresh' },
      depth: 1,
    });
    const { subagentId: cancelledSubagentId } = await MakaioBus.request(SubagentSubjects.spawn, {
      parentSessionId,
      config: { task: 'Cancel task', adapterName: 'claude-code', contextMode: 'fresh' },
      depth: 1,
    });

    await vi.waitFor(() => expect(childSessionIds).toHaveLength(2));
    const [completedChildSessionId, cancelledChildSessionId] = childSessionIds as [string, string];

    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: completedChildSessionId,
      turnId: 'turn-1',
      turnNumber: 1,
      messageId: 'msg-1',
      agentIds: ['agent-1'],
      ingestionMarker: 'live',
    });
    await MakaioBus.request(SubagentSubjects.completeTask, {
      sessionId: completedChildSessionId,
      result: 'done',
    });
    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: completedChildSessionId,
      turnId: 'turn-1',
      turnNumber: 1,
      success: true,
      ingestionMarker: 'live',
    });
    await MakaioBus.request(SubagentSubjects.kill, {
      subagentId: cancelledSubagentId,
      reason: 'test cancellation',
    });

    await vi.waitFor(async () => {
      const [{ session: completedChild }, { session: cancelledChild }] = await Promise.all([
        MakaioBus.request(SessionSubjects.get, { sessionId: completedChildSessionId }),
        MakaioBus.request(SessionSubjects.get, { sessionId: cancelledChildSessionId }),
      ]);
      expect(completedChild?.status).toBe('closed');
      expect(cancelledChild?.status).toBe('closed');
    });
  });
});
