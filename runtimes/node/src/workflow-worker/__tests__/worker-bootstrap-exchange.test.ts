import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionLostError, NoHandlerError, TimeoutError } from '@makaio/bus-core';
import { WebSocketConnectionError } from '@makaio/bus-transport-websocket';
import {
  BootstrapDeadlineExceededError,
  runWorkerBootstrapExchange,
  withWorkerBootstrapDeadline,
  type WorkerBootstrapExchangeOptions,
} from '../worker-bootstrap-exchange.js';

interface Session {
  readonly id: number;
  disposed: boolean;
}

/**
 * Exercise the real ownership loop using a small, observable session resource.
 * @param overrides - Per-case asynchronous behavior.
 * @returns Options, acquired resources and caller cancellation.
 */
function scenario(overrides: Partial<WorkerBootstrapExchangeOptions<Session, string>> = {}) {
  const controller = new AbortController();
  const sessions: Session[] = [];
  const options: WorkerBootstrapExchangeOptions<Session, string> = {
    bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    signal: controller.signal,
    createSession: () => {
      const session = { id: sessions.length, disposed: false };
      sessions.push(session);
      return session;
    },
    connect: async () => {},
    exchange: async () => ({ status: 'complete', value: 'permitted' }),
    dispose: (session) => {
      session.disposed = true;
    },
    ...overrides,
  };
  return { options, sessions, controller };
}

describe('worker bootstrap exchange ownership and budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('transfers success and leaves no timer or caller cancellation listener behind', async () => {
    let connectSignal: AbortSignal | undefined;
    const { options, sessions, controller } = scenario({
      connect: async (_session, signal) => {
        connectSignal = signal;
      },
    });
    const result = await runWorkerBootstrapExchange(options);
    expect(result).toEqual({ session: sessions[0], value: 'permitted' });
    expect(sessions[0]?.disposed).toBe(false);
    expect(connectSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sessions[0]?.disposed).toBe(false);
    expect(connectSignal?.aborted).toBe(false);
  });

  it.each([
    '',
    'Infinity',
    '2026-09-07',
    '2026-02-30T00:00:00.000Z',
  ])('rejects invalid absolute deadline %s before acquiring resources', async (bootstrapDeadlineAt) => {
    const { options, sessions } = scenario({ bootstrapDeadlineAt });
    await expect(runWorkerBootstrapExchange(options)).rejects.toBeInstanceOf(TypeError);
    expect(sessions).toEqual([]);
  });

  it('never acquires a session for an expired Attempt', async () => {
    const { options, sessions } = scenario({ bootstrapDeadlineAt: new Date(Date.now()).toISOString() });
    await expect(runWorkerBootstrapExchange(options)).rejects.toBeInstanceOf(BootstrapDeadlineExceededError);
    expect(sessions).toEqual([]);
  });

  it.each([
    '2026-09-07T12:00:01Z',
    '2026-09-07T14:00:01+02:00',
  ])('accepts equivalent ISO instants without requiring canonical input: %s', async (bootstrapDeadlineAt) => {
    vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
    const leases: number[] = [];
    const { options } = scenario({
      bootstrapDeadlineAt,
      exchange: async (_session, { timeoutMs }) => {
        leases.push(timeoutMs);
        return { status: 'complete', value: 'permitted' };
      },
    });
    await expect(runWorkerBootstrapExchange(options)).resolves.toMatchObject({ value: 'permitted' });
    expect(leases).toEqual([1000]);
  });

  it('accepts an extended-year deadline emitted by the Date-based producer', async () => {
    const bootstrapDeadlineAt = new Date(Date.UTC(10_000, 0, 1)).toISOString();
    expect(bootstrapDeadlineAt).toBe('+010000-01-01T00:00:00.000Z');
    const leases: number[] = [];
    const { options } = scenario({
      bootstrapDeadlineAt,
      exchange: async (_session, { timeoutMs }) => {
        leases.push(timeoutMs);
        return { status: 'complete', value: 'permitted' };
      },
    });
    await expect(runWorkerBootstrapExchange(options)).resolves.toMatchObject({ value: 'permitted' });
    await expect(
      withWorkerBootstrapDeadline(bootstrapDeadlineAt, options.signal, async () => 'bootstrapped'),
    ).resolves.toBe('bootstrapped');
    expect(leases).toEqual([35_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews pending on the same session with the decreasing remaining budget', async () => {
    const leases: number[] = [];
    const { options, sessions } = scenario({
      bootstrapDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
      exchange: async (_session, { timeoutMs }) => {
        leases.push(timeoutMs);
        if (leases.length === 1) {
          vi.setSystemTime(Date.now() + 5000);
          return { status: 'pending' };
        }
        return { status: 'complete', value: 'permitted' };
      },
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(sessions).toHaveLength(1);
    expect(leases[0]).toBe(20_000);
    expect(leases[1]).toBeLessThanOrEqual(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'denied'),
    new WebSocketConnectionError('WS_POLICY_REJECTED', 'denied'),
    new NoHandlerError('bootstrap'),
    new Error('WS_CONNECTION_UNAVAILABLE'),
    Object.assign(new Error('forged category'), { code: 'WS_CONNECTION_UNAVAILABLE' }),
  ])('does not retry terminal or unclassified failure $name: $message', async (failure) => {
    const { options, sessions } = scenario({
      exchange: async () => {
        throw failure;
      },
    });
    await expect(runWorkerBootstrapExchange(options)).rejects.toBe(failure);
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'unavailable'),
    new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'timeout'),
    new WebSocketConnectionError('WS_CONNECTION_TIMEOUT', 'timeout'),
    new ConnectionLostError('websocket'),
    new TimeoutError('bootstrap', 35_000),
  ])('disposes before reconnecting on typed transient failure $name', async (failure) => {
    const { options, sessions } = scenario({
      connect: async (session) => {
        if (session.id === 0) throw failure;
        expect(sessions[0]?.disposed).toBe(true);
      },
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(sessions.map((session) => session.disposed)).toEqual([true, false]);
  });

  it.each(['connect', 'exchange'] as const)('bounds a stalled %s even when it ignores abort', async (phase) => {
    let finish: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { options, sessions } = scenario({
      bootstrapDeadlineAt: new Date(Date.now() + 3000).toISOString(),
      ...(phase === 'connect'
        ? { connect: () => stalled }
        : {
            exchange: async () => {
              await stalled;
              return { status: 'complete' as const, value: 'late' };
            },
          }),
    });
    const failed = expect(runWorkerBootstrapExchange(options)).rejects.toBeInstanceOf(BootstrapDeadlineExceededError);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(sessions[0]?.disposed).toBe(true);
    finish?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancellation dominates retry classification and disposes the pending handle', async () => {
    const { options, sessions, controller } = scenario({ connect: () => new Promise(() => {}) });
    const reason = new Error('caller cancelled');
    const failed = expect(runWorkerBootstrapExchange(options)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    await failed;
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes late connection rejection after cancellation and releases backoff timers', async () => {
    let failConnection: ((error: Error) => void) | undefined;
    const { options, controller, sessions } = scenario({
      connect: () =>
        new Promise((_resolve, reject) => {
          failConnection = reject;
        }),
    });
    const reason = new Error('cancel pending connection');
    const failed = expect(runWorkerBootstrapExchange(options)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    await failed;
    failConnection?.(new ConnectionLostError('websocket'));
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry backoff without acquiring another session', async () => {
    const { options, controller, sessions } = scenario({
      connect: async () => {
        throw new ConnectionLostError('websocket');
      },
    });
    const reason = new Error('cancel retry');
    const failed = expect(runWorkerBootstrapExchange(options)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(reason);
    await failed;
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('will not reconnect while cleanup is pending and bounds cleanup by the total deadline', async () => {
    const { options, sessions } = scenario({
      bootstrapDeadlineAt: new Date(Date.now() + 3000).toISOString(),
      connect: async () => {
        throw new ConnectionLostError('websocket');
      },
      dispose: (session) => {
        session.disposed = true;
        return new Promise(() => {});
      },
    });
    const failed = expect(runWorkerBootstrapExchange(options)).rejects.toBeInstanceOf(BootstrapDeadlineExceededError);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a standalone bootstrap callback without retrying it', async () => {
    const { options, controller } = scenario();
    let receivedSignal: AbortSignal | undefined;
    const failed = expect(
      withWorkerBootstrapDeadline(options.bootstrapDeadlineAt, controller.signal, (signal) => {
        receivedSignal = signal;
        return new Promise(() => {});
      }),
    ).rejects.toBeInstanceOf(BootstrapDeadlineExceededError);
    await vi.advanceTimersByTimeAsync(120_000);
    await failed;
    expect(receivedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses exponential backoff capped at ten seconds without resetting on connect success', async () => {
    const started: number[] = [];
    const start = Date.now();
    const { options } = scenario({
      connect: async () => {
        started.push(Date.now() - start);
      },
      exchange: async (session) => {
        if (session.id < 6) throw new ConnectionLostError('websocket');
        return { status: 'complete', value: 'permitted' };
      },
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(started).toEqual([0, 1000, 3000, 7000, 15_000, 25_000, 35_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets backoff after a valid pending response, not before', async () => {
    const started: number[] = [];
    const start = Date.now();
    let pendingReturned = false;
    const { options } = scenario({
      connect: async () => {
        started.push(Date.now() - start);
      },
      exchange: async (session) => {
        if (session.id === 2 && !pendingReturned) {
          pendingReturned = true;
          return { status: 'pending' };
        }
        if (session.id < 3) throw new ConnectionLostError('websocket');
        return { status: 'complete', value: 'permitted' };
      },
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(4001);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(started.slice(0, 3)).toEqual([0, 1000, 3000]);
    expect(started[3]).toBeLessThanOrEqual(4001);
  });

  it.each([
    ['connect', 10_000],
    ['exchange', 35_000],
  ] as const)('caps %s before the total deadline and disposes it before retry', async (phase, lease) => {
    const { options, sessions } = scenario({
      ...(phase === 'connect'
        ? { connect: (session: Session) => (session.id === 0 ? new Promise<void>(() => {}) : Promise.resolve()) }
        : {
            exchange: async (session: Session) => {
              if (session.id === 0) await new Promise<void>(() => {});
              return { status: 'complete' as const, value: 'permitted' };
            },
          }),
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(lease);
    expect(sessions).toEqual([{ id: 0, disposed: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(sessions).toHaveLength(2);
  });

  it('rejects a phase result that arrives after its lease even before its timer runs', async () => {
    const { options, sessions } = scenario({
      connect: async (session) => {
        if (session.id === 0) vi.setSystemTime(Date.now() + 10_001);
      },
    });
    const done = runWorkerBootstrapExchange(options);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ value: 'permitted' });
    expect(sessions.map((session) => session.disposed)).toEqual([true, false]);
  });

  it('does not let a large persisted budget overflow the platform timer', async () => {
    const controller = new AbortController();
    const deadline = new Date(Date.now() + 3_000_000_000).toISOString();
    const reason = new Error('cancel long budget');
    const failed = expect(
      withWorkerBootstrapDeadline(deadline, controller.signal, () => new Promise(() => {})),
    ).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
