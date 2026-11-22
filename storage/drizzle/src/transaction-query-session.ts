/**
 * Transaction-bound view of Drizzle's query entry points.
 *
 * Drizzle's builders keep the session of the transaction they were created
 * from and execute through it (or through the prepared query it returned) for
 * as long as they live, so guarding the four entry points alone does not
 * stop an escaped builder. The view built here binds every builder and prepared
 * query created through it to an `assertActive` check on every execution,
 * without mutating the real session of the transaction (on `bun:sqlite` that
 * session is shared with the handle).
 *
 * Preparing a query reads and writes no data on any of the three drivers
 * (bun:sqlite compiles the statement on the handle; libsql and node-postgres
 * only build local objects), so the check is not made at preparation: it is made
 * once, in the terminal methods of the prepared query it returns, which is the
 * single place every execution — however it was reached — passes through.
 * Bun's driver executors settle synchronously, so its terminal wrappers stay
 * plain functions and the check still throws synchronously there. The two
 * async drivers' (libsql, node-postgres) real terminals always return a
 * promise; declaring their wrappers `async` preserves that even when
 * `assertActive` throws, so a stale transaction surfaces as a rejection, not a
 * synchronous throw that a `.catch()` chain would miss.
 * @packageDocumentation
 */

import type { DriverTransaction } from './host-transaction';
import { HostTransactionError } from './host-transaction';

/** The query entry points of a transaction context. */
type EntryPoints = Pick<DriverTransaction, 'select' | 'insert' | 'update' | 'delete'>;

/** Terminal methods a prepared query may expose; absent ones are skipped. */
const TERMINAL_METHODS = ['run', 'all', 'get', 'values', 'execute'] as const;

/**
 * Driver executors a prepared query holds, with the methods it calls on them.
 *
 * - `stmt`: bun:sqlite statement. Its methods settle synchronously, so the
 *   terminal methods built over this shape stay plain functions.
 * - `tx`: libsql transaction. Drizzle falls back to `client` when it is absent;
 *   a prepared query that holds the `tx` field but no usable executor is
 *   rejected instead of being allowed that fallback. Its methods are
 *   asynchronous.
 * - `client`: node-postgres client (the transaction's own connection). Its
 *   methods are asynchronous.
 */
const EXECUTOR_SHAPES = [
  { field: 'stmt', methods: ['run', 'all', 'get', 'values'], async: false },
  { field: 'tx', methods: ['execute'], async: true },
  { field: 'client', methods: ['query'], async: true },
] as const;

/** One entry of {@link EXECUTOR_SHAPES}. */
type ExecutorShape = (typeof EXECUTOR_SHAPES)[number];

/** A function of unknown signature. */
type UnknownFunction = (...args: unknown[]) => unknown;

/** Drizzle session surface the guard needs: the one point every prepared query is created through. */
interface PreparingSession {
  /**
   * Create a prepared query.
   * @param args - Drizzle's preparation arguments, passed through unchanged.
   */
  prepareQuery: UnknownFunction;
}

/**
 * Whether a value is a non-null object whose fields can be read by name.
 * @param value - Value to test.
 * @returns `true` for objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a value is callable.
 * @param value - Value to test.
 * @returns `true` for functions.
 */
function isFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

/**
 * Whether a value is a session that prepares queries.
 * @param value - Value to test.
 * @returns `true` when it has a callable `prepareQuery`.
 */
function isPreparingSession(value: unknown): value is PreparingSession {
  return isRecord(value) && isFunction(value.prepareQuery);
}

/**
 * Create an object that inherits from `parent` and overrides only the given properties.
 *
 * The parent is never mutated. This is the single assertion of this module:
 * `Object.create` is typed `any`, and the result has exactly the type of its
 * parent because it inherits every member the overrides do not replace.
 * @param parent - Object to inherit from.
 * @param overrides - Property descriptors shadowing the inherited members.
 * @returns The derived object, typed as its parent.
 * @typeParam T - Type of the parent.
 */
function inherit<T extends object>(parent: T, overrides: PropertyDescriptorMap): T {
  return Object.create(parent, overrides) as T;
}

/**
 * Find the `HostTransactionError` an error wraps.
 *
 * Drizzle's pg session wraps driver errors in a `DrizzleQueryError`, which
 * would hide the revocation from the caller.
 * @param error - Thrown or rejected value.
 * @returns The `HostTransactionError` in its cause chain, or the value itself when there is none.
 */
function surfaceHostTransactionError(error: unknown): unknown {
  for (let link: unknown = error; link instanceof Error; link = link.cause) {
    if (link instanceof HostTransactionError) return link;
  }
  return error;
}

/**
 * Run a terminal method and surface a `HostTransactionError` from its failure.
 *
 * Synchronous results (bun) and promises are both handled. Lazy thenables such
 * as Drizzle's `ExecuteResultSync` are returned untouched: attaching a handler
 * to them would execute them early, and they run through the guarded methods
 * when they execute.
 * @param execute - The original method call.
 * @returns The result of the call, with failures surfaced.
 */
function runSurfacingRevocation(execute: () => unknown): unknown {
  let result: unknown;
  try {
    result = execute();
  } catch (error) {
    throw surfaceHostTransactionError(error);
  }
  if (result instanceof Promise) {
    return result.catch((error: unknown) => {
      throw surfaceHostTransactionError(error);
    });
  }
  return result;
}

/**
 * Build a delegate that exposes only the named methods of a driver object and
 * checks `assertActive` immediately before each of them reaches the driver.
 * @param target - Driver object (statement, transaction or client).
 * @param methods - Methods the prepared query calls on it.
 * @param assertActive - Throws when the transaction ended.
 * @returns The guarded delegate, or `undefined` when `target` lacks one of the methods.
 */
function delegateTo(
  target: unknown,
  methods: readonly string[],
  assertActive: () => void,
): Record<string, UnknownFunction> | undefined {
  if (!isRecord(target)) return undefined;
  const delegate: Record<string, UnknownFunction> = {};
  for (const name of methods) {
    const method = target[name];
    if (!isFunction(method)) return undefined;
    delegate[name] = (...args: unknown[]): unknown => {
      assertActive();
      return Reflect.apply(method, target, args);
    };
  }
  return delegate;
}

/**
 * Replace the driver executor a prepared query holds with a guarded delegate.
 *
 * Only the prepared-query object is changed, never the session, the
 * transaction or the client. The driver is recognized by the fields of the
 * prepared query; an unknown driver cannot give the guarantee, so it fails
 * closed.
 * @param query - Prepared query to guard.
 * @param assertActive - Throws when the transaction ended.
 * @returns The matched executor shape, so the caller can build terminal
 *   wrappers that match its synchronicity.
 * @throws A plain `Error` when the prepared query matches no known driver shape.
 */
function guardExecutor(query: Record<string, unknown>, assertActive: () => void): ExecutorShape {
  const shape = EXECUTOR_SHAPES.find(({ field }) => field in query);
  if (shape === undefined) {
    throw new Error(
      'Cannot guard prepared query: it holds none of the known driver executors ' +
        `(${EXECUTOR_SHAPES.map(({ field }) => `"${field}"`).join(', ')}), so the transaction guarantee cannot be given.`,
    );
  }
  const delegate = delegateTo(query[shape.field], shape.methods, assertActive);
  if (delegate === undefined) {
    throw new Error(
      `Cannot guard prepared query: its "${shape.field}" executor lacks ${shape.methods.join('/')}, ` +
        'so the transaction guarantee cannot be given (the driver would fall back to an unguarded connection).',
    );
  }
  query[shape.field] = delegate;
  return shape;
}

/**
 * Build the guarded terminal method that replaces a prepared query's original one.
 *
 * `isAsyncDriver` decides the shape of the wrapper, not just its body: for the
 * two async drivers (libsql, node-postgres) the wrapper itself is declared
 * `async`, so a synchronous throw from `assertActive` is delivered as a
 * rejected promise — matching the original method's own settlement, which a
 * plain wrapper would not. Bun's `stmt` executor settles synchronously, so its
 * wrapper stays plain and the check still throws synchronously there.
 * @param original - The real terminal method of the prepared query.
 * @param query - Prepared query the method is called on.
 * @param assertActive - Throws when the transaction ended.
 * @param isAsyncDriver - Whether the prepared query's driver settles asynchronously.
 * @returns The guarded replacement for `original`.
 */
function buildTerminalMethod(
  original: UnknownFunction,
  query: Record<string, unknown>,
  assertActive: () => void,
  isAsyncDriver: boolean,
): UnknownFunction {
  if (!isAsyncDriver) {
    return (...args: unknown[]): unknown => {
      assertActive();
      return runSurfacingRevocation(() => Reflect.apply(original, query, args));
    };
  }
  return async (...args: unknown[]): Promise<unknown> => {
    assertActive();
    return runSurfacingRevocation(() => Reflect.apply(original, query, args));
  };
}

/**
 * Guard a prepared query in place: its terminal methods and its driver executor.
 *
 * The executor guard covers executions that wait (the bun handle gate, a cache
 * lookup) and reach the driver only after the transaction ended. The terminal
 * methods check right before the executor is ever reached, in a wrapper shaped
 * to the driver's own synchronicity (see {@link buildTerminalMethod}).
 * @param query - Prepared query returned by the real session.
 * @param assertActive - Throws when the transaction ended.
 * @returns The same prepared query.
 * @throws A plain `Error` when the prepared query matches no known driver shape.
 */
function guardPreparedQuery(query: unknown, assertActive: () => void): unknown {
  if (!isRecord(query)) {
    throw new Error('Cannot guard prepared query: the session returned a non-object.');
  }
  const shape = guardExecutor(query, assertActive);
  for (const name of TERMINAL_METHODS) {
    const original = query[name];
    if (!isFunction(original)) continue;
    query[name] = buildTerminalMethod(original, query, assertActive, shape.async);
  }
  return query;
}

/**
 * Wrap an entry point so it checks `assertActive` first and then runs on the view.
 *
 * A `Proxy` keeps the overloads and generics of the original signature.
 * @param method - Entry point of the view.
 * @param receiver - The view the method must run on.
 * @param assertActive - Throws when the transaction ended.
 * @returns A function of the same type as `method`.
 * @typeParam TMethod - Type of the entry point.
 */
function guardEntryPoint<TMethod extends (...args: never[]) => unknown>(
  method: TMethod,
  receiver: object,
  assertActive: () => void,
): TMethod {
  return new Proxy(method, {
    apply: (target, _thisArg, args: unknown[]): unknown => {
      assertActive();
      return Reflect.apply(target, receiver, args);
    },
  });
}

/**
 * Build the query entry points of a transaction, bound to it for its lifetime.
 *
 * The builders they create execute only while `assertActive` passes: it is
 * checked at every entry point and at every execution (builder or prepared
 * query), including the access to the database driver itself. Preparing a
 * query is not checked — it reads and writes no data (bun:sqlite only compiles
 * the statement on the handle), and every execution still checks before it
 * reaches the driver, see {@link guardPreparedQuery}.
 * @param tx - Drizzle transaction context handed out by `executeTransaction`.
 * @param assertActive - Throws when the transaction ended.
 * @returns `select`, `insert`, `update` and `delete` of the guarded view.
 * @throws A plain `Error` when the transaction exposes no session that prepares queries.
 */
export function createGuardedTransactionView(tx: DriverTransaction, assertActive: () => void): EntryPoints {
  // `session` is a non-public field of Drizzle's database class (not in its type
  // declarations); reading it through an `in` check yields `unknown` for the guard below.
  const session: unknown = 'session' in tx ? tx.session : undefined;
  if (!isPreparingSession(session)) {
    throw new Error('Cannot guard transaction: it exposes no session that prepares queries.');
  }
  const prepareQuery = session.prepareQuery;
  const guardedSession = inherit(session, {
    prepareQuery: {
      value: (...args: unknown[]): unknown => {
        return guardPreparedQuery(Reflect.apply(prepareQuery, session, args), assertActive);
      },
    },
  });
  const view = inherit(tx, { session: { value: guardedSession } });
  return {
    select: guardEntryPoint(view.select, view, assertActive),
    insert: guardEntryPoint(view.insert, view, assertActive),
    update: guardEntryPoint(view.update, view, assertActive),
    delete: guardEntryPoint(view.delete, view, assertActive),
  };
}
