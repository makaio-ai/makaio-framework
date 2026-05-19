import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { createHook } from '../create-hook.js';
import {
  runPostUserMessageHooks,
  resetPostUserMessageHooks,
  type PostUserMessageInput,
} from '../runners/post-user-message-runner.js';
import type { PostUserMessageContext } from '../types/hook-context.js';

/**
 * Helper to create a valid PostUserMessageInput payload.
 * @param overrides - Optional payload overrides
 */
function createRunnerInput(overrides: Partial<PostUserMessageInput> = {}): PostUserMessageInput {
  return {
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    sessionId: 'session-1',
    messageId: 'msg-123',
    ...overrides,
  };
}

describe('PostUserMessage hook (runner-based)', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    resetPostUserMessageHooks();
  });

  describe('basic hook registration', () => {
    it('calls handler when runPostUserMessageHooks is invoked', async () => {
      const handler = mock();
      const { unsubscribe } = createHook('PostUserMessage', { handler });

      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostUserMessageContext;
      expect(ctx.hookEvent).toBe('PostUserMessage');
      expect(ctx.agentId).toBe('agent-1');
      expect(ctx.adapterId).toBe('adapter-1');
      expect(ctx.sessionId).toBe('session-1');
      expect(ctx.messageId).toBe('msg-123');
      expect(ctx.bus).toBeDefined();

      unsubscribe();
    });

    it('provides correct context with optional fields undefined', async () => {
      const handler = mock();
      const { unsubscribe } = createHook('PostUserMessage', { handler });

      await runPostUserMessageHooks(
        createRunnerInput({
          sessionId: undefined,
          messageId: undefined,
        }),
        MakaioBus,
      );

      const ctx = handler.mock.calls[0][0] as PostUserMessageContext;
      expect(ctx.sessionId).toBeUndefined();
      expect(ctx.messageId).toBeUndefined();
      expect(ctx.agentId).toBe('agent-1');
      expect(ctx.bus).toBeDefined();

      unsubscribe();
    });

    it('unsubscribe prevents handler from being called', async () => {
      const handler = mock();
      const { unsubscribe } = createHook('PostUserMessage', { handler });

      unsubscribe();

      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('priority and execution order', () => {
    it('executes handlers in priority order (highest first)', async () => {
      const order: string[] = [];

      const unsub1 = createHook('PostUserMessage', {
        handler: () => {
          order.push('low');
        },
        priority: 10,
      }).unsubscribe;

      const unsub2 = createHook('PostUserMessage', {
        handler: () => {
          order.push('high');
        },
        priority: 100,
      }).unsubscribe;

      const unsub3 = createHook('PostUserMessage', {
        handler: () => {
          order.push('med');
        },
        priority: 50,
      }).unsubscribe;

      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      // Higher priority runs first
      expect(order).toEqual(['high', 'med', 'low']);

      unsub1();
      unsub2();
      unsub3();
    });
  });

  describe('error handling', () => {
    it('continues on handler error (does not block)', async () => {
      const order: string[] = [];

      createHook('PostUserMessage', {
        handler: () => {
          order.push('first');
        },
        priority: 100,
      });

      createHook('PostUserMessage', {
        handler: () => {
          order.push('throws');
          throw new Error('test error');
        },
        priority: 50,
        name: 'throwing-hook',
      });

      createHook('PostUserMessage', {
        handler: () => {
          order.push('third');
        },
        priority: 10,
      });

      // Should not throw - errors are caught and logged
      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      // All handlers should run despite the error
      expect(order).toEqual(['first', 'throws', 'third']);
    });

    it('logs errors but does not throw', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      createHook('PostUserMessage', {
        handler: () => {
          throw new Error('intentional error');
        },
        name: 'error-hook',
      });

      // Should not throw
      await expect(runPostUserMessageHooks(createRunnerInput(), MakaioBus)).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PostUserMessage] Hook "error-hook" failed:'),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('multiple hooks', () => {
    it('runs multiple hooks in order', async () => {
      const results: string[] = [];

      createHook('PostUserMessage', {
        handler: () => {
          results.push('hook1');
        },
        priority: 100,
      });

      createHook('PostUserMessage', {
        handler: () => {
          results.push('hook2');
        },
        priority: 50,
      });

      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(results).toEqual(['hook1', 'hook2']);
    });

    it('allows hooks to make bus requests', async () => {
      let busUsed = false;

      createHook('PostUserMessage', {
        handler: (ctx) => {
          expect(ctx.bus).toBeDefined();
          busUsed = true;
        },
      });

      await runPostUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(busUsed).toBe(true);
    });
  });
});
