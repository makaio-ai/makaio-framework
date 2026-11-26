declare const hostTransactionBrand: unique symbol;

/**
 * An open transaction of the host's database.
 *
 * The type is opaque: only the owner of the storage creates one and binds it
 * to its driver. Every other package receives it and passes it on unchanged.
 * Code that receives a transaction neither opens nor closes it. The same
 * contract holds for every dialect the storage owner supports.
 */
export interface HostTransaction {
  /** Opaque brand preventing structural construction. */
  readonly [hostTransactionBrand]: true;
}

/**
 * The database seam of the host.
 *
 * It represents one connection whose transactions the core and every
 * extension with a storage contribution share.
 */
export interface HostDatabase {
  /**
   * Opens a transaction on the connection in which the host writes its own
   * state, runs `fn` with it, commits when `fn` fulfils and rolls back when
   * `fn` rejects.
   *
   * Work inside `fn` must be database work only: do not issue a bus request
   * from within a transaction.
   *
   * Transactions do not nest: calling `transaction` from inside `fn` (or from
   * work it awaits) is rejected; transactions started elsewhere wait until the
   * open one settled. Code that runs inside `fn` (for example a reader's commit
   * or a write participant) uses the transaction it was given.
   * @typeParam T - Value the callback resolves with.
   * @param fn - Callback that performs the database work using the open transaction.
   * @param options - Optional caller lifetime. An abort skips work still in the
   * host queue and rolls back active work before commit. Once storage hands off
   * to commit, the commit runs to completion.
   * @returns The value `fn` resolved with, after the transaction committed.
   */
  transaction<T>(fn: (tx: HostTransaction) => Promise<T>, options?: { readonly signal?: AbortSignal }): Promise<T>;
}
