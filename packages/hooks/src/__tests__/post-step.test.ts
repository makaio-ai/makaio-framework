import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type StepFinished } from '@makaio/contracts';
import { TurnStorageSubjects } from '@makaio/services-core/turn';
import { createHook } from '../create-hook.js';
import type { PostStepContext } from '../types/hook-context.js';

/**
 * Helper to create a valid StepFinished payload.
 * @param overrides - Optional payload overrides
 */
function createStepFinishedPayload(overrides: Partial<StepFinished> = {}): StepFinished {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    adapterSessionId: 'adapter-session-1',
    messageId: 'msg-123',
    stepType: 'reasoning',
    blockIndex: 0,
    content: { type: 'reasoning', content: 'Test reasoning content' },
    ...overrides,
  };
}

/**
 * Helper to emit a step.finished event and wait for interceptors.
 * @param payload - StepFinished payload
 */
async function emitStepFinished(payload: StepFinished): Promise<void> {
  await MakaioBus.emit(AgentSubjects.step.finished, payload);
}

describe('PostStep hook', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('hook registration and unsubscription', () => {
    it('calls handler with correct context when step.finished is emitted', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      await emitStepFinished(createStepFinishedPayload());

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.hookEvent).toBe('PostStep');
      expect(ctx.sessionId).toBe('session-1');
      expect(ctx.agentId).toBe('agent-1');
      expect(ctx.stepType).toBe('reasoning');
      expect(ctx.blockIndex).toBe(0);
      expect(ctx.bus).toBeDefined();

      unsubscribe();
    });

    it('handles optional fields and unsubscribe', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      // With optional fields undefined
      await emitStepFinished(createStepFinishedPayload({ sessionId: undefined, messageId: undefined }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].sessionId).toBeUndefined();

      // After unsubscribe
      unsubscribe();
      await emitStepFinished(createStepFinishedPayload());
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('step type filtering', () => {
    it('defaults to reasoning-only when stepTypes not specified', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      // Emit reasoning step - should fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'reasoning' }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Emit tool_use step - should NOT fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'tool_use' }));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1

      // Emit text step - should NOT fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'text' }));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1

      unsubscribe();
    });

    it('only fires for configured stepTypes', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', {
        handler,
        stepTypes: ['tool_use', 'text'],
      });

      // Emit reasoning step - should NOT fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'reasoning' }));
      expect(handler).not.toHaveBeenCalled();

      // Emit tool_use step - should fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'tool_use' }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Emit text step - should fire
      await emitStepFinished(createStepFinishedPayload({ stepType: 'text' }));
      expect(handler).toHaveBeenCalledTimes(2);

      unsubscribe();
    });

    it('supports all stepTypes when explicitly configured', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', {
        handler,
        stepTypes: ['reasoning', 'tool_use', 'text'],
      });

      await emitStepFinished(createStepFinishedPayload({ stepType: 'reasoning' }));
      await emitStepFinished(createStepFinishedPayload({ stepType: 'tool_use' }));
      await emitStepFinished(createStepFinishedPayload({ stepType: 'text' }));

      expect(handler).toHaveBeenCalledTimes(3);

      unsubscribe();
    });
  });

  describe('context enrichment with session data', () => {
    it('enriches context with session, recentHistory, and project when sessionId available', async () => {
      // Mock session enrichment responses
      const now = Date.now();
      const mockSession = {
        sessionId: 'session-1',
        createdAt: now,
        lastActivityAt: now,
        agents: [],
        status: 'active' as const,
      };
      const mockTurns = [
        { turnId: 'turn-1', sessionId: 'session-1', turnNumber: 1, status: 'completed' as const, startedAt: now },
        { turnId: 'turn-2', sessionId: 'session-1', turnNumber: 2, status: 'completed' as const, startedAt: now },
      ];
      const mockProject = {
        id: 'project-1',
        name: 'Test Project',
        createdAt: now,
        updatedAt: now,
      };

      // Register mock handlers for enrichment queries
      MakaioBus.on(SessionSubjects.get, (ctx) => {
        ctx.setResult({ session: mockSession });
      });
      MakaioBus.on(TurnStorageSubjects.getBySession, (ctx) => {
        ctx.setResult({ turns: mockTurns });
      });
      // Host-side enrichContext seam provides project/worktree
      MakaioBus.on(SessionSubjects.enrichContext, (ctx) => {
        ctx.setResult({ project: mockProject });
      });

      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      await emitStepFinished(createStepFinishedPayload({ sessionId: 'session-1' }));

      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.session).toEqual(mockSession);
      expect(ctx.recentHistory).toEqual(mockTurns);
      expect(ctx.project).toEqual(mockProject);

      unsubscribe();
    });

    it('provides empty enrichment when sessionId is undefined', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      await emitStepFinished(createStepFinishedPayload({ sessionId: undefined }));

      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.session).toBeUndefined();
      expect(ctx.recentHistory).toEqual([]);
      expect(ctx.project).toBeUndefined();

      unsubscribe();
    });

    it('gracefully degrades when session enrichment fails', async () => {
      // Mock session enrichment to fail
      MakaioBus.on(SessionSubjects.get, () => {
        throw new Error('Session not found');
      });

      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler });

      await emitStepFinished(createStepFinishedPayload({ sessionId: 'session-1' }));

      // Handler should still be called with empty enrichment
      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.session).toBeUndefined();
      expect(ctx.recentHistory).toEqual([]);
      expect(ctx.project).toBeUndefined();

      unsubscribe();
    });
  });

  describe('priority ordering', () => {
    it('executes handlers in priority order (highest first)', async () => {
      const order: string[] = [];

      const unsub1 = createHook('PostStep', {
        handler: () => {
          order.push('low');
        },
        priority: 10,
      }).unsubscribe;

      const unsub2 = createHook('PostStep', {
        handler: () => {
          order.push('high');
        },
        priority: 100,
      }).unsubscribe;

      const unsub3 = createHook('PostStep', {
        handler: () => {
          order.push('med');
        },
        priority: 50,
      }).unsubscribe;

      await emitStepFinished(createStepFinishedPayload());

      // Higher priority runs first
      expect(order).toEqual(['high', 'med', 'low']);

      unsub1();
      unsub2();
      unsub3();
    });
  });

  describe('error handling', () => {
    it('continues on handler error (does not break the chain)', async () => {
      const order: string[] = [];

      createHook('PostStep', {
        handler: () => {
          order.push('first');
        },
        priority: 100,
      });

      createHook('PostStep', {
        handler: () => {
          order.push('throws');
          throw new Error('test error');
        },
        priority: 50,
        name: 'throwing-hook',
      });

      createHook('PostStep', {
        handler: () => {
          order.push('third');
        },
        priority: 10,
      });

      // Should not throw - errors are caught and logged
      await emitStepFinished(createStepFinishedPayload());

      // All handlers should run despite the error
      expect(order).toEqual(['first', 'throws', 'third']);
    });

    it('logs errors but does not throw', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      createHook('PostStep', {
        handler: () => {
          throw new Error('intentional error');
        },
        name: 'error-hook',
      });

      // Should not throw
      await expect(emitStepFinished(createStepFinishedPayload())).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[PostStep] Hook'), expect.any(Error));

      consoleErrorSpy.mockRestore();
    });
  });

  describe('stepContent inclusion', () => {
    it('includes stepContent from payload.content for text blocks', async () => {
      const mockBlock = { type: 'text' as const, content: 'This is text content' };
      const handler = vi.fn();
      createHook('PostStep', { handler, stepTypes: ['text'] });
      await emitStepFinished(createStepFinishedPayload({ content: mockBlock, stepType: 'text' }));
      expect(handler.mock.calls[0][0].stepContent).toEqual(mockBlock);
    });

    it('includes stepContent from payload.content for reasoning blocks', async () => {
      const mockBlock = { type: 'reasoning' as const, content: 'This is reasoning content' };
      const handler = vi.fn();
      createHook('PostStep', { handler });
      await emitStepFinished(createStepFinishedPayload({ content: mockBlock, stepType: 'reasoning' }));
      expect(handler.mock.calls[0][0].stepContent).toEqual(mockBlock);
    });

    it('includes stepContent from payload.content for tool_output blocks', async () => {
      const mockBlock = {
        type: 'tool_output' as const,
        toolCallId: 'tc-1',
        output: 'Tool result',
        isError: false,
      };
      const handler = vi.fn();
      createHook('PostStep', { handler, stepTypes: ['tool_use'] });
      await emitStepFinished(createStepFinishedPayload({ content: mockBlock, stepType: 'tool_use' }));
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].stepContent).toEqual(mockBlock);
    });

    it('stepContent comes directly from payload.content', async () => {
      const handler = vi.fn();
      createHook('PostStep', { handler, stepTypes: ['text'] });

      const content = { type: 'text' as const, content: 'Direct content from payload' };
      await emitStepFinished(createStepFinishedPayload({ content, stepType: 'text' }));
      expect(handler.mock.calls[0][0].stepContent).toEqual(content);
    });

    it('stepContent is always available since content is required in schema', async () => {
      const handler = vi.fn();
      createHook('PostStep', { handler });

      // Content is now required - no need for messageId or fetch fallback
      const content = { type: 'reasoning' as const, content: 'Required content' };
      await emitStepFinished(createStepFinishedPayload({ messageId: undefined, content }));
      expect(handler.mock.calls[0][0].stepContent).toEqual(content);
    });
  });

  describe('context properties', () => {
    it('provides bus, payload, and interceptor controls', async () => {
      const handler = vi.fn();
      createHook('PostStep', { handler, stepTypes: ['tool_use'] });

      const payload = createStepFinishedPayload({ stepType: 'tool_use', blockIndex: 2 });
      await emitStepFinished(payload);

      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.bus).toBeDefined();
      expect(ctx.payload).toEqual(payload);
      expect(ctx.next).toBeDefined();
      expect(ctx.stopPropagation).toBeDefined();
      expect('correlationId' in ctx).toBe(true);
    });
  });
});
