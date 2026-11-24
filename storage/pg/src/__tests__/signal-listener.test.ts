/**
 * Deterministic lifecycle tests for {@link createPostgresDatabaseSignals}.
 *
 * Drives the real implementation through its `createClient` injection seam
 * with a small fake `PostgresSignalClientLike` whose `connect()`, `query()`
 * ("LISTEN …") and `end()` are each controlled explicitly by the test. The
 * fake's `'notification'`/`'error'`/`'end'` events are backed by a real
 * `node:events` `EventEmitter`, so it reproduces the two node-postgres
 * behaviours the implementation's lifecycle depends on: an `'error'` emitted
 * with no listener attached throws synchronously (exactly like an
 * unlistened `Client` `'error'`), and a handler is only ever observed once —
 * removing it is a real `off()`, not a silently-ignored bookkeeping flag.
 * Fake timers drive the reconnect backoff, so every case below is
 * deterministic: no real Postgres server, no timing-dependent polling.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPostgresDatabaseSignals,
  POSTGRES_WAKE_CHANNEL,
  type PostgresDatabaseSignals,
} from '../signal-listener.js';
import type { PostgresNotificationLike, PostgresSignalClientLike } from '../pg-signal-client.js';
import type { DatabaseSignal } from '@makaio/storage-drizzle';

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

/** A promise plus its own resolve/reject, handed to the test instead of being awaited internally. */
interface Deferred<T> {
  /** The controlled promise. */
  readonly promise: Promise<T>;
  /** Resolve {@link Deferred.promise}. */
  readonly resolve: (value: T) => void;
  /** Reject {@link Deferred.promise}. */
  readonly reject: (error: Error) => void;
}

/**
 * Create a promise together with its own resolve/reject functions.
 * @returns A fresh, externally controllable promise.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake `PostgresSignalClientLike`: `connect()` and `query('LISTEN …')` are
 * pending until the test resolves or rejects them; `end()` resolves
 * immediately unless the test calls {@link FakeSignalClient.delayEnd} first.
 * `'notification'`/`'error'`/`'end'` are delivered through a real
 * `node:events` `EventEmitter`, so {@link FakeSignalClient.emitError} throws
 * synchronously when no `'error'` listener is currently attached — the same
 * behaviour an unlistened `'error'` on a real `pg.Client` has — instead of
 * silently doing nothing. That makes a regression that detaches the
 * implementation's `'error'` handler too early (before its connection's
 * `end()` has settled) surface as a thrown error from this fake rather than
 * being swallowed.
 */
class FakeSignalClient implements PostgresSignalClientLike {
  private readonly connectDeferred = createDeferred<void>();
  private readonly listenDeferred = createDeferred<unknown>();
  private endDeferred: Deferred<void> | undefined;
  private readonly emitter = new EventEmitter();
  /** Number of times {@link FakeSignalClient.end} was called. */
  public endCallCount = 0;

  public connect(): Promise<void> {
    return this.connectDeferred.promise;
  }

  public query(text: string): Promise<unknown> {
    return text.startsWith('LISTEN') ? this.listenDeferred.promise : Promise.resolve(undefined);
  }

  public end(): Promise<void> {
    this.endCallCount += 1;
    return this.endDeferred === undefined ? Promise.resolve() : this.endDeferred.promise;
  }

  public on(event: 'notification', listener: (notification: PostgresNotificationLike) => void): void;
  public on(event: 'error', listener: (error: Error) => void): void;
  public on(event: 'end', listener: () => void): void;
  public on(
    event: 'notification' | 'error' | 'end',
    listener: ((notification: PostgresNotificationLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    this.emitter.on(event, listener);
  }

  public off(event: 'notification', listener: (notification: PostgresNotificationLike) => void): void;
  public off(event: 'error', listener: (error: Error) => void): void;
  public off(event: 'end', listener: () => void): void;
  public off(
    event: 'notification' | 'error' | 'end',
    listener: ((notification: PostgresNotificationLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    this.emitter.off(event, listener);
  }

  /**
   * Whether a handler is currently attached for `event`. The implementation
   * attaches its handlers once per connection attempt and only detaches
   * them once that connection's `release()` has fully settled; this lets a
   * test assert that detachment timing directly instead of inferring it
   * from side effects.
   * @param event - Event name to inspect.
   * @returns `true` while at least one listener is attached for `event`.
   */
  public hasListeners(event: 'notification' | 'error' | 'end'): boolean {
    return this.emitter.listenerCount(event) > 0;
  }

  /** Resolve the pending `connect()` call. */
  public resolveConnect(): void {
    this.connectDeferred.resolve();
  }

  /**
   * Reject the pending `connect()` call.
   * @param error - Failure to reject with.
   */
  public rejectConnect(error: Error): void {
    this.connectDeferred.reject(error);
  }

  /** Resolve the pending `query('LISTEN …')` call. */
  public resolveListen(): void {
    this.listenDeferred.resolve(undefined);
  }

  /**
   * Reject the pending `query('LISTEN …')` call.
   * @param error - Failure to reject with.
   */
  public rejectListen(error: Error): void {
    this.listenDeferred.reject(error);
  }

  /** Make the next `end()` call return a pending promise instead of resolving immediately. */
  public delayEnd(): void {
    this.endDeferred = createDeferred<void>();
  }

  /** Resolve a previously delayed `end()` call. A no-op when `end()` was never delayed. */
  public resolveEnd(): void {
    this.endDeferred?.resolve();
  }

  /**
   * Emit `'error'`. Throws synchronously — instead of silently doing
   * nothing — when no `'error'` listener is currently attached, exactly
   * like an unlistened `'error'` on a real `pg.Client`. Calling this twice
   * in a row while the implementation's handler is still attached simulates
   * node-postgres re-emitting `'error'` on the same client after a backend
   * termination.
   * @param error - Error payload to deliver.
   */
  public emitError(error: Error): void {
    this.emitter.emit('error', error);
  }

  /** Emit `'end'`. */
  public emitEnd(): void {
    this.emitter.emit('end');
  }

  /**
   * Emit `'notification'`.
   * @param notification - Notification payload to deliver.
   */
  public emitNotification(notification: PostgresNotificationLike): void {
    this.emitter.emit('notification', notification);
  }
}

/**
 * Builds fresh {@link FakeSignalClient}s and records every one created, so a
 * test can address "the Nth connection attempt" directly.
 */
interface FakeClientFactory {
  /** Pass as `createClient` to {@link createPostgresDatabaseSignals}. */
  readonly createClient: () => PostgresSignalClientLike;
  /** Every client created so far, in creation order. */
  readonly connections: FakeSignalClient[];
}

/**
 * Create a {@link FakeClientFactory}.
 * @returns A factory and the list of clients it has created.
 */
function createFakeClientFactory(): FakeClientFactory {
  const connections: FakeSignalClient[] = [];
  return {
    createClient: () => {
      const client = new FakeSignalClient();
      connections.push(client);
      return client;
    },
    connections,
  };
}

/** Drain the real microtask queue (several ticks, to carry multi-`await` continuations through). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * Drive one connection attempt to a confirmed `LISTEN`.
 * @param connection - The attempt's fake client.
 */
async function succeedAttempt(connection: FakeSignalClient): Promise<void> {
  connection.resolveConnect();
  await flush();
  connection.resolveListen();
  await flush();
}

/** Which stage of a connection attempt fails, for cases that need exactly one failing stage. */
type FailureMode = 'connectFailure' | 'listenFailure';

/**
 * Fail one connection attempt at the stage {@link mode} selects, driving it
 * all the way to its scheduled retry. One generic driver for both failing
 * stages instead of a copy of every case per stage.
 * @param mode - Whether `connect()` or `query('LISTEN …')` is the stage that fails.
 * @param connection - The attempt's fake client.
 * @param error - Failure to reject with.
 */
async function failAttempt(mode: FailureMode, connection: FakeSignalClient, error: Error): Promise<void> {
  if (mode === 'connectFailure') {
    connection.rejectConnect(error);
  } else {
    connection.resolveConnect();
    await flush();
    connection.rejectListen(error);
  }
  await flush();
}

/**
 * Complete a still-pending `connect()`/`LISTEN` call as if it finished only
 * after `close()` already ran: a failure for `'connectFailure'`, a full
 * success — both `connect()` and `LISTEN` resolve — for `'listenFailure'`.
 * The success variant is the more telling of the two: it proves a
 * late-arriving *successful* `LISTEN` still cannot resurrect a closed
 * listener.
 * @param mode - Which outcome to drive the stale attempt to.
 * @param connection - The stale attempt's fake client.
 */
async function completeStaleAttempt(mode: FailureMode, connection: FakeSignalClient): Promise<void> {
  if (mode === 'connectFailure') {
    connection.rejectConnect(new Error('stale connect() settling after close()'));
  } else {
    connection.resolveConnect();
    await flush();
    connection.resolveListen();
  }
  await flush();
}

/** Connection string handed to every capability created in this suite; never a real target. */
const CONNECTION_STRING = 'postgres://fake-host/fake-db';

/**
 * Create the capability under test over a fresh {@link FakeClientFactory}.
 * @returns The capability and the factory driving its connections.
 */
function createCapability(): { capability: PostgresDatabaseSignals; factory: FakeClientFactory } {
  const factory = createFakeClientFactory();
  const capability = createPostgresDatabaseSignals({
    connectionString: CONNECTION_STRING,
    createClient: factory.createClient,
  });
  return { capability, factory };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createPostgresDatabaseSignals lifecycle (fake client)', () => {
  it('opens no connection before the first subscribe() or ready() call', async () => {
    const { capability, factory } = createCapability();
    expect(factory.connections).toHaveLength(0);
    await capability.close();
  });

  it(
    'keeps ready() waiters pending across two consecutive failed attempts, resolves them all on the later ' +
      'confirmed LISTEN, and resolves immediately once already listening',
    async () => {
      const { capability, factory } = createCapability();
      try {
        const readyA = capability.ready();
        const readyB = capability.ready();
        let settled = false;
        readyA.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await flush();
        expect(factory.connections).toHaveLength(1);

        await failAttempt('connectFailure', factory.connections[0]!, new Error('attempt 1 failed'));
        expect(settled).toBe(false); // a failed attempt must not settle a waiter either way

        await vi.advanceTimersByTimeAsync(249);
        expect(factory.connections).toHaveLength(1); // backoff not yet elapsed
        await vi.advanceTimersByTimeAsync(1);
        expect(factory.connections).toHaveLength(2); // 250ms backoff elapsed

        await failAttempt('connectFailure', factory.connections[1]!, new Error('attempt 2 failed'));
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(499);
        expect(factory.connections).toHaveLength(2); // backoff doubled to 500ms, not yet elapsed
        await vi.advanceTimersByTimeAsync(1);
        expect(factory.connections).toHaveLength(3);

        await succeedAttempt(factory.connections[2]!);
        await expect(readyA).resolves.toBeUndefined();
        await expect(readyB).resolves.toBeUndefined();

        // Already listening: ready() resolves at once, no new connection attempt.
        await expect(capability.ready()).resolves.toBeUndefined();
        expect(factory.connections).toHaveLength(3);
      } finally {
        await capability.close();
      }
    },
  );

  it('emits no resynced event on the first confirmed LISTEN, and exactly one on a later reconnect', async () => {
    const { capability, factory } = createCapability();
    const resyncEvents: DatabaseSignal[] = [];
    try {
      capability.subscribe((event) => {
        if (event.kind === 'resynced') resyncEvents.push(event);
      });
      await flush();
      await succeedAttempt(factory.connections[0]!);
      expect(resyncEvents).toHaveLength(0);

      factory.connections[0]!.emitEnd();
      await flush();
      await vi.advanceTimersByTimeAsync(250);
      expect(factory.connections).toHaveLength(2);
      await succeedAttempt(factory.connections[1]!);
      expect(resyncEvents).toHaveLength(1);
    } finally {
      await capability.close();
    }
  });

  it.each([
    {
      name: 'a duplicate "error" event',
      trigger: (connection: FakeSignalClient) => {
        connection.emitError(new Error('backend terminated'));
        connection.emitError(new Error('backend terminated (re-emitted)'));
      },
    },
    {
      name: 'an "error" followed by "end" on the same connection',
      trigger: (connection: FakeSignalClient) => {
        connection.emitError(new Error('backend terminated'));
        connection.emitEnd();
      },
    },
    {
      name: 'a duplicate "end" event',
      trigger: (connection: FakeSignalClient) => {
        connection.emitEnd();
        connection.emitEnd();
      },
    },
  ])('$name concludes the connection exactly once, scheduling exactly one retry', async ({ trigger }) => {
    const { capability, factory } = createCapability();
    try {
      capability.subscribe(() => undefined);
      await flush();
      await succeedAttempt(factory.connections[0]!);

      trigger(factory.connections[0]!);
      await flush();

      await vi.advanceTimersByTimeAsync(249);
      expect(factory.connections).toHaveLength(1); // exactly one retry, not yet due
      await vi.advanceTimersByTimeAsync(1);
      expect(factory.connections).toHaveLength(2); // exactly one retry scheduled, not two
    } finally {
      await capability.close();
    }
  });

  it('continues retrying after repeated failures with bounded, doubling backoff, and resets the backoff after a success', async () => {
    const { capability, factory } = createCapability();
    try {
      capability.subscribe(() => undefined);
      await flush();
      expect(factory.connections).toHaveLength(1);

      await failAttempt('connectFailure', factory.connections[0]!, new Error('attempt 1 failed'));
      await vi.advanceTimersByTimeAsync(249);
      expect(factory.connections).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(factory.connections).toHaveLength(2); // 250ms base delay

      await failAttempt('connectFailure', factory.connections[1]!, new Error('attempt 2 failed'));
      await vi.advanceTimersByTimeAsync(499);
      expect(factory.connections).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(factory.connections).toHaveLength(3); // doubled to 500ms

      await succeedAttempt(factory.connections[2]!);
      factory.connections[2]!.emitEnd(); // conclude the now-listening connection to re-enter backoff
      await flush();

      await vi.advanceTimersByTimeAsync(249);
      expect(factory.connections).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(factory.connections).toHaveLength(4); // reset to the 250ms base delay after the earlier success
    } finally {
      await capability.close();
    }
  });

  it('drives the retry backoff up to its upper bound and keeps it capped on a further retry', async () => {
    const { capability, factory } = createCapability();
    try {
      capability.subscribe(() => undefined);
      await flush();

      // The implementation doubles a 250ms base delay per failed attempt up to a 30s cap; neither constant is
      // exported, so this sequence is asserted as the observed literal series rather than re-derived here.
      const expectedDelaysMs = [250, 500, 1000, 2000, 4000, 8000, 16000, 30_000, 30_000];
      for (const [index, delay] of expectedDelaysMs.entries()) {
        expect(factory.connections).toHaveLength(index + 1);
        await failAttempt('connectFailure', factory.connections[index]!, new Error(`attempt ${index} failed`));
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(factory.connections).toHaveLength(index + 1); // backoff not yet elapsed
        await vi.advanceTimersByTimeAsync(1);
        expect(factory.connections).toHaveLength(index + 2); // backoff elapsed; next attempt started, still capped
      }
    } finally {
      await capability.close();
    }
  });

  // -------------------------------------------------------------------------
  // close() across every lifecycle phase a connection can be in, crossed with
  // which stage of the attempt fails (E110: one scenario table, one driver).
  // -------------------------------------------------------------------------

  /** Which point in the lifecycle `close()` is invoked at, for the scenario table below. */
  type ClosePhase = 'connecting' | 'retryWait' | 'currentEndPending' | 'earlierEndPending';

  const closeScenarios: Array<{ mode: FailureMode; phase: ClosePhase }> = [
    { mode: 'connectFailure', phase: 'connecting' },
    { mode: 'listenFailure', phase: 'connecting' },
    { mode: 'connectFailure', phase: 'retryWait' },
    { mode: 'listenFailure', phase: 'retryWait' },
    { mode: 'connectFailure', phase: 'currentEndPending' },
    { mode: 'listenFailure', phase: 'currentEndPending' },
    { mode: 'connectFailure', phase: 'earlierEndPending' },
    { mode: 'listenFailure', phase: 'earlierEndPending' },
  ];

  it.each(closeScenarios)(
    'close() during $phase (triggered via $mode) awaits every pending end(), is idempotent, detaches handlers ' +
      'only after release, and a stale connect()/LISTEN settling later cannot resurrect the listener',
    async ({ mode, phase }) => {
      const { capability, factory } = createCapability();
      const resyncEvents: DatabaseSignal[] = [];
      capability.subscribe((event) => {
        if (event.kind === 'resynced') resyncEvents.push(event);
      });
      const pendingReady = capability.ready();
      pendingReady.catch(() => undefined); // owned by this test; attached before close() can reject it
      await flush();
      expect(factory.connections).toHaveLength(1);

      /** The earlier failed connection in the `earlierEndPending` phase, still releasing when close() runs. */
      let earlierFailed: FakeSignalClient | undefined;

      if (phase === 'retryWait') {
        await failAttempt(mode, factory.connections[0]!, new Error('attempt 1 failed'));
        expect(factory.connections).toHaveLength(1); // retry scheduled, not yet due
      } else if (phase === 'currentEndPending') {
        factory.connections[0]!.delayEnd();
      } else if (phase === 'earlierEndPending') {
        factory.connections[0]!.delayEnd();
        await failAttempt(mode, factory.connections[0]!, new Error('attempt 1 failed'));
        earlierFailed = factory.connections[0]!;
        expect(earlierFailed.endCallCount).toBe(1);
        await vi.advanceTimersByTimeAsync(250); // first failure's backoff is always the 250ms base delay
        expect(factory.connections).toHaveLength(2); // the next attempt is now current
      }
      // 'connecting': connection 0 is left mid-attempt, with no delay — close() must still settle immediately.

      const firstClosePromise = capability.close();
      let closed = false;
      void firstClosePromise.then(() => {
        closed = true;
      });

      if (phase === 'connecting' || phase === 'retryWait') {
        await flush();
        expect(closed).toBe(true); // nothing pending to release but the (undelayed) current connection, if any
        expect(factory.connections[0]!.endCallCount).toBe(1);
        expect(factory.connections[0]!.hasListeners('error')).toBe(false);
        if (phase === 'retryWait') {
          await vi.advanceTimersByTimeAsync(60_000); // well past any possible backoff, including the cap
          expect(factory.connections).toHaveLength(1); // the retry timer was cleared, not merely delayed
        }
      } else if (phase === 'currentEndPending') {
        await flush();
        expect(closed).toBe(false); // the current connection's delayed end() is still pending
        expect(factory.connections[0]!.endCallCount).toBe(1);
        expect(factory.connections[0]!.hasListeners('error')).toBe(true); // handler stays attached until release ends
        factory.connections[0]!.resolveEnd();
        await firstClosePromise;
        expect(closed).toBe(true);
        expect(factory.connections[0]!.hasListeners('error')).toBe(false); // detached only now
      } else {
        // earlierEndPending
        await flush();
        expect(closed).toBe(false); // the earlier (releasing) connection's delayed end() is still pending
        expect(earlierFailed!.endCallCount).toBe(1);
        expect(earlierFailed!.hasListeners('error')).toBe(true);
        expect(factory.connections[1]!.endCallCount).toBe(1); // the then-current connection was released too
        earlierFailed!.resolveEnd();
        await firstClosePromise;
        expect(closed).toBe(true);
        expect(earlierFailed!.hasListeners('error')).toBe(false);
        expect(earlierFailed!.endCallCount).toBe(1); // still exactly one end() call, never repeated
      }

      // Idempotent and memoized: repeated close() is the very same promise.
      expect(capability.close()).toBe(firstClosePromise);

      // Every pending and later ready()/subscribe() call rejects/throws once closed.
      await expect(pendingReady).rejects.toThrow(/close/);
      await expect(capability.ready()).rejects.toThrow(/close/);
      expect(() => capability.subscribe(() => undefined)).toThrow(/close/);

      // A connect()/LISTEN that only settles after close() must not resurrect the listener: no new connection, no
      // resynced event, and the already-rejected waiters stay rejected (already asserted above).
      if (phase !== 'retryWait') {
        const staleConnection = factory.connections[factory.connections.length - 1]!;
        const connectionsBeforeCompletion = factory.connections.length;
        await completeStaleAttempt(mode, staleConnection);
        expect(factory.connections).toHaveLength(connectionsBeforeCompletion); // no new connection was created
        expect(staleConnection.endCallCount).toBe(1); // conclude()'s release() is memoized, not re-invoked
      }
      expect(resyncEvents).toHaveLength(0);
    },
  );

  it('subscribe() then close() without ever calling ready() produces no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { capability } = createCapability();
      const unsubscribe = capability.subscribe(() => undefined);
      await flush();
      await capability.close();
      await flush();
      unsubscribe(); // idempotent even though close() already cleared the registration

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('registers the same listener function twice as two independent entries; each remove removes exactly one', async () => {
    const { capability, factory } = createCapability();
    try {
      const received: DatabaseSignal[] = [];
      const listener = (event: DatabaseSignal): void => {
        received.push(event);
      };
      const removeFirst = capability.subscribe(listener);
      const removeSecond = capability.subscribe(listener);
      await flush();
      await succeedAttempt(factory.connections[0]!);

      const notify = (payload: string): void =>
        factory.connections[0]!.emitNotification({ processId: 1, channel: POSTGRES_WAKE_CHANNEL, payload });

      notify('a');
      expect(received).toHaveLength(2);

      removeFirst();
      notify('b');
      expect(received).toHaveLength(3);

      removeSecond();
      notify('c');
      expect(received).toHaveLength(3);
    } finally {
      await capability.close();
    }
  });

  it('close() clears every registration: a listener registered just before close() receives nothing notified after', async () => {
    const { capability, factory } = createCapability();
    const received: DatabaseSignal[] = [];
    capability.subscribe((event) => received.push(event));
    await flush();
    await succeedAttempt(factory.connections[0]!);

    await capability.close();
    expect(received).toHaveLength(0);

    // Prove the empty result above is because delivery stopped, not because nothing was ever sent: the connection
    // is released by close(), so this notification has no still-current connection and no registration left to
    // reach — exactly the condition the assertion above is meant to rule out.
    factory.connections[0]!.emitNotification({ processId: 1, channel: POSTGRES_WAKE_CHANNEL, payload: 'after-close' });
    expect(received).toHaveLength(0);
  });

  it('a throwing or rejecting direct subscriber does not stop delivery to the other subscribers', async () => {
    const { capability, factory } = createCapability();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const goodEvents: DatabaseSignal[] = [];
      capability.subscribe(() => {
        throw new Error('throwing subscriber');
      });
      capability.subscribe(() => Promise.reject(new Error('rejecting subscriber')));
      capability.subscribe((event) => goodEvents.push(event));
      await flush();
      await succeedAttempt(factory.connections[0]!);

      factory.connections[0]!.emitNotification({ processId: 1, channel: POSTGRES_WAKE_CHANNEL, payload: 'topic' });
      await flush();

      expect(goodEvents).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await capability.close();
    }
  });

  it('ignores a notification delivered on a channel other than the fixed wake channel', async () => {
    const { capability, factory } = createCapability();
    try {
      const received: DatabaseSignal[] = [];
      capability.subscribe((event) => received.push(event));
      await flush();
      await succeedAttempt(factory.connections[0]!);

      factory.connections[0]!.emitNotification({ processId: 1, channel: 'unrelated_channel', payload: 'x' });
      expect(received).toHaveLength(0);

      factory.connections[0]!.emitNotification({ processId: 1, channel: POSTGRES_WAKE_CHANNEL, payload: 'y' });
      expect(received).toHaveLength(1);
    } finally {
      await capability.close();
    }
  });

  describe('notify topic validation (unchanged behaviour)', () => {
    it.each([
      { name: 'an empty topic', topic: '', pattern: /non-empty/ },
      { name: 'a topic containing a NUL byte', topic: 'contains-\u0000-a-nul', pattern: /NUL/ },
      { name: 'a topic too long for a NOTIFY payload', topic: 'x'.repeat(8000), pattern: /7999/ },
    ])('rejects $name', async ({ topic, pattern }) => {
      const { capability } = createCapability();
      try {
        expect(() => capability.notifyExpression(topic)).toThrow(pattern);
      } finally {
        await capability.close();
      }
    });

    it('builds a pg_notify expression for a valid topic', async () => {
      const { capability } = createCapability();
      try {
        const expression = capability.notifyExpression('a-valid-topic');
        expect(expression).toBeDefined();
      } finally {
        await capability.close();
      }
    });
  });
});
