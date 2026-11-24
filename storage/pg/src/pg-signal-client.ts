/**
 * Self-owned structural types for the dedicated `pg` listener connection and
 * the shared driver-module shape it is constructed through.
 *
 * The signal capability of a Postgres client (`pg_notify`/`LISTEN`) needs a
 * `pg.Client` outside the writing pool — a pool connection cannot stay
 * subscribed to `LISTEN` between checkouts. This module types only that
 * dedicated-connection surface plus the driver-module shape shared with the
 * pool constructor so both can be built from one place. It intentionally
 * declares no runtime behavior: constructing or wiring the listener
 * connection is the capability implementation's job.
 *
 * Self-owned so the published declaration file never references
 * `import('pg')`, mirroring `PostgresPoolLike` in `raw-sql.ts`. Shapes
 * verified against `pg`'s `Client` implementation (`node_modules/pg/lib/client.js`)
 * and the wire message it re-emits (`node_modules/pg-protocol/dist/messages.d.ts`).
 * @packageDocumentation
 */
import type { PostgresPoolLike } from './raw-sql.js';

/**
 * A `NOTIFY` delivered to a `pg.Client` subscribed via `LISTEN`.
 *
 * Mirrors `NotificationResponseMessage` in
 * `pg-protocol/dist/messages.d.ts`: `processId` identifies the notifying
 * backend, `channel` is the notified channel name, and `payload` is the
 * notification payload. Declared optional here because this structural type
 * also describes what a listener callback may be handed; the wire message
 * itself always carries a `payload` string (empty when `NOTIFY` supplied
 * none).
 */
export interface PostgresNotificationLike {
  /** Backend process ID of the connection that issued `NOTIFY`. */
  processId: number;
  /** Channel name the notification was sent on. */
  channel: string;
  /** Notification payload, or absent/empty when `NOTIFY` supplied none. */
  payload?: string;
}

/**
 * Structural surface of a dedicated `pg.Client` used only for `LISTEN` —
 * never for query execution outside listener setup. Self-owned so the
 * published declaration file never references `import('pg')`.
 */
export interface PostgresSignalClientLike {
  /**
   * Open the connection. Resolves once the connection handshake completes;
   * rejects on connection failure.
   */
  connect(): Promise<void>;

  /**
   * Execute a statement on this connection — used to issue `LISTEN <channel>`
   * once connected. `LISTEN` takes no bind parameters (the channel is a
   * literal in the statement text, not a placeholder), so `params` is
   * optional here, unlike the mandatory parameter list on
   * `PostgresQueryableLike.query` in `raw-sql.ts`.
   * @param text - SQL text to execute.
   * @param params - Positional parameter values, when the statement has any.
   */
  query(text: string, params?: unknown[]): Promise<unknown>;

  /**
   * Close the connection. Resolves once the connection has fully closed.
   */
  end(): Promise<void>;

  /**
   * Subscribe to an event on this connection.
   * - `'notification'` — a `NOTIFY` delivered on a channel this connection is
   *   listening on.
   * - `'error'` — the connection failed (e.g. backend restart, network
   *   partition). Required listener: node-postgres escalates an unlistened
   *   `'error'` on a `Client` to an uncaught exception.
   * - `'end'` — the connection closed, whether via `end()` or a failure.
   * @param event - Event name to subscribe to.
   * @param listener - Listener invoked with the event's payload, if any.
   */
  on(event: 'notification', listener: (notification: PostgresNotificationLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;

  /**
   * Unsubscribe a listener previously registered with {@link on}.
   * @param event - Event name the listener was registered for.
   * @param listener - The exact listener function to remove.
   */
  off(event: 'notification', listener: (notification: PostgresNotificationLike) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'end', listener: () => void): void;
}

/**
 * Structural surface of the `pg` module's CJS default export, covering both
 * driver entry points this package constructs: the writing pool
 * (`PostgresPoolLike`, used by `client.ts`) and the dedicated listener
 * connection (`PostgresSignalClientLike`, used by the signal capability).
 *
 * Replaces the pool-only constructor shape previously duplicated between
 * `client.ts`'s local `PgModule` interface and the ambient `pg` module
 * declaration in `pg-module.d.ts` — both import this type instead of
 * restating the constructor shapes.
 */
export interface PostgresDriverModule {
  /** node-postgres connection pool constructor. */
  Pool: new (config: {
    connectionString: string;
    max: number;
  }) => PostgresPoolLike;
  /** node-postgres dedicated single-connection client constructor. */
  Client: new (config: {
    connectionString: string;
  }) => PostgresSignalClientLike;
}
