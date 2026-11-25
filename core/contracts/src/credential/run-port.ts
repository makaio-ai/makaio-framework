import type { CallContext, ExtensionName } from '@makaio/core';
import type { Secret } from './secret.js';

/** A purpose and exact target authorized by the booked order. */
export interface RunCredentialScope {
  readonly purpose: string;
  readonly target: string;
  /** Identifies the booked model purpose without giving its name special meaning. */
  readonly baseEquipment?: 'model';
}

/**
 * Only the run owner's adapter creates this binding, after authenticating and
 * decoding the booked order. The framework cannot verify the origin of its pairs.
 */
export interface RunCredentialBinding {
  /** The original job-run call. Requests must present this same instance. */
  readonly call: CallContext;
  /** Extension on whose behalf the worker resolves credentials. */
  readonly requester: ExtensionName;
  /** Purpose and target pairs from the decoded booking. */
  readonly scopes: readonly RunCredentialScope[];
  /** The owner aborts this signal on run completion, cancellation, or revocation. */
  readonly signal: AbortSignal;
}

/** The result of attempting a credential-mediated operation. */
export type RunCredentialResult<T> =
  | { readonly kind: 'granted'; readonly value: T; readonly isCurrent: () => boolean }
  | { readonly kind: 'purpose-not-granted' };

/** A process-local port for trusted worker code. */
export interface RunCredentialPort {
  /**
   * Select the unique booked model purpose for an exact target.
   * @param target - Configured upstream URL.
   * @returns The matching scope if the run and resolver are still active.
   */
  modelScope(target: string): RunCredentialScope | undefined;

  /**
   * Resolve and immediately start a worker-owned effect with a credential.
   *
   * The effect must start synchronously, observe cancellation, and keep the credential in the worker.
   * @param call - Bound job-run call.
   * @param scope - Exact purpose and target to resolve.
   * @param signal - Cancellation for this request.
   * @param effect - Starts the authorized effect using the in-memory credential.
   * @returns The effect result with a currentness check, or a content-free refusal.
   * Check currentness immediately before consuming the result across an async boundary.
   */
  withCredential<T>(
    call: CallContext,
    scope: RunCredentialScope,
    signal: AbortSignal,
    effect: (credential: Secret, signal: AbortSignal) => Promise<T>,
  ): Promise<RunCredentialResult<T>>;
}
