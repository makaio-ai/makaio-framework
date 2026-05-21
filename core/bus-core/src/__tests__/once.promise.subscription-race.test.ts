import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import type { BusMessage, BusTransport } from '../index.js';
import { createBusContext, createBusInstance } from '../bus.js';
import { OnceTimeoutError } from '../methods/once.js';

class DeferredSubscribeTransport implements BusTransport {
  public readonly name = 'deferred-subscribe';
  private readonly subscribeResolvers: Array<() => void> = [];

  // send is not exercised by these tests — only subscribe timing matters.
  public readonly send: BusTransport['send'] = async () => {
    throw new Error('DeferredSubscribeTransport.send should not be called');
  };

  public onReceive(_handler: (message: BusMessage) => Promise<void>): () => void {
    return () => {
      // no-op
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}

  public subscribe(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.subscribeResolvers.push(resolve);
    });
  }

  public async unsubscribe(): Promise<void> {}

  public resolveNextSubscribe(): void {
    const resolve = this.subscribeResolvers.shift();
    if (!resolve) {
      throw new Error('No pending subscribe resolver to release');
    }
    resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

/** Create an isolated bus with a deferred-subscribe transport and a test namespace. */
function createRaceTestContext() {
  vi.useFakeTimers();
  const bus = createBusInstance({ context: createBusContext() });
  const transport = new DeferredSubscribeTransport();
  bus.registerTransport(transport);
  const { subjects } = bus.registerNamespace(
    createBusNamespace('race-test', {
      ping: z.object({ seq: z.number() }),
    }),
  );
  return { bus, transport, subjects };
}

describe('once() subscription race', () => {
  it('does not start timeout until subscription propagation settles', async () => {
    const { bus, transport, subjects } = createRaceTestContext();

    let rejectedError: unknown;
    const oncePromise = bus.once(subjects.ping, { timeoutMs: 50 }).catch((error: unknown) => {
      rejectedError = error;
    });

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(rejectedError).toBeUndefined();

    transport.resolveNextSubscribe();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(49);
    expect(rejectedError).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await oncePromise;
    expect(rejectedError).toBeInstanceOf(OnceTimeoutError);
  });

  it('still resolves if the event arrives after propagation and before the deferred timeout elapses', async () => {
    const { bus, transport, subjects } = createRaceTestContext();

    const oncePromise = bus.once(subjects.ping, { timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(50);
    transport.resolveNextSubscribe();
    await Promise.resolve();

    const emitPromise = bus.emit(subjects.ping, { seq: 1 });
    await Promise.all([emitPromise, oncePromise]).then(([, ctx]) => {
      expect(ctx.payload.seq).toBe(1);
    });
  });
});
