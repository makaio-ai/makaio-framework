import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createHook } from '../create-hook.js';
import { runPreUserMessageHooks, resetPreUserMessageHooks } from '../runners/pre-user-message-runner.js';
import type { PreUserMessageContext } from '../types/hook-context.js';
import { HookAbortError } from '../errors/hook-abort-error.js';
import { createRunnerInput } from './pre-user-message-helpers.js';

describe('PreUserMessage hook (runner-based)', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    resetPreUserMessageHooks();
  });

  describe('basic hook registration', () => {
    it('calls handler when runPreUserMessageHooks is invoked', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PreUserMessageContext;
      expect(ctx.hookEvent).toBe('PreUserMessage');
      expect(ctx.payload.agentId).toBe('agent-1');
      expect(ctx.bus).toBeDefined();

      unsubscribe();
    });

    it('provides minimal enriched context (session/history not available without bus handlers)', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      const ctx = handler.mock.calls[0][0] as PreUserMessageContext;
      // Session enrichments not available since no bus handlers registered
      expect(ctx.session).toBeUndefined();
      expect(ctx.recentHistory).toEqual([]);
      expect(ctx.project).toBeUndefined();
      expect(ctx.bus).toBeDefined();

      unsubscribe();
    });
  });

  describe('turnContext API', () => {
    it('setTurnContext/getTurnContext work correctly', async () => {
      const handler = vi.fn((ctx: PreUserMessageContext) => {
        ctx.setTurnContext('guideContext', 'guidance');
        ctx.setTurnContext('ragResults', ['r1', 'r2']);
        const injected = ctx.getTurnContext();
        expect(injected.guideContext).toBe('guidance');
        expect(injected.ragResults).toEqual(['r1', 'r2']);
      });

      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('getTurnContext returns a copy (immutable)', async () => {
      const handler = vi.fn((ctx: PreUserMessageContext) => {
        ctx.setTurnContext('key', 'value');
        const first = ctx.getTurnContext();
        first.key = 'mutated';
        expect(ctx.getTurnContext().key).toBe('value');
      });

      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      unsubscribe();
    });
  });

  describe('turnContext flows to result', () => {
    it('should return turnContext in result sessionContext', async () => {
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.setTurnContext('guides', [{ name: 'test-guide' }]);
          ctx.setTurnContext('predictedTools', ['bash', 'edit']);
        },
        priority: 100,
      });

      const result = await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(result.sessionContext).toBeDefined();
      expect(result.sessionContext?.turnContext).toEqual({
        guides: [{ name: 'test-guide' }],
        predictedTools: ['bash', 'edit'],
      });

      unsubscribe();
    });

    it('should merge turnContext from multiple hooks', async () => {
      // First hook (higher priority, runs first)
      const { unsubscribe: unsub1 } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.setTurnContext('fromHook1', 'value1');
        },
        priority: 100,
      });

      // Second hook (lower priority, runs second)
      const { unsubscribe: unsub2 } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.setTurnContext('fromHook2', 'value2');
        },
        priority: 50,
      });

      const result = await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(result.sessionContext?.turnContext).toEqual({
        fromHook1: 'value1',
        fromHook2: 'value2',
      });

      unsub1();
      unsub2();
    });

    it('should preserve existing turnContext from sessionContext', async () => {
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.setTurnContext('fromHook', 'hookValue');
        },
      });

      // Input with pre-existing turnContext
      const result = await runPreUserMessageHooks(
        createRunnerInput({
          sessionContext: {
            messageHistory: [],
            turnContext: { existing: 'preExisting' },
          },
        }),
        MakaioBus,
      );

      expect(result.sessionContext?.turnContext).toEqual({
        existing: 'preExisting',
        fromHook: 'hookValue',
      });

      unsubscribe();
    });

    it('should not modify sessionContext when no turnContext is set', async () => {
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: () => {
          // Handler does nothing with turnContext
        },
      });

      const originalSessionContext = { messageHistory: [] };
      const result = await runPreUserMessageHooks(
        createRunnerInput({
          sessionContext: originalSessionContext,
        }),
        MakaioBus,
      );

      // sessionContext should remain unchanged
      expect(result.sessionContext?.turnContext).toBeUndefined();

      unsubscribe();
    });
  });

  describe('priority and execution order', () => {
    it('executes handlers in priority order (highest first)', async () => {
      const order: string[] = [];

      const unsub1 = createHook('PreUserMessage', {
        handler: () => {
          order.push('low');
        },
        priority: 10,
      }).unsubscribe;

      const unsub2 = createHook('PreUserMessage', {
        handler: () => {
          order.push('high');
        },
        priority: 100,
      }).unsubscribe;

      const unsub3 = createHook('PreUserMessage', {
        handler: () => {
          order.push('med');
        },
        priority: 50,
      }).unsubscribe;

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      // Higher priority runs first
      expect(order).toEqual(['high', 'med', 'low']);

      unsub1();
      unsub2();
      unsub3();
    });
  });

  describe('context methods', () => {
    it('passes through replacePayload method', async () => {
      const handler = vi.fn((ctx: PreUserMessageContext) => {
        expect(typeof ctx.replacePayload).toBe('function');
      });

      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('passes through next method', async () => {
      const handler = vi.fn((ctx: PreUserMessageContext) => {
        expect(typeof ctx.next).toBe('function');
      });

      const { unsubscribe } = createHook('PreUserMessage', { handler });

      await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('allows message modification via replacePayload', async () => {
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.replacePayload({
            ...ctx.payload,
            message: 'modified message',
          });
        },
      });

      const result = await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(result.message).toBe('modified message');

      unsubscribe();
    });

    it('allows sessionContext modification via replacePayload', async () => {
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: (ctx) => {
          ctx.replacePayload({
            ...ctx.payload,
            sessionContext: {
              ...ctx.payload.sessionContext,
              hasNewTransforms: true,
            },
          });
        },
      });

      const result = await runPreUserMessageHooks(createRunnerInput(), MakaioBus);

      expect(result.sessionContext?.hasNewTransforms).toBe(true);

      unsubscribe();
    });
  });

  describe('abort behavior', () => {
    it('abort throws HookAbortError with hook name and reason', async () => {
      createHook('PreUserMessage', {
        handler: (ctx) => ctx.abort('custom reason'),
        name: 'test-abort-hook',
      });

      try {
        await runPreUserMessageHooks(createRunnerInput(), MakaioBus);
        expect.fail('Should have thrown HookAbortError');
      } catch (e) {
        expect(e).toBeInstanceOf(HookAbortError);
        const err = e as HookAbortError;
        expect(err.hookName).toBe('test-abort-hook');
        expect(err.reason).toBe('custom reason');
        expect(err.code).toBe('HOOK_ABORT');
      }
    });

    it('abort stops subsequent hooks from running', async () => {
      const order: string[] = [];

      createHook('PreUserMessage', {
        handler: () => {
          order.push('first');
        },
        priority: 100,
      });

      createHook('PreUserMessage', {
        handler: (ctx) => {
          order.push('aborter');
          ctx.abort('stop');
        },
        name: 'aborter-hook',
        priority: 50,
      });

      createHook('PreUserMessage', {
        handler: () => {
          order.push('third');
        },
        priority: 10,
      });

      await expect(runPreUserMessageHooks(createRunnerInput(), MakaioBus)).rejects.toThrow(HookAbortError);

      // Only hooks before the abort should have run
      expect(order).toEqual(['first', 'aborter']);
    });

    it('abort without reason still throws with hook name', async () => {
      createHook('PreUserMessage', {
        handler: (ctx) => ctx.abort(),
        name: 'no-reason-hook',
      });

      try {
        await runPreUserMessageHooks(createRunnerInput(), MakaioBus);
        expect.fail('Should have thrown HookAbortError');
      } catch (e) {
        expect(e).toBeInstanceOf(HookAbortError);
        const err = e as HookAbortError;
        expect(err.hookName).toBe('no-reason-hook');
        expect(err.reason).toBeUndefined();
      }
    });
  });

  describe('structured messages', () => {
    it('handles structured messages with blocks', async () => {
      let captured: unknown;
      const { unsubscribe } = createHook('PreUserMessage', {
        handler: (ctx) => {
          captured = ctx.payload.message;
        },
      });

      const structuredMessage = {
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'Hello structured' }],
      };

      await runPreUserMessageHooks(createRunnerInput({ message: structuredMessage }), MakaioBus);

      expect(captured).toEqual(structuredMessage);

      unsubscribe();
    });
  });
});
