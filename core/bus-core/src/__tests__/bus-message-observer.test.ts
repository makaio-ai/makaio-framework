import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusInstance } from '../bus.js';

describe('bus message observers', () => {
  it('observe local event, request, and broadcast messages in production-capable path', async () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('observer-demo', {
      changed: z.object({ id: z.string() }),
      load: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      announce: { request: z.object({ id: z.string() }), response: z.object({ ack: z.boolean() }) },
    });
    bus.registerNamespace(namespace);

    const observed: string[] = [];
    const dispose = bus.observeMessages((message) => {
      observed.push(`${message.type}:${message.namespace}.${message.subject}`);
    });

    const cleanupRequest = bus.on(namespace.subjects.load, (ctx) => ctx.setResult({ ok: true }));
    const cleanupBroadcast = bus.on(namespace.subjects.announce, (ctx) => ctx.setResult({ ack: true }));

    await bus.emit(namespace.subjects.changed, { id: 'one' });
    await bus.request(namespace.subjects.load, { id: 'two' });
    await bus.broadcast(namespace.subjects.announce, { id: 'three' });

    dispose();
    cleanupRequest();
    cleanupBroadcast();

    expect(observed).toEqual([
      'event:observer-demo.changed',
      'request:observer-demo.load',
      'broadcast:observer-demo.announce',
    ]);
  });

  it('marks explicitly local-only event, request, and broadcast calls', async () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('observer-local-only', {
      changed: z.object({ id: z.string() }),
      load: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      announce: { request: z.object({ id: z.string() }), response: z.object({ ack: z.boolean() }) },
    });
    bus.registerNamespace(namespace);

    const observed: boolean[] = [];
    const dispose = bus.observeMessages((message) => {
      observed.push(message.localOnly === true);
    });
    const cleanupRequest = bus.on(namespace.subjects.load, (ctx) => ctx.setResult({ ok: true }));
    const cleanupBroadcast = bus.on(namespace.subjects.announce, (ctx) => ctx.setResult({ ack: true }));

    await bus.emit(namespace.subjects.changed, { id: 'one' }, { transports: [] });
    await bus.request(namespace.subjects.load, { id: 'two' }, { transports: [] });
    await bus.broadcast(namespace.subjects.announce, { id: 'three' }, { transports: [] });

    dispose();
    cleanupRequest();
    cleanupBroadcast();

    expect(observed).toEqual([true, true, true]);
  });

  it('stops notifying an observer after dispose', async () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('observer-cleanup', {
      changed: z.object({ id: z.string() }),
    });
    bus.registerNamespace(namespace);

    const observer = vi.fn();
    const dispose = bus.observeMessages(observer);

    await bus.emit(namespace.subjects.changed, { id: 'one' });
    dispose();
    await bus.emit(namespace.subjects.changed, { id: 'two' });

    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('does not reject the bus operation when an observer throws', async () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('observer-errors', {
      changed: z.object({ id: z.string() }),
    });
    bus.registerNamespace(namespace);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const successfulObserver = vi.fn();
    const disposeThrowing = bus.observeMessages(() => {
      throw new Error('observer failed');
    });
    const disposeSuccessful = bus.observeMessages(successfulObserver);

    try {
      await expect(bus.emit(namespace.subjects.changed, { id: 'one' })).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(successfulObserver).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Error in bus message observer:'),
        expect.any(Error),
      );
    } finally {
      disposeThrowing();
      disposeSuccessful();
      consoleError.mockRestore();
    }
  });
});
