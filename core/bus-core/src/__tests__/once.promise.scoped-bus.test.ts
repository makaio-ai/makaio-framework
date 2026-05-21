import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('scoped bus integration', () => {
    it('should work with scoped bus', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('oncePromise:scoped', {
          event: z.object({ value: z.string() }),
        }),
      );

      const scopedBus = MakaioBus.scoped(namespace);
      const promise = scopedBus.once(namespace.subjects.event);

      await scopedBus.emit(namespace.subjects.event, { value: 'scoped-value' });

      const ctx = await promise;
      expect(ctx.payload.value).toBe('scoped-value');
    });

    it('should work with scoped bus and options', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('oncePromise:scopedOptions', {
          event: z.object({ id: z.number() }),
        }),
      );

      const scopedBus = MakaioBus.scoped(namespace);
      const promise = scopedBus.once(namespace.subjects.event, {
        filter: { id: 42 },
        timeoutMs: 1000,
      });

      // Emit non-matching
      await scopedBus.emit(namespace.subjects.event, { id: 1 });
      await scopedBus.emit(namespace.subjects.event, { id: 2 });

      // Emit matching
      await scopedBus.emit(namespace.subjects.event, { id: 42 });

      const ctx = await promise;
      expect(ctx.payload.id).toBe(42);
    });
  });
});
