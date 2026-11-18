/**
 * Per-handle serialization of SQLite statements and transactions.
 *
 * SQLite admits one writer, and both SQLite drivers execute synchronously, so
 * an unserialized statement that meets an open transaction either runs inside
 * it (a single `bun:sqlite` connection) or hits the write lock and freezes the
 * event loop until the busy timeout expires (`@libsql/client`, which opens a
 * second connection for it). One {@link HandleGate} per handle removes both:
 * every driver adapter routes its statements through it.
 *
 * The invariant it enforces, on every runtime and driver:
 *
 * 1. While a transaction (or a raw `BEGIN` session) is open on a handle,
 *    statements issued outside its callback wait until it committed or rolled
 *    back. They neither join it nor observe its uncommitted writes.
 * 2. Statements issued from inside the callback — through the transaction
 *    context, or through the handle from the callback's async context — are
 *    never held back.
 * 3. Transactions and sessions on one handle run one at a time.
 *
 * Constraint: a callback holding the gate contains database work only. It must
 * not await work started outside it that uses the same handle (bus requests,
 * other queued operations): that work waits for the gate, the gate waits for
 * the callback.
 *
 * The constraint is enforced where it can be seen: exclusive access requested
 * from inside the async context of the holder (a transaction or session opened
 * from within a callback, which would wait for the very callback that asks) is
 * rejected with a {@link ReentrantOperationError} instead of waiting. Ordinary
 * statements from that context stay allowed, they are what the callback is
 * for. A cycle through promises started elsewhere is not visible to the gate
 * and stays a documented constraint.
 * @packageDocumentation
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReentrantOperationError } from '../../reentrant-operation-error';

/** The transaction or session currently holding a handle. */
interface Holder {
  /** Resolves once the holder committed or rolled back. */
  readonly settled: Promise<void>;
}

/**
 * Keeps statements issued from outside an open transaction off the handle
 * until that transaction settled.
 *
 * A statement belongs to the open transaction when it is issued from the
 * async context of its callback; the context propagates across `await`,
 * timers, and any work the callback starts. Every other statement waits.
 */
export class HandleGate {
  readonly #scope = new AsyncLocalStorage<Holder>();
  #holder: Holder | undefined;

  /**
   * Execute a statement now when the handle is free for the caller, otherwise
   * once the holder settled.
   *
   * The check and the execution happen in one synchronous step, so no
   * transaction can open in between, and a statement on a free handle keeps
   * its synchronous result.
   *
   * The gate is occupied for that synchronous step only, not until the
   * statement's promise settles, and that is sufficient because both local
   * drivers finish all native work before `statement()` returns: libsql's
   * `execute`, `batch`, `migrate` and `executeMultiple` are `async` only to
   * deliver their result, they contain no `await`, and `bun:sqlite` is
   * synchronous. A statement that was started therefore cannot be overlapped by
   * a transaction, a raw session or a close that runs right after it. The
   * handle-close and handle-serialization suites pin this on both drivers
   * (a statement queued before a close is committed before the connection
   * closes). A driver whose statements kept working after they returned would
   * need in-flight tracking here.
   * @param statement - Statement execution; its result (or promise) is passed through.
   * @returns The statement's result, or a promise of it when it had to wait.
   * @typeParam T - Statement result type.
   */
  public run<T>(statement: () => T): T | Promise<T> {
    const holder = this.#holder;
    if (holder === undefined || this.#scope.getStore() === holder) return statement();
    return holder.settled.then(() => this.run(statement));
  }

  /**
   * Whether the calling async context belongs to the transaction or session
   * that currently holds the handle.
   *
   * A context that outlived its holder (a timer started inside a callback that
   * has since settled) does not belong to the next holder, so it is not held.
   * @returns `true` while the caller runs inside the current holder's work.
   */
  public heldByCaller(): boolean {
    const holder = this.#holder;
    return holder !== undefined && this.#scope.getStore() === holder;
  }

  /**
   * Hold the handle for one transaction or session, once nothing else holds it.
   * @param work - Opens, runs, and closes the transaction; statements it
   *   issues from its async context run immediately.
   * @returns Whatever `work` resolves to.
   * @throws ReentrantOperationError when the caller already holds the handle:
   *   waiting for its own release would never end.
   * @typeParam T - Result type of the work.
   */
  public async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.heldByCaller()) throw ReentrantOperationError.forHandle();
    return this.run(() => this.#hold(work));
  }

  /**
   * Mark the handle as held while `work` runs in its own async context.
   * @param work - Opens, runs, and closes the transaction.
   * @returns Whatever `work` resolves to.
   * @typeParam T - Result type of the work.
   */
  async #hold<T>(work: () => Promise<T>): Promise<T> {
    // `run` only lets this through on a free handle: a caller that is itself
    // inside the current holder was rejected in `exclusive`.
    const settled = Promise.withResolvers<void>();
    const holder: Holder = { settled: settled.promise };
    this.#holder = holder;
    try {
      return await this.#scope.run(holder, work);
    } finally {
      this.#holder = undefined;
      settled.resolve();
    }
  }
}
