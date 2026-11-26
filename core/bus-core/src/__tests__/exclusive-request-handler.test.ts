import { createBusNamespace, type HandlerForSubjectDefinition } from '@makaio/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance, hostLocalRequest, type OnOptions } from '../index.js';

const RequestSchema = {
  request: z.object({}),
  response: z.object({ handledBy: z.string() }),
};

const TestNamespace = createBusNamespace('exclusive-test', {
  resolve: hostLocalRequest(RequestSchema),
  ordinary: RequestSchema,
  event: z.object({}),
});

/**
 * Create an isolated bus with the request declarations used by these tests.
 * @returns The bus and its registered subject definitions.
 */
function setup() {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(TestNamespace);
  return { bus, subjects };
}

describe('exclusive request handlers', () => {
  it('rejects a second exclusive registration for the same subject', async () => {
    const { bus, subjects } = setup();
    bus.on(subjects.resolve, (ctx) => ctx.setResult({ handledBy: 'first' }), { exclusive: true });

    expect(() => bus.on(subjects.resolve, () => {}, { exclusive: true })).toThrow('already has a handler');
    await expect(bus.request(bus.own('root'), subjects.resolve, {})).resolves.toEqual({ handledBy: 'first' });
  });

  it('rejects a regular exact registration while the subject is reserved', () => {
    const { bus, subjects } = setup();
    bus.on(subjects.resolve, () => {}, { exclusive: true });

    expect(() => bus.on(subjects.resolve, () => {})).toThrow('already has a handler');
  });

  it('keeps wildcard handlers registered for other subjects while excluding them from the reserved request', async () => {
    const { bus, subjects } = setup();
    const caller = bus.own('root');
    const invocations: string[] = [];

    bus.on(
      subjects.$all,
      () => {
        invocations.push('before');
      },
      { handlerKind: 'request', priority: 10 },
    );
    bus.on(
      subjects.resolve,
      async (ctx) => {
        await ctx.next();
        ctx.setResult({ handledBy: 'exclusive' });
      },
      { exclusive: true },
    );
    bus.on(
      subjects.$all,
      () => {
        invocations.push('after');
      },
      { handlerKind: 'request', priority: -10 },
    );
    bus.on(subjects.ordinary, (ctx) => ctx.setResult({ handledBy: 'ordinary' }), { priority: -20 });

    await expect(bus.request(caller, subjects.resolve, {})).resolves.toEqual({ handledBy: 'exclusive' });
    expect(invocations).toEqual([]);

    await expect(bus.request(caller, subjects.ordinary, {})).resolves.toEqual({ handledBy: 'ordinary' });
    expect(invocations).toEqual(['before', 'after']);
  });

  it('releases the reservation on unsubscribe and keeps the replacement when the old disposer runs again', async () => {
    const { bus, subjects } = setup();
    const caller = bus.own('root');
    const handler: HandlerForSubjectDefinition<typeof subjects.resolve> = (ctx) => {
      ctx.setResult({ handledBy: 'exclusive' });
    };

    const removeFirst = bus.on(subjects.resolve, handler, { exclusive: true });
    removeFirst();
    bus.on(subjects.resolve, handler, { exclusive: true });
    removeFirst();

    await expect(bus.request(caller, subjects.resolve, {})).resolves.toEqual({ handledBy: 'exclusive' });
  });

  it('allows reservations only for exact host-local request subjects', () => {
    const { bus, subjects } = setup();
    const options = { exclusive: true };

    expect(() => bus.on(subjects.ordinary, () => {}, options)).toThrow('require an exact host-local request');
    expect(() => bus.on(subjects.event, () => {}, options)).toThrow('require an exact host-local request');
    expect(() => bus.on(subjects.$all, () => {}, { ...options, handlerKind: 'request' })).toThrow(
      'require an exact host-local request',
    );
  });

  it('rejects filtered reservations without consuming the exclusive registration', async () => {
    const { bus, subjects } = setup();
    const filter = { scope: 'one' };
    expectTypeOf<{ exclusive: true; filter: typeof filter }>().not.toExtend<OnOptions>();

    const filtered = bus.withFilter(filter);
    expect(() => filtered.on(subjects.resolve, () => {}, { exclusive: true })).toThrow(TypeError);

    bus.on(subjects.resolve, (ctx) => ctx.setResult({ handledBy: 'exclusive' }), { exclusive: true });
    await expect(bus.request(bus.own('root'), subjects.resolve, {})).resolves.toEqual({ handledBy: 'exclusive' });
  });

  it('keeps the priority chain for nonexclusive handlers of the same host-local subject', async () => {
    const { bus, subjects } = setup();
    const invocations: string[] = [];
    bus.on(subjects.resolve, (ctx) => {
      invocations.push('respond');
      ctx.setResult({ handledBy: 'respond' });
    });
    bus.on(
      subjects.resolve,
      async (ctx) => {
        invocations.push('before');
        await ctx.next();
        invocations.push('after');
      },
      { priority: 10 },
    );

    expect(() => bus.on(subjects.resolve, () => {}, { exclusive: true })).toThrow('already has a handler');
    await expect(bus.request(bus.own('root'), subjects.resolve, {})).resolves.toEqual({ handledBy: 'respond' });
    expect(invocations).toEqual(['before', 'respond', 'after']);
  });
});
