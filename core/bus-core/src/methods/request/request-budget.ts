/**
 * Validation of request time budgets (`timeout`, `readinessTimeout`) where they
 * enter the bus.
 *
 * A budget is a finite number of milliseconds `>= 0`, and `0` alone means "no
 * automatic timeout". Every other value must be stopped at the entry point: a
 * negative or `NaN` budget is not `> 0`, so deadline arithmetic downstream reads
 * it as unbounded, and an infinite one cannot be armed as a timer. Dispatch and
 * transports therefore receive only valid budgets and never re-validate them; a
 * transport that reads a peer's wire budget for its own bookkeeping resolves it
 * with {@link resolveInboundRequestBudget}, so it agrees with the bus.
 */

/**
 * Whether a value is a usable request budget.
 * @param value - Candidate budget
 * @returns `true` for a finite number `>= 0`
 */
function isRequestBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate a budget supplied by a local caller at the public request seam.
 * @param name - Option name reported in the error
 * @param value - Caller-supplied budget
 * @returns The validated budget
 * @throws RangeError When the value is non-finite or negative
 */
export function requireRequestBudget(name: string, value: number): number {
  if (!isRequestBudget(value)) {
    throw new RangeError(`${name} must be a finite number >= 0 (got ${String(value)})`);
  }
  return value;
}

/**
 * Resolve a budget carried by an inbound message from a peer.
 *
 * A peer controls this value, so an unusable budget is dropped in favour of the
 * receiver's default instead of failing or unbounding the request.
 * @param value - Budget carried by the message, if any
 * @returns The budget when usable, otherwise `undefined` to use the default
 */
export function resolveInboundRequestBudget(value: number | undefined): number | undefined {
  return isRequestBudget(value) ? value : undefined;
}
