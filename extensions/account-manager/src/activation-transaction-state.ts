import type { CallContext } from '@makaio/core';

/** Terminal action for a prepared account activation. */
export type ActivationTransactionDecision = 'commit' | 'rollback';

/** Terminal decision together with the call of the request that finalizes the activation. */
export interface ActivationTransactionFinalization {
  /** Claimed terminal action. */
  readonly action: ActivationTransactionDecision;
  /** Call of the finalizing request, used for the storage and timeline writes of that step. */
  readonly call: CallContext;
}

/** Stable result of committing a prepared activation. */
export type ActivationCommitResult =
  | { success: true }
  | { success: false; code: 'transaction-not-found' | 'commit-failed' | 'commit-rollback-failed' };

/** Stable result of rolling back a prepared activation. */
export type ActivationRollbackResult =
  | { success: true }
  | { success: false; code: 'transaction-not-found' | 'rollback-failed' };

/** Result shared by lifecycle code that may await either terminal action. */
export type ActivationFinalizationResult = ActivationCommitResult | ActivationRollbackResult;

/** Single-settlement deferred used while an activation owns the client lock. */
export interface DeferredValue<T> {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
  readonly resolve: (value: T) => void;
}

/** Prepared activation state retained until one terminal decision. */
export interface PendingActivationTransaction {
  readonly decision: DeferredValue<ActivationTransactionFinalization>;
  readonly completion: Promise<void>;
  /** Claimed terminal action retained until its completion settles. */
  finalization?: {
    readonly action: ActivationTransactionDecision;
    readonly result: Promise<ActivationFinalizationResult>;
  };
}

/**
 * Create a single-settlement deferred used only inside the activation lock.
 * @returns Deferred value with idempotent settlement.
 */
export function createDeferredValue<T>(): DeferredValue<T> {
  let settled = false;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    settled: () => settled,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolvePromise?.(value);
    },
  };
}
