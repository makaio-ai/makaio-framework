/**
 * Failures of cleanup that ran while another error was already propagating.
 *
 * When a transaction fails and the rollback that follows fails as well, or a
 * handle fails to initialize and releasing its connection fails too, the
 * caller must see the failure that started it all: error classification
 * (unique violations, busy errors) and every `catch` that inspects the error
 * work on the original. The cleanup failure is attached to it instead of
 * replacing it, so neither is lost.
 * @packageDocumentation
 */

/** Property under which cleanup failures travel on the primary error. */
const SECONDARY_FAILURES = 'secondaryFailures';

/**
 * Attach the failure of a cleanup step to the error that triggered the cleanup.
 *
 * The primary error is kept as is (same object, same class, same message). Only
 * thrown values that can carry a property take the attachment; a thrown
 * primitive or a frozen object has nowhere to put it and is passed on bare.
 * @param primary - The error that is propagating.
 * @param failure - The failure of the cleanup step that ran meanwhile.
 * @returns `primary`, for `throw attachSecondaryFailure(error, failure)`.
 */
export function attachSecondaryFailure(primary: unknown, failure: unknown): unknown {
  if (typeof primary !== 'object' || primary === null || !Object.isExtensible(primary)) return primary;
  Object.defineProperty(primary, SECONDARY_FAILURES, {
    value: [...readSecondaryFailures(primary), failure],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return primary;
}

/**
 * Read the cleanup failures attached to an error.
 * @param error - Error that may carry attached cleanup failures.
 * @returns The attached failures in the order they occurred, empty when none.
 */
export function readSecondaryFailures(error: unknown): readonly unknown[] {
  if (typeof error !== 'object' || error === null) return [];
  const failures: unknown = Reflect.get(error, SECONDARY_FAILURES);
  return Array.isArray(failures) ? failures : [];
}
