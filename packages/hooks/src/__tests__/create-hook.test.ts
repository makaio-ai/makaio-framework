import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { createHook } from '../create-hook.js';
import { resetPreUserMessageHooks } from '../runners/pre-user-message-runner.js';

const { subjects: TestSubjects } = MakaioBus.registerNamespace('hookTest', {
  action: z.object({ value: z.string() }),
});

describe('createHook()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    resetPreUserMessageHooks();
  });

  describe('BusMessage hook', () => {
    it('should create a hook registration', () => {
      const handler = vi.fn();
      const registration = createHook('BusMessage', {
        subject: TestSubjects.action,
        handler,
      });

      expect(registration).toBeDefined();
      expect(typeof registration.unsubscribe).toBe('function');
      expect(registration.hookName).toBe('BusMessage');
    });

    it('should intercept events on the specified subject', async () => {
      const handler = vi.fn();
      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler,
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload).toEqual({ value: 'test' });
    });

    it('should allow unsubscribing', async () => {
      const handler = vi.fn();
      const registration = createHook('BusMessage', {
        subject: TestSubjects.action,
        handler,
      });

      registration.unsubscribe();

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should respect priority option via execution order', async () => {
      const order: string[] = [];

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('low');
        },
        priority: 10,
      });

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('high');
        },
        priority: 100,
      });

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('medium');
        },
        priority: 50,
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      // Higher priority runs first
      expect(order).toEqual(['high', 'medium', 'low']);
    });

    it('should use default priority of 0', async () => {
      const order: string[] = [];

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('default');
        },
      });

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('positive');
        },
        priority: 10,
      });

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: () => {
          order.push('negative');
        },
        priority: -10,
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['positive', 'default', 'negative']);
    });

    it('should allow payload transformation via replacePayload', async () => {
      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: (ctx) => {
          ctx.replacePayload({ value: 'transformed' });
        },
      });

      let receivedPayload: unknown;
      MakaioBus.on(TestSubjects.action, (ctx) => {
        receivedPayload = ctx.payload;
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'original' });

      expect(receivedPayload).toEqual({ value: 'transformed' });
    });

    it('should allow blocking via stopPropagation', async () => {
      const handlerCalled = vi.fn();

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: (ctx) => {
          ctx.stopPropagation();
        },
      });

      MakaioBus.on(TestSubjects.action, handlerCalled);

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(handlerCalled).not.toHaveBeenCalled();
    });

    it('should support async handlers', async () => {
      const order: string[] = [];

      createHook('BusMessage', {
        subject: TestSubjects.action,
        handler: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push('async-hook');
        },
      });

      MakaioBus.on(TestSubjects.action, () => {
        order.push('handler');
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['async-hook', 'handler']);
    });
  });

  describe('PreUserMessage hook', () => {
    it('should create a hook registration', () => {
      const handler = vi.fn();
      const registration = createHook('PreUserMessage', {
        handler,
      });

      expect(registration).toBeDefined();
      expect(typeof registration.unsubscribe).toBe('function');
      expect(registration.hookName).toBe('PreUserMessage');
    });

    it('should allow unsubscribing', () => {
      const handler = vi.fn();
      const registration = createHook('PreUserMessage', {
        handler,
      });

      // Should not throw when unsubscribing
      expect(() => registration.unsubscribe()).not.toThrow();
    });
  });

  describe('PostTurn hook', () => {
    it('should create a hook registration', () => {
      const handler = vi.fn();
      const registration = createHook('PostTurn', {
        handler,
      });

      expect(registration).toBeDefined();
      expect(typeof registration.unsubscribe).toBe('function');
      expect(registration.hookName).toBe('PostTurn');
    });

    it('should allow unsubscribing', () => {
      const handler = vi.fn();
      const registration = createHook('PostTurn', {
        handler,
      });

      // Should not throw when unsubscribing
      expect(() => registration.unsubscribe()).not.toThrow();
    });
  });

  describe('Named hooks (placeholders)', () => {
    it('should throw for unimplemented named hooks', () => {
      // PreTurn is still unimplemented
      expect(() =>
        createHook('PreTurn', {
          handler: vi.fn(),
        }),
      ).toThrow('Named hook "PreTurn" not yet implemented');
    });

    it('should throw for all unimplemented named hook types', () => {
      // PreUserMessage, PostUserMessage, and PostTurn are now implemented
      const unimplementedHooks = ['PreTurn', 'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'] as const;

      for (const hookName of unimplementedHooks) {
        expect(() =>
          createHook(hookName, {
            handler: vi.fn(),
          }),
        ).toThrow(`Named hook "${hookName}" not yet implemented`);
      }
    });
  });
});
