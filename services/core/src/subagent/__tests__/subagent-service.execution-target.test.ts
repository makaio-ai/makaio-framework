import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, SubagentSubjects, type IMakaioSession } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { MakaioSessionService } from '../../session/session-service.js';
import { registerMemorySessionStorage } from '../../session/storage/memory-handler.js';
import { SubagentService } from '../subagent-service.js';

const PARENT_SESSION_ID = 'parent-1';
const SUB1_SPAWN = {
  subagentId: 'sub-1',
  parentSessionId: PARENT_SESSION_ID,
  task: 'Test task',
  config: {
    task: 'Test task',
    adapterName: 'claude-code',
    contextMode: 'fork' as const,
  },
  depth: 1,
};

describe('SubagentService - execution target inheritance', () => {
  let sessionService: MakaioSessionService;
  let subagentService: SubagentService;
  let cleanupStorage: (() => void) | undefined;
  let startedSessionIds: string[];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupStorage = registerMemorySessionStorage(MakaioBus);
    sessionService = new MakaioSessionService(MakaioBus);
    subagentService = new SubagentService(MakaioBus);
    startedSessionIds = [];

    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    });

    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      if (ctx.payload.sessionId === undefined) {
        throw new Error('Adapter start payload is missing sessionId');
      }
      const sessionId = ctx.payload.sessionId;
      startedSessionIds.push(sessionId);
      ctx.setResult({
        success: true,
        agentId: 'mock-agent',
        adapterId: String(ctx.payload.adapterId),
        adapterSessionId: 'adapter-session-1',
        sessionId,
        messageId: 'msg-1',
      });
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

  async function createParentSession(executionTargetId?: string): Promise<void> {
    await MakaioBus.request(SessionSubjects.create, {
      sessionId: PARENT_SESSION_ID,
      ...(executionTargetId !== undefined && { executionTargetId }),
    });
  }

  async function getStartedChildSession(): Promise<IMakaioSession> {
    await vi.waitFor(() => expect(startedSessionIds).toHaveLength(1));
    let childSession: IMakaioSession | null = null;

    await vi.waitFor(async () => {
      const result = await MakaioBus.request(SessionSubjects.get, {
        sessionId: startedSessionIds[0]!,
      });
      childSession = result.session;
      expect(childSession).not.toBeNull();
    });

    if (childSession === null) {
      throw new Error('Started child session was not persisted');
    }
    return childSession;
  }

  it('resolves from parent session context when no explicit executionTargetId is provided', async () => {
    await createParentSession('target-parent');

    let resolvePayload: { executionTargetId?: string } | undefined;
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      resolvePayload = ctx.payload;
      ctx.setResult({
        executionTarget: {
          id: 'system:local',
          name: 'Local',
          description: 'Default local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

    await vi.waitFor(() => expect(resolvePayload).toBeDefined());
    expect(resolvePayload).toEqual({ executionTargetId: 'target-parent' });
  });

  it('creates child sessions with parent lineage without stamping fallback local execution targets', async () => {
    await createParentSession();
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: 'target-workstream',
          name: 'Workstream Target',
          description: 'Resolved from workstream default',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

    const childSession = await getStartedChildSession();
    expect(childSession).toMatchObject({
      parentSessionId: PARENT_SESSION_ID,
      branchKind: 'subagent',
      contextInheritance: 'parent-history',
    });
    expect(childSession.executionTargetId).toBeUndefined();
  });

  it('persists inherited local execution target IDs on child sessions', async () => {
    await createParentSession('target-parent');
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: ctx.payload.executionTargetId ?? 'system:local',
          name: 'Inherited Local Target',
          description: 'Parent-selected local target',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

    const childSession = await getStartedChildSession();
    expect(childSession.executionTargetId).toBe('target-parent');
  });

  it('uses explicit executionTargetId without requiring parent storage fallback', async () => {
    let resolvePayload: { executionTargetId?: string } | undefined;
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      resolvePayload = ctx.payload;
      ctx.setResult({
        executionTarget: {
          id: 'system:local',
          name: 'Local',
          description: 'Default local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    });

    await MakaioBus.emit(SubagentSubjects.spawned, {
      ...SUB1_SPAWN,
      config: {
        ...SUB1_SPAWN.config,
        executionTargetId: 'target-explicit',
      },
    });

    await vi.waitFor(() => expect(resolvePayload).toBeDefined());
    expect(resolvePayload).toEqual({ executionTargetId: 'target-explicit' });
    const childSession = await getStartedChildSession();
    expect(childSession.executionTargetId).toBe('target-explicit');
  });

  it('fails fast when parent session is missing for inheritance fallback', async () => {
    const failedEvents: unknown[] = [];
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      failedEvents.push(ctx.payload);
    });

    await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

    await vi.waitFor(() => expect(failedEvents).toHaveLength(1));
    expect(failedEvents[0]).toMatchObject({
      subagentId: 'sub-1',
      phase: 'adapter_start',
      error: expect.stringContaining('Parent session not found: parent-1'),
    });
  });

  it('throws when explicit executionTargetId is provided but no resolver is registered', async () => {
    const failedEvents: unknown[] = [];
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      failedEvents.push(ctx.payload);
    });

    // No ExecutionTargetSubjects.resolve handler - requestOptional returns { handled: false }.
    // With an explicit executionTargetId the service must surface the misconfiguration.
    await MakaioBus.emit(SubagentSubjects.spawned, {
      ...SUB1_SPAWN,
      config: {
        ...SUB1_SPAWN.config,
        executionTargetId: 'target-explicit',
      },
    });

    await vi.waitFor(() => expect(failedEvents).toHaveLength(1));
    expect(failedEvents[0]).toMatchObject({
      subagentId: 'sub-1',
      phase: 'adapter_start',
      error: expect.stringContaining("target 'target-explicit'"),
    });
  });

  it('uses local fallback target when no executionTargetId and no resolver is registered', async () => {
    await createParentSession();

    // No ExecutionTargetSubjects.resolve handler - requestOptional returns { handled: false }.
    // With no explicit ID, the service falls back to SUBAGENT_DEFAULT_LOCAL_TARGET.
    await MakaioBus.emit(SubagentSubjects.spawned, SUB1_SPAWN);

    const childSession = await getStartedChildSession();
    expect(childSession.executionTargetId).toBeUndefined();
  });
});
