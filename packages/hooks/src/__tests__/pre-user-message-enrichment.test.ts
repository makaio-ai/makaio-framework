import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { TurnStorageSubjects } from '@makaio/services-core/turn';
import { createHook } from '../create-hook.js';
import { runPreUserMessageHooks, resetPreUserMessageHooks } from '../runners/pre-user-message-runner.js';
import type { PreUserMessageContext } from '../types/hook-context.js';
import { createRunnerInput } from './pre-user-message-helpers.js';

type TestWorktree = {
  id: string;
  repoId: string;
  path: string;
  branch: string;
  isMain: boolean;
  createdAt: number;
  lastActivityAt: number;
};

describe('PreUserMessage session enrichment', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    resetPreUserMessageHooks();
  });

  it('provides session when sessionId is in payload', async () => {
    // Session without projectId - tests basic session enrichment
    const mockSession = {
      sessionId: 'session-123',
      status: 'active' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agents: [],
    };

    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        ctx.setResult({ session: mockSession });
      },
      { priority: 1000 },
    );

    const unsubTurns = MakaioBus.on(
      TurnStorageSubjects.getBySession,
      (ctx) => {
        ctx.setResult({ turns: [] });
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: 'session-123',
      }),
      MakaioBus,
    );

    expect(capturedCtx?.session).toBeDefined();
    expect(capturedCtx?.session?.sessionId).toBe('session-123');

    unsubscribe();
    unsubGet();
    unsubTurns();
  });

  it('enriches context with session and project from bus', async () => {
    const mockSession = {
      sessionId: 'session-abc',
      status: 'active' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agents: [],
    };

    const mockProject = {
      id: 'project-xyz',
      name: 'Test Project',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        if (ctx.payload.sessionId === 'session-abc') {
          ctx.setResult({ session: mockSession });
        } else {
          ctx.setResult({ session: null });
        }
      },
      { priority: 1000 },
    );

    const unsubTurns = MakaioBus.on(
      TurnStorageSubjects.getBySession,
      (ctx) => {
        ctx.setResult({ turns: [] });
      },
      { priority: 1000 },
    );

    // Host-side enrichContext seam provides project/worktree
    const unsubEnrich = MakaioBus.on(
      SessionSubjects.enrichContext,
      (ctx) => {
        if (ctx.payload.sessionId === 'session-abc') {
          ctx.setResult({ project: mockProject });
        } else {
          ctx.setResult({});
        }
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: 'session-abc',
      }),
      MakaioBus,
    );

    expect(capturedCtx?.session?.sessionId).toBe('session-abc');
    const project = capturedCtx?.contextExtensions.project as Record<string, unknown> | undefined;
    expect(project?.id).toBe('project-xyz');
    expect(project?.name).toBe('Test Project');

    unsubscribe();
    unsubGet();
    unsubTurns();
    unsubEnrich();
  });

  it('handles missing session gracefully', async () => {
    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        ctx.setResult({ session: null });
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: 'nonexistent-session',
      }),
      MakaioBus,
    );

    expect(capturedCtx?.session).toBeUndefined();
    expect(capturedCtx?.project).toBeUndefined();
    expect(capturedCtx?.recentHistory).toEqual([]);

    unsubscribe();
    unsubGet();
  });

  it('maintains backwards compatibility without sessionId', async () => {
    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: undefined,
      }),
      MakaioBus,
    );

    expect(capturedCtx?.session).toBeUndefined();
    expect(capturedCtx?.project).toBeUndefined();
    expect(capturedCtx?.recentHistory).toEqual([]);
    expect(capturedCtx?.payload.agentId).toBe('agent-1');

    unsubscribe();
  });

  it('does not allow context extensions to override framework-owned fields', async () => {
    const mockSession = {
      sessionId: 'session-owned-fields',
      status: 'active' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agents: [],
    };

    const unsubGet = MakaioBus.on(SessionSubjects.get, (ctx) => {
      ctx.setResult({ session: mockSession });
    });
    const unsubTurns = MakaioBus.on(TurnStorageSubjects.getBySession, (ctx) => {
      ctx.setResult({ turns: [] });
    });
    const unsubEnrich = MakaioBus.on(SessionSubjects.enrichContext, (ctx) => {
      ctx.setResult({
        project: { id: 'project-1', name: 'Project 1', createdAt: Date.now(), updatedAt: Date.now() },
        hookEvent: 'fake',
        payload: 'override',
        session: { sessionId: 'fake-session' },
      });
    });

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(createRunnerInput({ sessionId: 'session-owned-fields' }), MakaioBus);

    expect(capturedCtx?.hookEvent).toBe('PreUserMessage');
    expect(capturedCtx?.payload.sessionId).toBe('session-owned-fields');
    expect(capturedCtx?.session?.sessionId).toBe('session-owned-fields');
    expect((capturedCtx?.contextExtensions.project as Record<string, unknown>)?.id).toBe('project-1');

    unsubscribe();
    unsubEnrich();
    unsubTurns();
    unsubGet();
  });

  it('includes recent turn history when available', async () => {
    const now = Date.now();
    const mockSession = {
      sessionId: 'session-with-history',
      status: 'active' as const,
      createdAt: now - 60000,
      lastActivityAt: now,
      agents: [],
    };

    const mockTurns = [
      {
        turnId: 'turn-1',
        sessionId: 'session-with-history',
        turnNumber: 1,
        startedAt: now - 30000,
        completedAt: now - 25000,
        status: 'completed' as const,
      },
      {
        turnId: 'turn-2',
        sessionId: 'session-with-history',
        turnNumber: 2,
        startedAt: now - 20000,
        completedAt: now - 15000,
        status: 'completed' as const,
      },
    ];

    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        ctx.setResult({ session: mockSession });
      },
      { priority: 1000 },
    );

    const unsubTurns = MakaioBus.on(
      TurnStorageSubjects.getBySession,
      (ctx) => {
        expect(ctx.payload.sessionId).toBe('session-with-history');
        expect(ctx.payload.limit).toBe(10);
        ctx.setResult({ turns: mockTurns });
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: 'session-with-history',
      }),
      MakaioBus,
    );

    expect(capturedCtx?.recentHistory).toHaveLength(2);
    expect(capturedCtx?.recentHistory[0].turnId).toBe('turn-1');
    expect(capturedCtx?.recentHistory[1].turnId).toBe('turn-2');

    unsubscribe();
    unsubGet();
    unsubTurns();
  });

  it('handles bus errors gracefully', async () => {
    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      () => {
        throw new Error('Database connection failed');
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(
      createRunnerInput({
        sessionId: 'session-123',
      }),
      MakaioBus,
    );

    expect(capturedCtx?.session).toBeUndefined();
    expect(capturedCtx?.project).toBeUndefined();
    expect(capturedCtx?.recentHistory).toEqual([]);

    unsubscribe();
    unsubGet();
  });

  it('enriches context with worktree when session has worktreeId', async () => {
    const mockWorktree: TestWorktree = {
      id: 'wt-abc',
      repoId: 'repo-1',
      path: '/repos/main',
      branch: 'feature/test',
      isMain: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const mockSession = {
      sessionId: 'session-wt',
      status: 'active' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agents: [],
    };

    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        ctx.setResult({ session: mockSession });
      },
      { priority: 1000 },
    );

    const unsubTurns = MakaioBus.on(
      TurnStorageSubjects.getBySession,
      (ctx) => {
        ctx.setResult({ turns: [] });
      },
      { priority: 1000 },
    );

    // Host-side enrichContext seam provides project/worktree
    const unsubEnrich = MakaioBus.on(
      SessionSubjects.enrichContext,
      (ctx) => {
        if (ctx.payload.sessionId === 'session-wt') {
          ctx.setResult({ worktree: mockWorktree });
        } else {
          ctx.setResult({});
        }
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(createRunnerInput({ sessionId: 'session-wt' }), MakaioBus);

    const worktree = capturedCtx?.contextExtensions.worktree as Record<string, unknown> | undefined;
    expect(worktree).toBeDefined();
    expect(worktree?.id).toBe('wt-abc');
    expect(worktree?.path).toBe('/repos/main');
    expect(worktree?.branch).toBe('feature/test');

    unsubscribe();
    unsubGet();
    unsubTurns();
    unsubEnrich();
  });

  it('succeeds without worktree when getWorktree fetch fails', async () => {
    const mockSession = {
      sessionId: 'session-wt-fail',
      status: 'active' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      agents: [],
    };

    const unsubGet = MakaioBus.on(
      SessionSubjects.get,
      (ctx) => {
        ctx.setResult({ session: mockSession });
      },
      { priority: 1000 },
    );

    const unsubTurns = MakaioBus.on(
      TurnStorageSubjects.getBySession,
      (ctx) => {
        ctx.setResult({ turns: [] });
      },
      { priority: 1000 },
    );

    // Simulate the host-side enrichContext handler failing (e.g., worktree lookup error)
    const unsubEnrich = MakaioBus.on(
      SessionSubjects.enrichContext,
      () => {
        throw new Error('Worktree not found');
      },
      { priority: 1000 },
    );

    let capturedCtx: PreUserMessageContext | undefined;
    const { unsubscribe } = createHook('PreUserMessage', {
      handler: (ctx) => {
        capturedCtx = ctx;
      },
    });

    await runPreUserMessageHooks(createRunnerInput({ sessionId: 'session-wt-fail' }), MakaioBus);

    // Session is still enriched despite enrichContext failing
    expect(capturedCtx?.session?.sessionId).toBe('session-wt-fail');
    expect(capturedCtx?.worktree).toBeUndefined();

    unsubscribe();
    unsubGet();
    unsubTurns();
    unsubEnrich();
  });
});
