import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { TurnStorageSubjects } from '@makaio/services-core/turn';
import { buildPostTurnContext } from '../contexts/post-turn.js';

describe('buildPostTurnContext', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('preserves framework-owned fields when context extensions collide', async () => {
    MakaioBus.on(SessionSubjects.get, (ctx) => {
      ctx.setResult({
        session: {
          sessionId: ctx.payload.sessionId,
          status: 'active',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          agents: [],
        },
      });
    });
    MakaioBus.on(TurnStorageSubjects.getBySession, (ctx) => {
      ctx.setResult({ turns: [] });
    });
    MakaioBus.on(SessionSubjects.enrichContext, (ctx) => {
      ctx.setResult({
        project: { id: 'project-1', name: 'Project 1', createdAt: Date.now(), updatedAt: Date.now() },
        hookEvent: 'fake',
        payload: 'override',
        sessionId: 'fake-session',
      });
    });

    const context = await buildPostTurnContext(
      {
        subject: SessionSubjects.turn.completed.subject,
        payload: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          turnNumber: 1,
          success: true,
          error: undefined,
        },
        messageId: 'msg-1',
        correlationId: 'corr-1',
        replacePayload: () => undefined,
        next: () => undefined,
        stopPropagation: () => undefined,
      },
      MakaioBus,
    );

    expect(context.hookEvent).toBe('PostTurn');
    expect(context.sessionId).toBe('session-1');
    expect(context.payload.turnId).toBe('turn-1');
    expect((context.contextExtensions.project as Record<string, unknown>)?.id).toBe('project-1');
  });
});
