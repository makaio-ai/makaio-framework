import { randomUUID } from 'node:crypto';
import { AccountActivationFinalizationError, type PreparedAccountActivation } from './account-activation.js';
import { AccountManagerQuiesceError } from './account-manager-types.js';
import {
  createDeferredValue,
  type ActivationCommitResult,
  type ActivationFinalizationResult,
  type ActivationRollbackResult,
  type ActivationTransactionDecision,
  type PendingActivationTransaction,
} from './activation-transaction-state.js';
import type { ClientMutationQueue } from './client-mutation-queue.js';

/** Stable result returned while preparing one activation transaction. */
export type ActivationPrepareResult =
  | { readonly success: true; readonly transactionId: string }
  | { readonly success: false; readonly code: 'account-not-found' | 'activation-failed' };

/** Dependencies required by the activation transaction lifecycle owner. */
export interface AccountActivationTransactionsOptions {
  /** Per-client mutation queue retained through terminal activation work. */
  readonly clientMutations: ClientMutationQueue;
  /**
   * Prepare one reversible native and durable account activation.
   * @param clientId - Client whose account is selected.
   * @param accountId - Exact stored account to prepare.
   * @returns Prepared activation, or `null` when the account disappeared.
   */
  readonly prepareActivation: (clientId: string, accountId: string) => Promise<PreparedAccountActivation | null>;
}

/**
 * Owns admission, terminal decisions, and shutdown of account activations.
 *
 * Every accepted preparation is tracked before entering the client mutation
 * queue. Exactly one commit or rollback may claim it, and the transaction
 * remains tracked until that terminal workflow settles.
 */
export class AccountActivationTransactions {
  private readonly transactions = new Map<string, PendingActivationTransaction>();
  private accepting = false;

  /** @param options - Transaction preparation and serialization dependencies. */
  public constructor(private readonly options: AccountActivationTransactionsOptions) {}

  /** Open prepare admission after the owning service has initialized. */
  public start(): void {
    this.accepting = true;
  }

  /**
   * Close admission, roll back unclaimed transactions, and await claimed work.
   */
  public async shutdown(): Promise<void> {
    this.accepting = false;
    const results = await Promise.allSettled(
      [...this.transactions].map(
        ([transactionId, transaction]) =>
          transaction.finalization?.result ?? this.beginFinalization(transactionId, transaction, 'rollback'),
      ),
    );
    const failures = results.flatMap((result) => {
      if (result.status === 'rejected') return [result.reason];
      return isUnsafeFinalization(result.value) ? [new Error(result.value.code)] : [];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Account activation transaction cleanup failed.');
    }
  }

  /**
   * Prepare one account selection and retain its client lock until finalization.
   * @param clientId - Client whose native account is selected.
   * @param accountId - Exact stored account to prepare.
   * @returns Opaque transaction identifier or typed credential-free failure.
   */
  public async prepare(clientId: string, accountId: string): Promise<ActivationPrepareResult> {
    if (!this.accepting) return { success: false, code: 'activation-failed' };

    const ready = createDeferredValue<ActivationPrepareResult>();
    const decision = createDeferredValue<ActivationTransactionDecision>();
    const transactionId = randomUUID();
    let published = false;
    const workflow = this.options.clientMutations.run(clientId, async () => {
      if (!this.accepting) {
        ready.resolve({ success: false, code: 'activation-failed' });
        return;
      }
      const activation = await this.options.prepareActivation(clientId, accountId);
      if (activation === null) {
        ready.resolve({ success: false, code: 'account-not-found' });
        return;
      }
      if (this.accepting) {
        published = true;
        ready.resolve({ success: true, transactionId });
      } else {
        ready.resolve({ success: false, code: 'activation-failed' });
      }
      const action = await decision.promise;
      await (action === 'commit' ? activation.commit() : activation.rollback());
    });
    const transaction: PendingActivationTransaction = { decision, completion: workflow };
    this.transactions.set(transactionId, transaction);
    void workflow
      .catch((error) => {
        if (!ready.settled()) ready.resolve({ success: false, code: 'activation-failed' });
        if (error instanceof AccountManagerQuiesceError) void error.quiesce.catch(() => undefined);
      })
      .finally(() => {
        if (
          !published &&
          transaction.finalization === undefined &&
          this.transactions.get(transactionId) === transaction
        ) {
          this.transactions.delete(transactionId);
        }
      });
    return ready.promise;
  }

  /**
   * Commit one prepared activation exactly once.
   * @param transactionId - Opaque prepare response identifier.
   * @returns Stable credential-free commit result.
   */
  public commit(transactionId: string): Promise<ActivationCommitResult> {
    const transaction = this.claim(transactionId);
    return transaction === undefined
      ? Promise.resolve({ success: false, code: 'transaction-not-found' })
      : this.beginFinalization(transactionId, transaction, 'commit');
  }

  /**
   * Roll back one prepared activation exactly once.
   * @param transactionId - Opaque prepare response identifier.
   * @returns Stable credential-free rollback result.
   */
  public rollback(transactionId: string): Promise<ActivationRollbackResult> {
    const transaction = this.claim(transactionId);
    return transaction === undefined
      ? Promise.resolve({ success: false, code: 'transaction-not-found' })
      : this.beginFinalization(transactionId, transaction, 'rollback');
  }

  /**
   * Return an unclaimed transaction without mutating its terminal state.
   * @param transactionId - Opaque transaction identifier to inspect.
   * @returns Unclaimed transaction, or `undefined` after terminal selection.
   */
  private claim(transactionId: string): PendingActivationTransaction | undefined {
    const transaction = this.transactions.get(transactionId);
    return transaction?.finalization === undefined ? transaction : undefined;
  }

  private beginFinalization(
    transactionId: string,
    transaction: PendingActivationTransaction,
    action: 'commit',
  ): Promise<ActivationCommitResult>;
  private beginFinalization(
    transactionId: string,
    transaction: PendingActivationTransaction,
    action: 'rollback',
  ): Promise<ActivationRollbackResult>;
  private beginFinalization(
    transactionId: string,
    transaction: PendingActivationTransaction,
    action: ActivationTransactionDecision,
  ): Promise<ActivationFinalizationResult> {
    const result = this.awaitFinalization(transaction, action).finally(() => {
      if (this.transactions.get(transactionId) === transaction) this.transactions.delete(transactionId);
    });
    transaction.finalization = { action, result };
    transaction.decision.resolve(action);
    return result;
  }

  /**
   * Map internal finalization failures to the credential-free bus contract.
   * @param transaction - Transaction whose workflow owns the client mutation lock.
   * @param action - Claimed terminal action.
   * @returns Stable credential-free finalization result.
   */
  private async awaitFinalization(
    transaction: PendingActivationTransaction,
    action: ActivationTransactionDecision,
  ): Promise<ActivationFinalizationResult> {
    try {
      await transaction.completion;
      return { success: true };
    } catch (error) {
      if (error instanceof AccountActivationFinalizationError) {
        if (action === 'rollback') return { success: false, code: 'rollback-failed' };
        return {
          success: false,
          code: error.code === 'commit-rollback-failed' ? 'commit-rollback-failed' : 'commit-failed',
        };
      }
      return { success: false, code: action === 'commit' ? 'commit-failed' : 'rollback-failed' };
    }
  }
}

/** Unsafe failure result that leaves activation cleanup uncertain. */
type UnsafeFinalization = {
  readonly success: false;
  readonly code: 'rollback-failed' | 'commit-rollback-failed';
};

/**
 * Narrow terminal failures that shutdown must surface.
 * @param result - Settled commit or rollback result.
 * @returns Whether native or durable cleanup remains uncertain.
 */
function isUnsafeFinalization(result: ActivationFinalizationResult): result is UnsafeFinalization {
  return !result.success && (result.code === 'rollback-failed' || result.code === 'commit-rollback-failed');
}
