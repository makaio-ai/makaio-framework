import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import {
  prepareProviderContextActivation,
  ProviderContextActivationError,
  ProviderContextActivationRollbackError,
  type ProviderContextActivationTransaction,
} from '@makaio/services-core/provider-context';

/** Prepared account activation owned by one adapter runtime startup. */
export interface ProviderContextActivationLifecycle {
  /** Reversible account-manager transaction, absent for side-effect-free auth modes. */
  readonly transaction?: ProviderContextActivationTransaction;
  /** Whether the transaction has received its terminal commit decision. */
  terminal: boolean;
}

/** Failure cleanup inputs for one prepared adapter startup. */
export interface ProviderContextActivationFailureOptions {
  /** Prepared activation whose lock must be released. */
  readonly activation: ProviderContextActivationLifecycle;
  /** Failure that prevented startup from completing. */
  readonly primaryError: unknown;
  /** Runtime cleanup that must finish before native account rollback. */
  readonly cleanup?: () => Promise<void>;
  /** Credential-free operation label used in diagnostics. */
  readonly operation: string;
  /** Existing aggregate message preserved for auth modes without activation. */
  readonly cleanupFailureMessage: string;
}

/**
 * Prepare the selected provider account before connector auth materialization.
 * @param bus - Global bus carrying local account-manager transaction RPCs
 * @param providerContext - Canonical provider selection for the new runtime
 * @returns Activation lifecycle that must be committed or rolled back
 */
export async function prepareAdapterProviderContextActivation(
  bus: IMakaioBus,
  providerContext: ProviderContext,
): Promise<ProviderContextActivationLifecycle> {
  const transaction = await prepareProviderContextActivation(bus, providerContext);
  return {
    ...(transaction !== undefined && { transaction }),
    terminal: transaction === undefined,
  };
}

/**
 * Commit a prepared account only after its connector reports readiness.
 * @param activation - Prepared activation paired with the ready connector
 * @returns Promise that settles after account metadata is committed
 */
export async function commitAdapterProviderContextActivation(
  activation: ProviderContextActivationLifecycle,
): Promise<void> {
  if (activation.transaction === undefined) return;
  try {
    await activation.transaction.commit();
  } finally {
    // Commit is a terminal action even when the manager reports that its own
    // commit rollback failed; attempting a second terminal action is invalid.
    activation.terminal = true;
  }
}

/**
 * Close partial runtime state, then restore the previous native account.
 *
 * Cleanup intentionally precedes rollback: the connector and its auth lease
 * were created against the prepared native state and must relinquish it while
 * the account manager still owns the per-client mutation lock.
 * @param options - Activation, triggering failure, cleanup, and diagnostics
 * @returns Never; rethrows the primary failure or a rollback aggregate
 */
export async function rollbackAdapterProviderContextActivationAfterFailure(
  options: ProviderContextActivationFailureOptions,
): Promise<never> {
  let cleanupError: unknown;
  try {
    await options.cleanup?.();
  } catch (error) {
    cleanupError = error;
  }

  let rollbackError: unknown;
  if (options.activation.transaction !== undefined && !options.activation.terminal) {
    try {
      await options.activation.transaction.rollback();
    } catch (error) {
      rollbackError = error;
    } finally {
      options.activation.terminal = true;
    }
  }

  if (cleanupError !== undefined || rollbackError !== undefined) {
    const errors: Error[] = [sanitizeActivationLifecycleError(options.primaryError, options.operation)];
    if (cleanupError !== undefined) {
      errors.push(new Error(`${options.operation} runtime cleanup failed.`));
    }
    if (rollbackError !== undefined) {
      errors.push(sanitizeActivationRollbackError(rollbackError));
    }
    throw new AggregateError(
      errors,
      options.activation.transaction === undefined
        ? options.cleanupFailureMessage
        : `${options.operation} failed and provider account activation rollback was incomplete.`,
    );
  }

  if (options.primaryError instanceof ProviderContextActivationRollbackError) {
    throw new AggregateError(
      [new Error(`${options.operation} account activation commit failed.`), options.primaryError],
      `${options.operation} account activation commit and rollback both failed.`,
    );
  }
  if (options.primaryError instanceof AggregateError) {
    throw new AggregateError(
      [
        sanitizeActivationLifecycleError(options.primaryError, options.operation),
        new Error(`${options.operation} runtime rollback failed.`),
      ],
      `${options.operation} connector startup and runtime rollback both failed.`,
    );
  }
  throw options.primaryError;
}

/**
 * Replace a potentially credential-bearing startup error in rollback aggregates.
 * @param error - Original connector or activation failure
 * @param operation - Credential-free operation label
 * @returns Safe aggregate member
 */
function sanitizeActivationLifecycleError(error: unknown, operation: string): Error {
  if (error instanceof ProviderContextActivationError || error instanceof ProviderContextActivationRollbackError) {
    return new Error(`${operation} account activation failed.`);
  }
  return new Error(`${operation} connector startup failed.`);
}

/**
 * Normalize account-manager rollback failures to credential-free aggregate members.
 * @param error - Error raised by the opaque rollback transaction
 * @returns Safe aggregate member
 */
function sanitizeActivationRollbackError(error: unknown): Error {
  if (error instanceof ProviderContextActivationError || error instanceof ProviderContextActivationRollbackError) {
    return error;
  }
  return new ProviderContextActivationRollbackError();
}
