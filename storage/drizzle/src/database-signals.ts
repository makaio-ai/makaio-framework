/**
 * Database signal capability: the per-client contract for waking readers in
 * OTHER processes when a writer commits.
 *
 * The trigger for waking a reader is always the committed row. Inside the
 * committing process, readers are woken directly after the commit — that path
 * does not need this capability. Between processes, waking depends on
 * whether the underlying database can notify other connections at all; that
 * is a capability of the database client, not of the storage engine, because
 * the same SQLite engine serves file, in-memory, and remote targets with
 * different capabilities. This module declares that capability's shape and
 * the handle binding that carries it; nothing here creates connections or
 * decides which branch a given client declares — see {@link DatabaseClient}.
 * @packageDocumentation
 */
import type { SQL } from 'drizzle-orm';
import type { MakaioDatabase } from './types';

/**
 * One wake event delivered to a {@link DatabaseSignals} `database-notify`
 * subscriber.
 */
export type DatabaseSignal =
  | {
      /** A committed transaction notified `topic`. */
      kind: 'topic';
      /** Application-defined topic that was notified. */
      topic: string;
    }
  | {
      /**
       * The signal connection was (re-)established after having been down.
       * Notifications are not queued while the connection is down, so a
       * subscriber that previously received signals must treat this event as
       * "replay what you may have missed" rather than rely on buffered
       * topics.
       */
      kind: 'resynced';
    };

/**
 * Signal capability declared by a database client: whether the database can
 * wake readers in other processes when a writer commits, and how.
 *
 * Declared per client (see `DatabaseClient.signals`), not per storage engine,
 * because one engine registration (e.g. the built-in SQLite engine) can
 * produce clients with different capabilities depending on the resolved
 * target (local file, remote, or in-memory).
 */
export type DatabaseSignals =
  | {
      /** No cross-process signal is available for this client. */
      kind: 'none';
      /**
       * Why this client cannot signal other processes at commit time:
       * - `'sqlite-file'` — a local SQLite file (via `bun:sqlite` or a local
       *   libsql connection) has no notification channel between separate
       *   processes that opened the same file. This is a named limit of the
       *   contract, never worked around with a per-file channel or polling.
       * - `'remote-libsql'` — a remote libsql/Turso target has no push
       *   notification protocol over its wire protocol. Same named limit as
       *   `'sqlite-file'`, for a different reason.
       * - `'in-memory'` — the database is process-local by construction, so
       *   no other process could ever observe a commit on it. Cross-process
       *   signaling is not a missing capability here; it is not applicable.
       */
      reason: 'sqlite-file' | 'remote-libsql' | 'in-memory';
    }
  | {
      /** The database itself can notify other connections at commit time. */
      kind: 'database-notify';
      /**
       * Build the SQL expression that, when executed inside the committing
       * transaction, notifies `topic` to every subscribed listener. Delivery
       * to other processes happens only once that transaction commits, never
       * on rollback.
       * @param topic - Application-defined topic to notify.
       * @returns SQL expression to execute inside the writing transaction.
       */
      notifyExpression(topic: string): SQL;
      /**
       * Subscribe to signals delivered to this client's listener connection.
       * @param listener - Invoked once per delivered {@link DatabaseSignal}.
       * @returns Unsubscribe function. Idempotent.
       */
      subscribe(listener: (event: DatabaseSignal) => void): () => void;
      /**
       * Subscribe to detected loss of an established signal connection. This
       * registration does not start the connection or report its initial state.
       * @param listener - Invoked when the established connection is lost.
       * @returns Unsubscribe function. Idempotent.
       */
      onDisconnect?(listener: () => void): () => void;
      /**
       * Resolves once the listener connection is established and able to
       * receive signals. Callers must register their subscription before
       * awaiting this so a signal delivered right after readiness is never
       * missed between subscribing and becoming ready.
       * @returns Promise that resolves once listening has started.
       */
      ready(): Promise<void>;
      /**
       * Tear down the listener connection. Called once, by the owning
       * client's `close()`.
       * @returns Promise that resolves once the connection is closed.
       */
      close(): Promise<void>;
    };

/**
 * Brand key under which `createDatabaseClient` binds the signal capability to
 * a handle. Declared via `Symbol.for` so the binding survives duplicated
 * module instances (a bundled dist copy and a workspace copy of this package
 * resolve the same symbol through the global symbol registry).
 */
const DATABASE_SIGNALS: unique symbol = Symbol.for('makaio.storage.databaseSignals');

/**
 * Internal view of a database handle that may carry a bound signal
 * capability. The symbol is intentionally absent from the public
 * `MakaioDatabase` type — consumers resolve it through
 * {@link getDatabaseSignals}.
 */
interface DatabaseSignalsCarrier {
  readonly [DATABASE_SIGNALS]?: DatabaseSignals;
}

/**
 * Bind a client's signal capability to its drizzle database instance.
 *
 * Modeled on the raw SQL executor's handle binding (`brandDatabase` /
 * `getRawSqlExecutor` in `raw-sql.ts`): non-enumerable so the binding never
 * leaks through spreads or property enumeration, and
 * non-writable/non-configurable so a handle's declared capability cannot
 * change after creation (re-binding throws).
 * @param db - Drizzle database instance to bind.
 * @param signals - Signal capability of the client that created `db`.
 * @returns The same instance, bound.
 */
export function bindDatabaseSignals<TDb extends object>(db: TDb, signals: DatabaseSignals): TDb {
  Object.defineProperty(db, DATABASE_SIGNALS, {
    value: signals,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return db;
}

/**
 * Resolve the signal capability bound to a database handle.
 * @param db - Database handle to resolve the capability for.
 * @returns The handle's bound signal capability.
 * @throws Error when the handle carries no signal binding. A missing binding
 *   is never treated as `{ kind: 'none' }` — every handle created by
 *   `createDatabaseClient` binds a capability, so a missing binding means the
 *   handle was not created through it.
 */
export function getDatabaseSignals(db: MakaioDatabase): DatabaseSignals {
  const bound = (db as DatabaseSignalsCarrier)[DATABASE_SIGNALS];
  if (bound !== undefined) {
    return bound;
  }
  throw new Error(
    'getDatabaseSignals: database handle carries no signal capability binding. ' +
      'Create handles with createDatabaseClient() from @makaio/storage-drizzle/client, which binds the capability.',
  );
}
