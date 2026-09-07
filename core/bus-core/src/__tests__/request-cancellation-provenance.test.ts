import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError as DeadlineError } from 'p-timeout';
import pDefer from 'p-defer';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  BusAbortError,
  CorrelationTracker,
  createBusInstance,
  isRequestCancellation,
  NoHandlerError,
  RequestError,
  TimeoutError,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
} from '../index.js';
import { dispatch } from '../methods/request/dispatch.js';

const namespace = createBusNamespace('cancellationProvenance', {
  wait: { request: z.object({}), response: z.object({ ok: z.boolean() }) },
});

declare module '../index.js' {
  interface BusTransportRegistry {
    cancellationProvenance: BusTransport;
  }
}

/** A controlled remote peer using the production correlation tracker. */
class PendingPeer implements BusTransport {
  public readonly name = 'cancellation-provenance-peer';
  public readonly started = pDefer<void>();
  public readonly correlations = new CorrelationTracker();
  public readonly cancellations: Error[] = [];
  public failure: unknown;

  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  public send(message: BusMessage, timeout?: number): Promise<unknown>;
  public send(message: BusMessage, timeout?: number): Promise<unknown> {
    if (message.type !== 'request') return Promise.resolve(true);
    this.started.resolve();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return this.correlations.track(message.correlationId, timeout ?? 60_000);
  }

  public onReceive(): () => void {
    return () => {};
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {
    this.correlations.cleanup();
  }
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  public cancelRequest(correlationId: string, error?: Error): void {
    if (error) this.cancellations.push(error);
    this.correlations.cancel(correlationId, error);
  }
}

/**
 * Create a genuine Error outside this test's realm, optionally with a custom tag.
 * @param customTag - Whether to exercise the documented conservative-recognition boundary
 * @returns The untouched foreign Error
 */
function createForeignError(customTag = false): unknown {
  const reason: unknown = runInNewContext(
    customTag
      ? 'Object.defineProperty(new Error("shutdown"), Symbol.toStringTag, { value: "CustomError" })'
      : 'new Error("shutdown")',
  );
  expect(reason).not.toBeInstanceOf(Error);
  return reason;
}

/** Create an uninspectable reason whose exact identity must still survive cancellation. */
function createRevokedReason(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

const reasons = [
  { name: 'default', create: () => undefined, preserveIdentity: true },
  { name: 'string', create: () => 'shutdown', preserveIdentity: false },
  { name: 'Error', create: () => new Error('shutdown'), preserveIdentity: true },
  { name: 'DOMException', create: () => new DOMException('shutdown', 'AbortError'), preserveIdentity: true },
  { name: 'foreign Error', create: () => createForeignError(), preserveIdentity: true },
  { name: 'custom-tag foreign Error', create: () => createForeignError(true), preserveIdentity: false },
  { name: 'spoofed Error tag', create: () => ({ [Symbol.toStringTag]: 'Error' }), preserveIdentity: false },
  { name: 'revoked proxy', create: createRevokedReason, preserveIdentity: false },
  { name: 'object', create: () => ({ source: 'shutdown' }), preserveIdentity: false },
  { name: 'caller TimeoutError', create: () => new DeadlineError('caller cancellation'), preserveIdentity: true },
];
const timeouts = [undefined, 5000, 0];
const nonErrorReasons = [
  { name: 'string', reason: 'shutdown' },
  { name: 'number', reason: 0 },
  { name: 'boolean', reason: false },
  { name: 'null', reason: null },
  { name: 'object', reason: { source: 'shutdown' } },
];
const independentFailures = [
  { name: 'Error', reason: 'shutdown', failure: new Error('independent failure') },
  ...nonErrorReasons.map(({ name, reason }) => ({ name, reason, failure: reason })),
];

/**
 * Assert exact provenance without relying on message or name matching.
 * @param error - Actual bus rejection
 * @param signal - Request cancellation signal
 * @param preserveIdentity - Explicit expectation for recognized versus conservatively wrapped reasons
 */
function expectCancellation(
  error: unknown,
  signal: AbortSignal,
  preserveIdentity = signal.reason instanceof Error,
): void {
  expect(isRequestCancellation(error, signal)).toBe(true);
  if (preserveIdentity) {
    expect(error).toBe(signal.reason);
  } else {
    expect(error).toBeInstanceOf(BusAbortError);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error instanceof BusAbortError && error.cause).toBe(signal.reason);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(['local', 'remote'] as const)('%s request cancellation', (path) => {
  describe.each(timeouts)('timeout=%s', (timeout) => {
    describe.each(['before', 'in flight'] as const)('aborted %s request', (phase) => {
      it.each(reasons)('preserves $name reason', async ({ create, preserveIdentity }) => {
        const bus = createBusInstance();
        const { subjects } = bus.registerNamespace(namespace);
        const peer = new PendingPeer();
        const started = pDefer<void>();
        const work = pDefer<void>();
        const controller = new AbortController();
        const registration = bus.getContext().transportRegistry.registerTransport('cancellationProvenance', peer);
        await registration.ready;
        if (path === 'local') {
          bus.on(subjects.wait, async (ctx) => {
            started.resolve();
            await work.promise;
            ctx.setResult({ ok: true });
          });
        } else {
          bus
            .getContext()
            .remoteRequestHandlers.set('cancellationProvenance.wait', [
              { transport: 'cancellationProvenance', priority: 0 },
            ]);
        }

        try {
          if (phase === 'before') controller.abort(create());
          const result = bus
            .request(subjects.wait, {}, { timeout, signal: controller.signal })
            .catch((e: unknown) => e);
          if (phase === 'in flight') {
            await (path === 'local' ? started.promise : peer.started.promise);
            controller.abort(create());
          }
          expectCancellation(await result, controller.signal, preserveIdentity);
          await Promise.resolve();
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
          if (path === 'remote' && phase === 'in flight') {
            expect(peer.cancellations).toHaveLength(1);
            expectCancellation(peer.cancellations[0], controller.signal, preserveIdentity);
          }
        } finally {
          work.resolve();
          await peer.disconnect();
          registration.unregister();
          bus.__resetHandlers?.();
        }
      });
    });
  });
});

describe('public cancellation classification', () => {
  it.each(nonErrorReasons)('requires a wrapper for a matching raw $name rejection', ({ reason }) => {
    const signal = AbortSignal.abort(reason);
    expect(isRequestCancellation(reason, signal)).toBe(false);
    expectCancellation(new BusAbortError(reason), signal);
  });

  it.each(reasons)('does not classify independent failures for $name', ({ create, preserveIdentity }) => {
    const signal = AbortSignal.abort(create());
    expect(isRequestCancellation(signal.reason, signal)).toBe(preserveIdentity);
    expect(isRequestCancellation(new Error('shutdown'), signal)).toBe(false);
    expect(isRequestCancellation(new DOMException('shutdown', 'AbortError'), signal)).toBe(false);
    expect(isRequestCancellation(new BusAbortError({ source: 'shutdown' }), signal)).toBe(false);
    expect(isRequestCancellation(signal.reason, new AbortController().signal)).toBe(false);
    expect(isRequestCancellation(signal.reason)).toBe(false);
  });

  it.each(timeouts)('preserves caller TimeoutError cancellation in broadcast timeout=%s', async (timeout) => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const work = pDefer<void>();
    bus.on(subjects.wait, () => work.promise);
    const signal = AbortSignal.abort(new DeadlineError('caller cancellation'));
    try {
      await expect(bus.broadcast(subjects.wait, {}, { timeout, signal })).rejects.toBe(signal.reason);
    } finally {
      work.resolve();
      bus.__resetHandlers?.();
    }
  });

  it('does not turn cancellation into an optional missing handler result', async () => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const signal = AbortSignal.abort(new NoHandlerError('caller cancellation'));
    await expect(bus.requestOptional(subjects.wait, {}, { signal })).rejects.toBe(signal.reason);
  });

  it.each(['request', 'broadcast'] as const)('keeps genuine %s timeout distinct', async (method) => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const work = pDefer<void>();
    const controller = new AbortController();
    bus.on(subjects.wait, () => work.promise);
    const result = bus[method](subjects.wait, {}, { timeout: 20, signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(TimeoutError);
    expect(isRequestCancellation(await result, controller.signal)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    work.resolve();
    bus.__resetHandlers?.();
  });
});

describe('dispatch cancellation provenance', () => {
  it.each([
    { name: 'cooperative', reason: 'shutdown', failure: new BusAbortError('shutdown'), cancellation: true },
    ...independentFailures.map((entry) => ({ ...entry, cancellation: false })),
  ])('preserves the provenance of a local $name rejection', async ({ reason, failure, cancellation }) => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const controller = new AbortController();
    bus.on(subjects.wait, () => {
      controller.abort(reason);
      throw failure;
    });
    const result = await dispatch(
      bus.getContext(),
      subjects.wait,
      {},
      {
        correlationId: 'local',
        messageId: 'local',
        timeout: 0,
        signal: controller.signal,
      },
    ).catch((e: unknown) => e);
    if (!cancellation) {
      expect(result).toBeInstanceOf(RequestError);
      if (failure instanceof Error) expect(result).toMatchObject({ cause: failure });
      expect(isRequestCancellation(result, controller.signal)).toBe(false);
    } else {
      expectCancellation(result, controller.signal);
    }
    bus.__resetHandlers?.();
  });

  it.each(independentFailures)('retains an independent $name transport rejection', async ({ reason, failure }) => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const peer = new PendingPeer();
    const controller = new AbortController();
    peer.failure = failure;
    const registration = bus.getContext().transportRegistry.registerTransport('cancellationProvenance', peer);
    await registration.ready;
    bus
      .getContext()
      .remoteRequestHandlers.set('cancellationProvenance.wait', [{ transport: 'cancellationProvenance', priority: 0 }]);
    const fallback = vi.fn((ctx: { setResult: (result: { ok: boolean }) => void }) => ctx.setResult({ ok: true }));
    bus.on(subjects.wait, fallback, { priority: -1 });
    // The wait observes rejection before the queued cancellation runs. The dispatch
    // catch must retain that failure even though the signal is aborted by then.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = dispatch(
      bus.getContext(),
      subjects.wait,
      {},
      {
        correlationId: 'remote',
        messageId: 'remote',
        timeout: 0,
        signal: controller.signal,
      },
    ).catch((e: unknown) => e);
    queueMicrotask(() => controller.abort(reason));
    try {
      expect(await result).toBe(failure);
      expect(isRequestCancellation(await result, controller.signal)).toBe(false);
      expect(peer.cancellations).toHaveLength(0);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      registration.unregister();
      await peer.disconnect();
    }
  });

  it.each([
    'cancellation',
    'failure',
  ] as const)('observes detached child rejection after owning handler %s', async (outcome) => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const controller = new AbortController();
    const child = pDefer<void>();
    const failure = new Error('owning handler failed');
    bus.on(
      subjects.wait,
      (ctx) => {
        void ctx.next();
        if (outcome === 'cancellation') {
          controller.abort('shutdown');
          throw new BusAbortError(controller.signal.reason);
        }
        throw failure;
      },
      { priority: 1 },
    );
    bus.on(subjects.wait, () => child.promise);
    try {
      const result = await bus.request(subjects.wait, {}, { signal: controller.signal }).catch((e: unknown) => e);
      if (outcome === 'cancellation') expectCancellation(result, controller.signal);
      else expect(result).toMatchObject({ cause: failure });
      child.reject(new Error('late detached child failure'));
      // Vitest reports an unhandled rejection if dispatch failed to observe the detached next().
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      bus.__resetHandlers?.();
    }
  });

  it.each([false, true])('still propagates downstream failures with awaited next=%s', async (awaitNext) => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(namespace);
    const child = pDefer<void>();
    const failure = new Error('downstream failed');
    bus.on(
      subjects.wait,
      async (ctx) => {
        const next = ctx.next();
        if (awaitNext) await next;
      },
      { priority: 1 },
    );
    bus.on(subjects.wait, () => child.promise);
    try {
      const result = bus.request(subjects.wait, {}).catch((e: unknown) => e);
      child.reject(failure);
      expect(await result).toBeInstanceOf(RequestError);
      expect(await result).toMatchObject({ cause: failure });
    } finally {
      bus.__resetHandlers?.();
    }
  });
});
