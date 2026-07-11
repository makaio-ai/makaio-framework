import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects, type ProviderContext, type ResolvedProviderContext } from '@makaio/contracts';

/** Stable account-selection activation failure categories. */
export type ProviderContextActivationErrorCode = 'manager-unavailable' | 'account-not-found' | 'activation-failed';

/** Typed, credential-free failure raised while activating a selected native account. */
export class ProviderContextActivationError extends Error {
  /**
   * Create an account-selection activation failure.
   * @param code - Stable failure category safe to expose to callers.
   */
  public constructor(public readonly code: ProviderContextActivationErrorCode) {
    const detail =
      code === 'manager-unavailable'
        ? 'the selected account manager is unavailable'
        : code === 'account-not-found'
          ? 'the selected account no longer exists'
          : 'the selected account could not be activated';
    super(`[activateProviderContext] ${detail}.`);
    this.name = 'ProviderContextActivationError';
  }
}

/** Stable signal that account rollback itself failed after another lifecycle failure. */
export class ProviderContextActivationRollbackError extends Error {
  public constructor() {
    super('Provider context account activation rollback failed.');
    this.name = 'ProviderContextActivationRollbackError';
  }
}

/** Opaque prepared account activation awaiting one terminal decision. */
export interface ProviderContextActivationTransaction {
  /** Commit the prepared account selection exactly once. */
  commit(): Promise<void>;
  /** Roll back the prepared account selection exactly once. */
  rollback(): Promise<void>;
}

/** Bus-backed terminal handle for one prepared account activation. */
class BusProviderContextActivationTransaction implements ProviderContextActivationTransaction {
  private finalization: { readonly action: 'commit' | 'rollback'; readonly promise: Promise<void> } | undefined;

  public constructor(
    private readonly bus: IMakaioBus,
    private readonly transactionId: string,
  ) {}

  /**
   * {@inheritDoc ProviderContextActivationTransaction.commit}
   * @returns Shared commit promise.
   */
  public commit(): Promise<void> {
    return this.finalize('commit');
  }

  /**
   * {@inheritDoc ProviderContextActivationTransaction.rollback}
   * @returns Shared rollback promise.
   */
  public rollback(): Promise<void> {
    return this.finalize('rollback');
  }

  /**
   * Consume the opaque transaction with one stable terminal action.
   * @param action - Terminal decision for this transaction.
   * @returns Shared terminal-action promise.
   */
  private finalize(action: 'commit' | 'rollback'): Promise<void> {
    if (this.finalization !== undefined) {
      if (this.finalization.action !== action) {
        return Promise.reject(new ProviderContextActivationError('activation-failed'));
      }
      return this.finalization.promise;
    }
    const promise = this.requestFinalization(action);
    this.finalization = { action, promise };
    return promise;
  }

  /**
   * Dispatch one local terminal request without retaining manager diagnostics.
   * @param action - Terminal decision dispatched to the manager.
   * @returns Promise that resolves after successful finalization.
   */
  private async requestFinalization(action: 'commit' | 'rollback'): Promise<void> {
    try {
      if (action === 'commit') {
        const result = await this.bus.requestOptional(CredentialSubjects.activation.commit, {
          transactionId: this.transactionId,
        });
        if (!result.handled) {
          throw new ProviderContextActivationError('activation-failed');
        }
        if (!result.data.success) {
          if (result.data.code === 'commit-rollback-failed') {
            throw new ProviderContextActivationRollbackError();
          }
          throw new ProviderContextActivationError('activation-failed');
        }
        return;
      }

      const result = await this.bus.requestOptional(CredentialSubjects.activation.rollback, {
        transactionId: this.transactionId,
      });
      if (!result.handled) {
        throw new ProviderContextActivationError('activation-failed');
      }
      if (!result.data.success) {
        if (result.data.code === 'rollback-failed') {
          throw new ProviderContextActivationRollbackError();
        }
        throw new ProviderContextActivationError('activation-failed');
      }
    } catch (error) {
      if (error instanceof ProviderContextActivationError || error instanceof ProviderContextActivationRollbackError) {
        throw error;
      }
      throw new ProviderContextActivationError('activation-failed');
    }
  }
}

/**
 * Identify a resolved context whose inferred method selects a managed account.
 * @param providerContext - Provider context considered for activation.
 * @returns Resolved context when manager activation is required, otherwise `null`.
 */
function getManagedAccountContext(providerContext: ProviderContext): ResolvedProviderContext | null {
  if (
    providerContext.state !== 'resolved' ||
    providerContext.auth.mode !== 'inferred' ||
    providerContext.auth.account === undefined
  ) {
    return null;
  }
  return providerContext;
}

/**
 * Activate the exact native account selected by a normalized provider context.
 *
 * Explicit, no-auth, unresolved, and inferred-without-selector contexts require
 * no account-manager side effect. A selected account is mandatory, however:
 * missing managers and handler-declared activation failures stop startup rather
 * than falling back to ambient or currently active native state.
 * @param bus - Bus used to invoke the manager-routed activation hook.
 * @param providerContext - Refs-only provider context selected for startup.
 * @throws ProviderContextActivationError when a selected account cannot be activated.
 */
export async function activateProviderContext(bus: IMakaioBus, providerContext: ProviderContext): Promise<void> {
  const managedContext = getManagedAccountContext(providerContext);
  if (!managedContext) {
    return;
  }

  try {
    const result = await bus.requestOptional(CredentialSubjects.activate, { providerContext: managedContext });
    if (!result.handled) {
      throw new ProviderContextActivationError('manager-unavailable');
    }
    if (!result.data.success) {
      throw new ProviderContextActivationError(result.data.code);
    }
  } catch (error) {
    if (error instanceof ProviderContextActivationError) {
      throw error;
    }
    throw new ProviderContextActivationError('activation-failed');
  }
}

/**
 * Prepare a reversible account activation for an atomic connector replacement.
 *
 * Non-managed contexts need no account side effect and return `undefined`.
 * Managed selections require the in-process account manager; the returned
 * handle must be committed or rolled back so its per-client mutation lock is
 * released.
 * @param bus - Bus used to invoke the manager-owned local transaction hook.
 * @param providerContext - Refs-only provider context selected for replacement.
 * @returns Opaque activation transaction, or undefined when no activation is required.
 */
export async function prepareProviderContextActivation(
  bus: IMakaioBus,
  providerContext: ProviderContext,
): Promise<ProviderContextActivationTransaction | undefined> {
  const managedContext = getManagedAccountContext(providerContext);
  if (!managedContext) {
    return undefined;
  }

  try {
    const result = await bus.requestOptional(CredentialSubjects.activation.prepare, {
      providerContext: managedContext,
    });
    if (!result.handled) {
      throw new ProviderContextActivationError('manager-unavailable');
    }
    if (!result.data.success) {
      throw new ProviderContextActivationError(result.data.code);
    }
    return new BusProviderContextActivationTransaction(bus, result.data.transactionId);
  } catch (error) {
    if (error instanceof ProviderContextActivationError) {
      throw error;
    }
    throw new ProviderContextActivationError('activation-failed');
  }
}
