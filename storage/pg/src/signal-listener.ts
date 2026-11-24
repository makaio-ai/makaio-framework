/**
 * Postgres implementation of the database signal capability.
 *
 * Postgres can wake readers in other processes at commit time through
 * `pg_notify`/`LISTEN`: a writer notifies a fixed channel inside its
 * committing transaction, and every connection that issued `LISTEN` on that
 * channel receives the notification once the transaction commits (never on
 * rollback). This module builds the `database-notify` branch of
 * `DatabaseSignals` over one dedicated `pg.Client` per database client,
 * opened lazily on the first subscription — never one of the writing pool's
 * connections, which would otherwise stay checked out indefinitely just to
 * remain subscribed.
 *
 * Lifecycle invariants:
 * - Direct subscribers live in one {@link RegistrationSet}: registering the
 *   same listener function twice yields two independent entries, each
 *   removed independently.
 * - `ready()` never owns a long-lived promise. Closed: a fresh, caller-owned
 *   rejection. Already listening: a resolved promise. Otherwise: a waiter is
 *   enqueued and a connection attempt is ensured. A confirmed `LISTEN`
 *   resolves and clears every waiter; a failed attempt leaves them waiting;
 *   `close()` rejects and clears them — no promise this module creates for
 *   itself is ever left unobserved.
 * - At most one connection is owned at a time. Each connection has one
 *   memoized `release()`: end it, wait for that to settle, only then detach
 *   its handlers (node-postgres can re-emit `'error'` on the very same
 *   client once the underlying socket finally closes, and an unlistened
 *   `'error'` crashes the process). A connection whose release started
 *   outside `close()` — a failed attempt — is tracked until that release
 *   settles, so `close()` can still wait for it.
 * - The first `'error'`/`'end'` (or a failed `connect()`/`LISTEN`) of a
 *   connection concludes it exactly once, merged by connection identity;
 *   later events of the same connection are swallowed by its still-attached
 *   handlers until release has completed.
 * - A concluded connection schedules at most one retry timer with bounded
 *   exponential backoff, unless closed; retries continue until success or
 *   close, and success resets the backoff. A confirmed `LISTEN` that follows
 *   an earlier confirmed `LISTEN` of this capability emits a `resynced`
 *   event; the very first confirmed `LISTEN` does not.
 * - `close()` is idempotent and memoized: mark closed, clear a pending retry
 *   timer, reject and clear waiters, clear the subscriber set, release every
 *   owned connection (current and still-releasing) and await them. After
 *   close, `subscribe()` throws and `ready()` rejects.
 * - No connection is opened before the first `subscribe()`/`ready()` call.
 * - No internal path (attempts, releases, retry timers, notification
 *   handling) produces an unhandled rejection; subscriber delivery goes
 *   through `invokeListenersSafely`.
 * @packageDocumentation
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  createRegistrationSet,
  invokeListenersSafely,
  type DatabaseSignal,
  type DatabaseSignals,
  type RegistrationSet,
} from '@makaio/storage-drizzle';
import type { PostgresNotificationLike, PostgresSignalClientLike } from './pg-signal-client.js';

/**
 * The `database-notify` branch of {@link DatabaseSignals}, as produced by
 * {@link createPostgresDatabaseSignals}.
 */
export type PostgresDatabaseSignals = Extract<DatabaseSignals, { kind: 'database-notify' }>;

/**
 * Fixed channel every client of this capability listens on and notifies.
 *
 * One well-known channel per deployment (not one channel per topic or per
 * table) keeps the listener side to a single `LISTEN` statement; topics are
 * carried in the notification payload instead, validated by
 * {@link validateNotifyTopic}.
 */
export const POSTGRES_WAKE_CHANNEL = 'makaio_storage_wake_v1';

/**
 * Postgres truncates a `NOTIFY` payload silently once it approaches 8000
 * bytes, so this capability rejects a topic that would be truncated instead
 * of delivering a silently-shortened one. Kept one byte under the documented
 * ~8000-byte limit.
 */
const MAX_TOPIC_UTF8_BYTES = 7999;

const topicEncoder = new TextEncoder();

/**
 * Validate a notify topic against the constraints `pg_notify` imposes on its
 * payload: non-empty, no embedded NUL (Postgres text values cannot carry
 * one), and short enough that the server never truncates it.
 * @param topic - Application-defined topic about to be notified.
 * @throws Error when the topic is empty, contains a NUL byte, or its UTF-8
 *   encoding exceeds {@link MAX_TOPIC_UTF8_BYTES}.
 */
function validateNotifyTopic(topic: string): void {
  if (topic.length === 0) {
    throw new Error('createPostgresDatabaseSignals: a notify topic must be a non-empty string.');
  }
  if (topic.includes('\u0000')) {
    throw new Error('createPostgresDatabaseSignals: a notify topic must not contain a NUL byte.');
  }
  const byteLength = topicEncoder.encode(topic).length;
  if (byteLength > MAX_TOPIC_UTF8_BYTES) {
    throw new Error(
      `createPostgresDatabaseSignals: a notify topic's UTF-8 encoding must be at most ${MAX_TOPIC_UTF8_BYTES} bytes ` +
        `(got ${byteLength} bytes). Postgres truncates an oversized NOTIFY payload silently, so this capability ` +
        'rejects it instead of delivering a truncated topic.',
    );
  }
}

/**
 * Connection configuration {@link createPostgresDatabaseSignals} needs to
 * open its dedicated listener connection.
 */
export interface PostgresDatabaseSignalsOptions {
  /**
   * Connection string for the dedicated listener connection — the same
   * configuration the writing pool was created from, so the listener
   * authenticates against the same database and role.
   */
  connectionString: string;
  /**
   * Constructs the dedicated, listener-only connection. Injected rather than
   * imported directly so this module stays independent of how the caller
   * loaded the `pg` driver module.
   * @param config - Connection configuration for the new client.
   * @returns A not-yet-connected listener-only client.
   */
  createClient: (config: { connectionString: string }) => PostgresSignalClientLike;
}

/** Initial reconnect delay; doubled per attempt up to {@link MAX_RECONNECT_DELAY_MS}. */
const BASE_RECONNECT_DELAY_MS = 250;

/** Upper bound on the reconnect backoff delay. */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Caps the exponent so the backoff computation never overflows. */
const MAX_BACKOFF_EXPONENT = 10;

/** Rejection reason used by every pending or future `ready()`/`subscribe()` call once `close()` was called. */
const CLOSED_REASON = 'createPostgresDatabaseSignals: ready() rejects because close() was called.';

/** One connection owned from creation until its release has fully settled. */
interface OwnedConnection {
  /** The underlying dedicated listener connection. */
  readonly client: PostgresSignalClientLike;
  /**
   * End the connection and only then detach this module's handlers from it.
   * Memoized: every call returns the same promise, awaiting the one
   * in-flight or already-settled release.
   */
  release(): Promise<void>;
}

/** One pending `ready()` call, resolved or rejected without being owned past that single call. */
interface Waiter {
  /** Resolves the caller's promise once `LISTEN` is confirmed. */
  resolve: () => void;
  /** Rejects the caller's promise, e.g. once `close()` is called. */
  reject: (reason: Error) => void;
}

/**
 * Lifecycle state of one capability instance: its connection configuration,
 * direct subscribers, and the mutable state the module-level functions below
 * read and write. Bundling everything behind one object means every
 * lifecycle function below takes exactly this one parameter instead of
 * threading options and callbacks through separately.
 */
interface ListenerState {
  /** Connection configuration and client constructor for the dedicated connection. */
  readonly options: PostgresDatabaseSignalsOptions;
  /** Direct subscribers of this capability. */
  readonly subscribers: RegistrationSet<(event: DatabaseSignal) => void>;
  /** Set once `close()` has been called; permanent. */
  closed: boolean;
  /** Whether {@link ListenerState.current} has a confirmed `LISTEN`. */
  listening: boolean;
  /** Whether any connection attempt of this capability has ever confirmed `LISTEN`. */
  everListened: boolean;
  /** The connection currently owned — in flight or confirmed listening — if any. */
  current: OwnedConnection | undefined;
  /** Releases of connections that concluded outside `close()`, until each settles. */
  readonly releasing: Set<Promise<void>>;
  /** Pending `ready()` calls, waiting for the next confirmed `LISTEN` or for `close()`. */
  readonly waiters: Set<Waiter>;
  /** Pending retry timer, while waiting out backoff between attempts. */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Number of consecutive failed attempts since the last confirmed `LISTEN`. */
  retryAttempt: number;
  /** Memoized result of `close()`, once called. */
  closePromise: Promise<void> | undefined;
}

/**
 * Create a fresh, not-yet-connecting lifecycle state.
 * @param options - Connection configuration and client constructor.
 * @returns A new {@link ListenerState}.
 */
function createListenerState(options: PostgresDatabaseSignalsOptions): ListenerState {
  return {
    options,
    subscribers: createRegistrationSet(),
    closed: false,
    listening: false,
    everListened: false,
    current: undefined,
    releasing: new Set(),
    waiters: new Set(),
    retryTimer: undefined,
    retryAttempt: 0,
    closePromise: undefined,
  };
}

/**
 * Deliver a notification on the dedicated connection to every direct
 * subscriber. Notifications on any channel but the fixed wake channel are
 * ignored — the connection never issues `LISTEN` for anything else, but a
 * defensive channel check keeps that invariant explicit.
 * @param state - Lifecycle state whose subscribers to deliver to.
 * @param notification - The delivered notification.
 */
function deliverNotification(state: ListenerState, notification: PostgresNotificationLike): void {
  if (notification.channel !== POSTGRES_WAKE_CHANNEL) return;
  invokeListenersSafely(
    state.subscribers.snapshot(),
    { kind: 'topic', topic: notification.payload ?? '' },
    'database signal topic',
  );
}

/**
 * Deliver a `resynced` event to every direct subscriber, isolating each from
 * the others.
 * @param state - Lifecycle state whose subscribers to deliver to.
 */
function deliverResynced(state: ListenerState): void {
  invokeListenersSafely(state.subscribers.snapshot(), { kind: 'resynced' }, 'database signal resynced');
}

/**
 * Open one dedicated connection and confirm `LISTEN`. The first `'error'`,
 * `'end'`, or failed `connect()`/`LISTEN` of this connection concludes it
 * exactly once: ownership is cleared, its release is tracked until settled,
 * and — unless closed — the next attempt is scheduled with backoff. A
 * success resolves every pending waiter, resets the backoff, and emits
 * `resynced` once this is not the capability's first confirmed `LISTEN`.
 * @param state - Lifecycle state this attempt belongs to.
 */
async function attemptConnection(state: ListenerState): Promise<void> {
  const client = state.options.createClient({ connectionString: state.options.connectionString });
  let concluded = false;
  let releasePromise: Promise<void> | undefined;

  const isCurrent = (): boolean => state.current?.client === client;

  /**
   * End `client`, then detach this attempt's handlers from it. Memoized:
   * every call returns the same promise.
   * @returns Promise that resolves once `client` has fully ended and its
   *   handlers are detached.
   */
  function release(): Promise<void> {
    releasePromise ??= (async () => {
      await client.end().catch(() => undefined);
      client.off('notification', onNotification);
      client.off('error', onError);
      client.off('end', onEnd);
    })();
    return releasePromise;
  }

  /**
   * Conclude this attempt exactly once: release ownership, track the release
   * until settled, and schedule a retry unless the capability is closed.
   * @param error - The triggering failure, or `undefined` for a bare `'end'` event.
   */
  function conclude(error: Error | undefined): void {
    if (concluded) return;
    concluded = true;
    if (isCurrent()) {
      state.current = undefined;
      state.listening = false;
    }
    const pending = release();
    state.releasing.add(pending);
    void pending.finally(() => state.releasing.delete(pending));
    if (error !== undefined) {
      console.error(
        '[makaio:storage-pg] database signal listener connection failed; reconnecting with backoff.',
        error,
      );
    }
    if (!state.closed) scheduleRetry(state);
  }

  /**
   * `'notification'` handler: delivers only while `client` is still current.
   * @param notification - The delivered notification.
   */
  function onNotification(notification: PostgresNotificationLike): void {
    if (isCurrent()) deliverNotification(state, notification);
  }
  /**
   * `'error'` handler. Required: node-postgres escalates an unlistened
   * `'error'` on a `Client` to an uncaught exception.
   * @param error - The connection failure.
   */
  function onError(error: Error): void {
    conclude(error);
  }
  /** `'end'` handler: the connection closed, whether via {@link release} or an upstream failure. */
  function onEnd(): void {
    conclude(undefined);
  }

  client.on('notification', onNotification);
  client.on('error', onError);
  client.on('end', onEnd);
  state.current = { client, release };

  try {
    await client.connect();
    await client.query(`LISTEN ${POSTGRES_WAKE_CHANNEL}`);
  } catch (error) {
    console.error('[makaio:storage-pg] database signal listener failed to connect or LISTEN; retrying.', error);
    conclude(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  // A connect()/LISTEN rejection can race the 'error'/'end' events this
  // attempt's handlers are subscribed to, and close() can run concurrently
  // with a successful round trip; conclude()'s own guard keeps "exactly one
  // conclusion per attempt" true regardless of which observes it first, and
  // folds a close-raced success into the normal release path instead of
  // leaving it unmanaged.
  if (concluded || state.closed) {
    conclude(undefined);
    return;
  }

  state.listening = true;
  state.retryAttempt = 0;
  for (const waiter of state.waiters) waiter.resolve();
  state.waiters.clear();
  if (state.everListened) deliverResynced(state);
  state.everListened = true;
}

/**
 * Start a connection attempt unless one is already owned or a retry is
 * already scheduled. The only entry point into {@link attemptConnection}, so
 * "at most one current connection" and "no connection before the first
 * `subscribe()`/`ready()`" both hold by construction; also the landing spot a
 * retry timer calls back into.
 * @param state - Lifecycle state to start connecting.
 */
function ensureConnectionAttempt(state: ListenerState): void {
  if (state.closed || state.current !== undefined || state.retryTimer !== undefined) return;
  void attemptConnection(state).catch((error: unknown) => {
    console.error('[makaio:storage-pg] database signal listener attempt failed unexpectedly.', error);
  });
}

/**
 * Schedule the single next connection attempt after a failure, with a delay
 * that doubles per attempt up to {@link MAX_RECONNECT_DELAY_MS}. A no-op
 * while a retry is already scheduled.
 * @param state - Lifecycle state to schedule the retry on.
 */
function scheduleRetry(state: ListenerState): void {
  if (state.retryTimer !== undefined) return;
  const exponent = Math.min(state.retryAttempt, MAX_BACKOFF_EXPONENT);
  state.retryAttempt += 1;
  const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** exponent, MAX_RECONNECT_DELAY_MS);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined;
    ensureConnectionAttempt(state);
  }, delay);
}

/**
 * Resolve once the dedicated connection confirms `LISTEN`.
 * @param state - Lifecycle state to read and wait on.
 * @returns A promise owned solely by the caller: rejected immediately once
 *   closed, resolved immediately once already listening, otherwise a fresh
 *   promise resolved or rejected once {@link attemptConnection} or
 *   {@link closeListener} settles it.
 */
function ready(state: ListenerState): Promise<void> {
  if (state.closed) return Promise.reject(new Error(CLOSED_REASON));
  if (state.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    state.waiters.add({ resolve, reject });
    ensureConnectionAttempt(state);
  });
}

/**
 * Tear down a lifecycle: mark it closed, cancel a pending retry, reject and
 * clear every waiting `ready()` call, clear the subscriber set, and release
 * every owned connection — the current one and any still settling from an
 * earlier failure — before resolving. Idempotent and memoized.
 * @param state - Lifecycle state to close.
 * @returns The memoized close promise, resolved once every owned connection
 *   has fully ended.
 */
function closeListener(state: ListenerState): Promise<void> {
  if (state.closePromise !== undefined) return state.closePromise;
  state.closed = true;
  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }
  const closedError = new Error(CLOSED_REASON);
  for (const waiter of state.waiters) waiter.reject(closedError);
  state.waiters.clear();
  state.subscribers.clear();
  state.closePromise = (async () => {
    const pending = [...state.releasing];
    const current = state.current;
    state.current = undefined;
    if (current !== undefined) pending.push(current.release());
    await Promise.all(pending);
  })();
  return state.closePromise;
}

/**
 * Create the Postgres `database-notify` signal capability for one database
 * client.
 *
 * Owns exactly one dedicated `pg.Client`, outside the writing pool, opened
 * lazily on the first {@link PostgresDatabaseSignals.subscribe} or
 * {@link PostgresDatabaseSignals.ready} call. Once a reconnect re-confirms
 * `LISTEN`, subscribers receive a `{ kind: 'resynced' }` event: notifications
 * are not queued while the connection is down, so a subscriber must treat
 * `resynced` as "replay what you may have missed" rather than rely on
 * buffered topics. The connection string is never logged.
 * @param options - Connection configuration and client constructor for the
 *   dedicated listener connection.
 * @returns The `database-notify` branch of `DatabaseSignals`.
 */
export function createPostgresDatabaseSignals(options: PostgresDatabaseSignalsOptions): PostgresDatabaseSignals {
  const state = createListenerState(options);

  return {
    kind: 'database-notify',
    notifyExpression(topic: string): SQL {
      validateNotifyTopic(topic);
      return sql`pg_notify(${POSTGRES_WAKE_CHANNEL}, ${topic})`;
    },
    subscribe(listener: (event: DatabaseSignal) => void): () => void {
      if (state.closed) {
        throw new Error('createPostgresDatabaseSignals: subscribe() was called after close().');
      }
      const remove = state.subscribers.add(listener);
      ensureConnectionAttempt(state);
      return remove;
    },
    ready: () => ready(state),
    close: () => closeListener(state),
  };
}
