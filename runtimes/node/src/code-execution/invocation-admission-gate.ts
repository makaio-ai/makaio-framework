// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Bounds how many CodeExecution invocations are in flight at once.
//
// A worker pool only bounds worker threads, and it does so at dispatch time.
// Everything an invocation does before dispatch — materializing its temporary
// program root, building its task payload — is therefore unbounded: a burst of
// concurrent callers creates a temporary root and a queued payload each,
// however small the pool is. This gate moves that bound in front of the whole
// invocation, so resource usage follows the configured concurrency rather than
// the arrival rate.
//
// The waiting queue is bounded for the same reason the concurrency is. A
// waiting invocation still retains its whole request — its sources and its
// arguments — for as long as it waits, and a caller's deadline is its own, so a
// burst of perfectly valid requests with generous deadlines would otherwise
// grow the host's retained memory with the arrival rate rather than with the
// configured concurrency. Past the cap the honest answer is refusal, now,
// rather than a queue position that mostly buys the request a later timeout.

/** Release handle returned to an admitted invocation. */
export type AdmissionRelease = () => void;

/** Why an invocation was not admitted. */
export type AdmissionRefusal =
  /** The invocation's effective signal aborted before a slot was granted. */
  | 'aborted'
  /** Every slot was busy and the waiting queue was already at its cap. */
  | 'queue_full';

/**
 * Outcome of one admission attempt.
 *
 * Spelled as a discriminated union rather than as an optional release handle
 * because the two refusals are not interchangeable: an abort is the caller's
 * own doing and is reported as a cancellation, while a full queue is the
 * provider declining work and is reported as a provider failure. Collapsing
 * both into `undefined` would leave the caller guessing which one it saw.
 */
export type AdmissionResult =
  | { readonly admitted: true; readonly release: AdmissionRelease }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

/** Shared refusal for an invocation whose signal aborted. */
const ABORTED: AdmissionResult = { admitted: false, refusal: 'aborted' };

/** Shared refusal for an invocation that arrived at a full queue. */
const QUEUE_FULL: AdmissionResult = { admitted: false, refusal: 'queue_full' };

/**
 * Abort-aware admission gate bounding concurrent and queued invocations.
 *
 * A waiting invocation whose signal aborts leaves the queue immediately and is
 * reported as not admitted, so the caller can classify it like any other abort
 * instead of holding a slot it will never use.
 */
export class InvocationAdmissionGate {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  /**
   * @param limit - Maximum number of invocations admitted at the same time.
   * @param maxQueued - Maximum number of invocations allowed to wait for a slot.
   *   Zero admits only what fits immediately and refuses the rest.
   */
  public constructor(
    limit: number,
    private readonly maxQueued: number,
  ) {
    this.available = limit;
  }

  /**
   * Wait for an admission slot.
   *
   * A refused invocation is never enqueued, which is the whole point of the
   * cap: the request it carries becomes collectable as soon as the caller has
   * its outcome, instead of being retained behind a queue it would only leave
   * by timing out.
   * @param signal - Effective cancellation signal for the waiting invocation.
   * @returns The granted release handle, or why admission was refused.
   */
  public acquire(signal: AbortSignal): Promise<AdmissionResult> {
    if (signal.aborted) return Promise.resolve(ABORTED);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve({ admitted: true, release: this.createRelease() });
    }
    if (this.waiting.length >= this.maxQueued) return Promise.resolve(QUEUE_FULL);
    return new Promise<AdmissionResult>((resolve) => {
      const admit = (): void => {
        signal.removeEventListener('abort', abandon);
        resolve({ admitted: true, release: this.createRelease() });
      };
      const abandon = (): void => {
        const index = this.waiting.indexOf(admit);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(ABORTED);
      };
      signal.addEventListener('abort', abandon, { once: true });
      this.waiting.push(admit);
    });
  }

  /**
   * Build a release handle that hands the slot on exactly once.
   *
   * The slot is passed straight to the next waiter instead of being returned to
   * the counter, so a queued invocation cannot be overtaken by one that arrives
   * later.
   * @returns Idempotent release handle for one admitted invocation.
   */
  private createRelease(): AdmissionRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.available += 1;
      else next();
    };
  }
}
